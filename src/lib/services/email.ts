import {dbService} from '@/lib/db/service';
import {ApiError} from '@/lib/types/errors/api.error';
import {Email, EmailStatus, EmailType} from '@/lib/types/models/email';
import {emailAddressService} from "@/lib/services/email-address";
import {nanoid} from "nanoid";
import {generateEmailSummary} from "@/lib/utils/generateEmailSummary";
import {FilterQuery} from "mongoose";

class EmailService {
  /**
   * Determine the chainId for a new email based on In-Reply-To and References headers
   * @param repliedMessageId The In-Reply-To message ID
   * @param references Array of References message IDs
   * @returns The chainId to use for the new email
   */
  async determineChainId(repliedMessageId?: string, references?: string[]): Promise<string> {
    // Generate a unique chainId for new chains
    const generateChainId = () => nanoid(36);

    // If no reply-to or references, create a new chain
    if (!repliedMessageId && (!references || references.length === 0)) return generateChainId();

    // Try to find parent email by messageId (from In-Reply-To header)
    let parentEmail = null;
    if (repliedMessageId) {
      parentEmail = await dbService.email.findOne({
        messageId: repliedMessageId,
      });
    }

    // If parent email not found by In-Reply-To, try to find by References header
    if (!parentEmail && references && references.length > 0) {
      // Try each reference ID in reverse order (most recent first)
      for (let i = references.length - 1; i >= 0; i--) {
        const referenceId = references[i];
        parentEmail = await dbService.email.findOne({
          messageId: referenceId,
        });
        if (parentEmail) break;
      }
    }

    // If no parent email found, create a new chain
    if (!parentEmail) {
      return generateChainId();
    }

    // Return the chainId from the parent email
    return parentEmail.chainId;
  }

  async createEmail(teamId: string, emailData: Partial<Email>): Promise<Email> {
    if (!emailData.from) throw new ApiError(400, 'From is required');
    if (!emailData.to) throw new ApiError(400, 'To is required');
    if (!emailData.subject) throw new ApiError(400, 'Subject is required');
    if (!emailData.html) throw new ApiError(400, 'Body is required');
    const chainId = await this.determineChainId(emailData.inReplyTo, emailData.references);

    await dbService.email.update(
      {chainId},
      {isLatestInChain: false}
    );

    // Generate a unique message ID if not provided
    const messageId = emailData.messageId || `${Date.now()}.${Math.random().toString(36).substring(2)}@${emailData.from?.split('@')[1] || 'example.com'}`;
    // Create the email with chain information
    return await dbService.email.create({
      ...emailData,
      messageId,
      chainId,
      isLatestInChain: true,
      team: teamId
    } as Email);
  }

  getEmailById(emailId: string) {
    return dbService.email.findById(emailId);
  }

  async getEmailByMessageId(messageId: string) {
    return dbService.email.findOne({
      messageId,
    })
  }

  /**
   * Get latest emails from each chain
   * This is used for displaying a conversation list where only the latest email in each thread is shown
   * Optimized to use the isLatestInChain field and participatedEmails field
   */
  async getConversationsWithLatestEmail(
    teamId: string,
    memberId: string,
    options: {
      page?: number;
      limit?: number;
      labelId?: string;
      search?: string;
      isStarred?: boolean;
      isRead?: boolean;
      status?: EmailStatus;
      emailAddress?: string; // Filter by specific email address
    } = {}
  ) {
    const {
      page = 1,
      limit = 20,
      labelId,
      search,
      isStarred,
      isRead,
      emailAddress
    } = options;
    const memberEmailAddresses = await emailAddressService.getTeamMemberEmailAddresses(teamId, memberId);
    if (!memberEmailAddresses.find(x => x.fullAddress === emailAddress)) throw new ApiError(400, 'FORBIDDEN');

    // Build the filter for finding emails
    const filter: FilterQuery<Email> = {
      team: teamId,
      isLatestInChain: true,
      recipient: emailAddress,
    };

    // Add additional filters if provided
    if (isRead !== undefined) {
      filter.isRead = isRead;
    }

    if (search) filter.$or = [
      {subject: {$regex: search, $options: 'i'}},
      {summary: {$regex: search, $options: 'i'}}
    ];

    // Count total emails for pagination
    const totalDocs = await dbService.email.count(filter);

    // Get latest emails in each chain, sorted by lastMessageAt
    const latestEmails = await dbService.email.find(filter)
      .sort({lastMessageAt: -1})
      .skip((page - 1) * limit)
      .limit(limit);

    // Format the results to maintain backward compatibility
    const results = latestEmails.map(email => {
      return {
        email,
        // Create a minimal conversation object with essential fields
        conversation: {
          _id: email.chainId,
          subject: email.subject,
        }
      };
    });

    // Return in paginated format
    return {
      docs: results,
      totalDocs,
      limit,
      page,
      totalPages: Math.ceil(totalDocs / limit),
      hasNextPage: page * limit < totalDocs,
      hasPrevPage: page > 1,
      pagingCounter: (page - 1) * limit + 1,
      prevPage: page > 1 ? page - 1 : null,
      nextPage: page * limit < totalDocs ? page + 1 : null
    };
  }

  /**
   * Helper method to return an empty paginated result
   */
  private emptyPaginatedResult(page: number, limit: number) {
    return {
      docs: [],
      totalDocs: 0,
      limit,
      page,
      totalPages: 0,
      hasNextPage: false,
      hasPrevPage: false,
      pagingCounter: 0,
      prevPage: null,
      nextPage: null
    };
  }

  /**
   * Get all emails in a chain
   */
  async getChainEmails(chainId: string, emailAddress: string) {
    // Check if the chain exists and the user has access to it
    const chainExists = await dbService.email.exists({
      chainId
    });

    if (!chainExists) throw new ApiError(404, 'CHAIN_NOT_FOUND');

    // Get all emails in the chain, sorted by creation date
    return dbService.email.find({
      chainId,
      recipient: emailAddress,
    }).sort({createdAt: 1});
  }

  async checkMemberChainAccessible(teamId: string, memberId: string, chainId: string) {
    const emailAddresses = await emailAddressService.getTeamMemberEmailAddresses(teamId, memberId);
    const ownedAddresses = emailAddresses.map(addr => addr.fullAddress);
    return dbService.email.exists({
      chainId,
      $or: [{
        recipient: {$in: ownedAddresses},
      }, {
        from: {$in: ownedAddresses},
      }, {
        to: {$in: ownedAddresses},
      }]
    });
  }

  async getConversationById(chainId: string) {
    const firstEmail = await dbService.email.findOne({
      chainId
    }).sort({createdAt: 1}).limit(1);
    if (!firstEmail) throw new ApiError(404, 'Mail conversation not found');
    return {
      chainId,
      subject: firstEmail.subject,
    }
  }
}

export const emailService = new EmailService();
