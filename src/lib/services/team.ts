import {dbService} from '@/lib/db/service';
import {ApiError} from '@/lib/types/errors/api.error';
import {TeamRole} from '@/lib/types/models/team';
import {UserRole} from '@/lib/types/models/user';
import {AddTeamMemberSchema, CreateTeamSchema, UpdateTeamMemberSchema, UpdateTeamSchema} from '@/lib/validations/team';
import {PaginateOptions} from 'mongoose';
import {slugify} from '@/lib/utils/slugify';
import {ObjectId} from "mongodb";

class TeamService {
  /**
   * Get all teams with pagination
   */
  getTeams(pagination: PaginateOptions) {
    return dbService.team.paginate({}, pagination);
  }

  getJoinedTeamMemberships(userId: string, pagination: PaginateOptions) {
    return dbService.teamMember.paginate({
      user: userId,
    }, {
      ...pagination,
      populate: ['team']
    });
  }

  /**
   * Get a team by ID
   */
  getTeam(teamId: string) {
    return dbService.team.findById(teamId);
  }

  /**
   * Get a team by slug
   */
  getTeamBySlug(slug: string) {
    return dbService.team.findOne({slug});
  }

  /**
   * Get a team by slug with the current user's membership
   */
  async getTeamWithMembership(slugOrId: string, userId: string) {
    const isObjectId = ObjectId.isValid(slugOrId);
    const team = await dbService.team.findOne(!isObjectId ? {
      slug: slugOrId
    } : {
      _id: slugOrId
    });

    if (!team) throw new ApiError(404, 'Team not found');

    // Get the user's membership in this team
    const membership = await dbService.teamMember.findOne({
      team: team._id,
      user: userId
    });

    if (!membership) throw new ApiError(400, 'You are not a member of this team');

    return {
      team,
      membership
    };
  }

  /**
   * Check if a slug is available
   */
  async isSlugAvailable(slug: string): Promise<boolean> {
    const existingTeam = await dbService.team.findOne({slug});
    return !existingTeam;
  }

  /**
   * Create a new team
   */
  async createTeam(data: CreateTeamSchema) {
    // Generate slug from name if not provided
    let slug = data.slug;
    if (!slug) {
      slug = slugify(data.name);
    }

    // Check if slug is available
    const isAvailable = await this.isSlugAvailable(slug);
    if (!isAvailable) {
      // Try to find a unique slug by appending numbers
      let counter = 1;
      let newSlug = `${slug}-${counter}`;

      while (!(await this.isSlugAvailable(newSlug))) {
        counter++;
        newSlug = `${slug}-${counter}`;

        // Prevent infinite loops
        if (counter > 100) {
          throw new ApiError(400, 'Could not generate a unique slug. Please provide a different team name.');
        }
      }

      slug = newSlug;
    }

    // Create the team
    return await dbService.team.create({
      name: data.name,
      slug,
      description: data.description || '',
      avatar: data.avatar || '',
      membersCount: 1,
      tasksCount: 0,
    });
  }

  /**
   * Update a team
   */
  async updateTeam(teamId: string, data: UpdateTeamSchema, userId: string) {
    // Check if team exists
    const team = await dbService.team.findById(teamId);
    if (!team) {
      throw new ApiError(404, 'Team not found');
    }

    // Get the user to check if they're an admin
    const user = await dbService.user.findById(userId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Check if user is an admin or an owner of the team
    const isAdmin = user.role === UserRole.Admin;
    const isOwner = await dbService.teamMember.findOne({
      team: teamId,
      user: userId,
      role: TeamRole.Owner,
    });

    if (!isAdmin && !isOwner) {
      throw new ApiError(403, 'Only admins or team owners can update a team');
    }

    // If slug is being updated, check if it's available
    if (data.slug && data.slug !== team.slug) {
      const isAvailable = await this.isSlugAvailable(data.slug);
      if (!isAvailable) {
        throw new ApiError(400, 'This slug is already in use. Please choose a different one.');
      }
    }

    // Update the team
    return dbService.team.findOneAndUpdate(
      {_id: teamId},
      {$set: data},
      {new: true}
    );
  }

  /**
   * Delete a team
   */
  async deleteTeam(teamId: string, userId: string) {
    // Check if team exists
    const team = await dbService.team.findById(teamId);
    if (!team) {
      throw new ApiError(404, 'Team not found');
    }

    // Get the user to check if they're an admin
    const user = await dbService.user.findById(userId);
    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    // Check if user is an admin or an owner of the team
    const isAdmin = user.role === UserRole.Admin;
    const isOwner = await dbService.teamMember.findOne({
      team: teamId,
      user: userId,
      role: TeamRole.Owner,
    });

    if (!isAdmin && !isOwner) {
      throw new ApiError(403, 'Only admins or team owners can delete a team');
    }

    // Delete all team members
    await dbService.teamMember.delete({team: teamId});

    // Delete the team
    return dbService.team.deleteOne({_id: teamId});
  }

  /**
   * Get team members
   */
  getTeamMembers(teamId: string, pagination: PaginateOptions) {
    return dbService.teamMember.paginate({team: teamId}, {
      ...pagination,
      populate: 'user',
    });
  }

  async inviteTeamMember(teamId: string, data: AddTeamMemberSchema) {
    const user = await dbService.user.findOne({
      email: data.userId,
    })
    if (!user) throw new ApiError(404, 'User not found');
    // Check if user is already a member
    const existingMember = await dbService.teamMember.findOne({
      team: teamId,
      user: user._id,
    });

    if (existingMember) {
      throw new ApiError(400, 'User is already a member of this team');
    }

    return this.addTeamMember(teamId, user._id.toString(), data.role);
  }

  /**
   * Add a member to a team
   */
  async addTeamMember(teamId: string, userId: string, role: TeamRole = TeamRole.Member) {
    // Check if team exists
    const team = await teamService.getTeam(teamId);
    if (!team) throw new ApiError(404, 'TEAM_NOT_FOUND');
    const user = await dbService.user.findById(userId);
    if (!user) throw new ApiError(404, 'USER_NOT_FOUND');

    // Add the member
    const newMember = await dbService.teamMember.create({
      displayName: user.fullName,
      role,
      user: userId,
      team: teamId,
    });

    // Update the team's member count
    await dbService.team.findOneAndUpdate(
      {_id: teamId},
      {$inc: {membersCount: 1}}
    );

    return newMember;
  }

  /**
   * Update a team member
   */
  async updateTeamMember(teamId: string, memberId: string, data: UpdateTeamMemberSchema, userId: string) {
    // Check if team exists
    const team = await dbService.team.findById(teamId);
    if (!team) {
      throw new ApiError(404, 'Team not found');
    }

    // Check if user is an owner or manager of the team
    const member = await dbService.teamMember.findOne({
      team: teamId,
      user: userId,
      role: {$in: [TeamRole.Owner, TeamRole.Manager]},
    });

    if (!member) {
      throw new ApiError(403, 'You do not have permission to update members in this team');
    }

    // Check if member to be updated exists
    const memberToUpdate = await dbService.teamMember.findById(memberId);
    if (!memberToUpdate) {
      throw new ApiError(404, 'Team member not found');
    }

    // If trying to update role
    if (data.role) {
      // Only owners can change roles
      if (member.role !== TeamRole.Owner) {
        throw new ApiError(403, 'Only team owners can change member roles');
      }

      // Prevent changing the role of an owner
      if (memberToUpdate.role === TeamRole.Owner && data.role !== TeamRole.Owner) {
        throw new ApiError(403, 'Cannot change the role of a team owner');
      }
    }

    // Update the member
    return dbService.teamMember.findOneAndUpdate(
      {_id: memberId},
      {$set: data},
      {new: true}
    );
  }

  /**
   * Remove a member from a team
   */
  async removeTeamMember(teamId: string, memberId: string, userId: string) {
    // Check if team exists
    const team = await dbService.team.findById(teamId);
    if (!team) {
      throw new ApiError(404, 'Team not found');
    }

    // Check if user is an owner or manager of the team
    const member = await dbService.teamMember.findOne({
      team: teamId,
      user: userId,
      role: {$in: [TeamRole.Owner, TeamRole.Manager]},
    });

    if (!member) {
      throw new ApiError(403, 'You do not have permission to remove members from this team');
    }

    // Check if member to be removed exists
    const memberToRemove = await dbService.teamMember.findById(memberId);
    if (!memberToRemove) {
      throw new ApiError(404, 'Team member not found');
    }

    // Prevent removing an owner (only owners can remove owners)
    if (memberToRemove.role === TeamRole.Owner) {
      // If the user is not an owner, they can't remove an owner
      if (member.role !== TeamRole.Owner) {
        throw new ApiError(403, 'Only team owners can remove other owners');
      }

      // Count how many owners the team has
      const ownersCount = await dbService.teamMember.count({
        team: teamId,
        role: TeamRole.Owner
      });

      // Prevent removing the last owner
      if (ownersCount <= 1) {
        throw new ApiError(403, 'Cannot remove the last owner of a team');
      }
    }

    // Remove the member
    await dbService.teamMember.deleteOne({_id: memberId});

    // Update the team's member count
    await dbService.team.findOneAndUpdate(
      {_id: teamId},
      {$inc: {membersCount: -1}}
    );

    return {success: true};
  }

  /**
   * Get user's teams
   */
  async getUserTeams(userId: string, pagination: PaginateOptions) {
    // Get all team memberships for the user
    const memberships = await dbService.teamMember.find({user: userId});

    // Get the team IDs
    const teamIds = memberships.map(m => m.team);

    // Get the teams
    return dbService.team.paginate(
      {_id: {$in: teamIds}},
      pagination
    );
  }
}

export const teamService = new TeamService();
