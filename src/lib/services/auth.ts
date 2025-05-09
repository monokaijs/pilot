import {dbService} from '@/lib/db/service';
import {ApiError} from '@/lib/types/errors/api.error';
import {User, UserRole} from '@/lib/types/models/user';
import {HydratedDocument} from 'mongoose';
import {comparePassword, hashPassword} from '@/lib/utils/passwordUtils';
import {QuerySsoUser, RegistrationFormSchema} from "@/lib/validations/auth";
import {PasswordChangeSchema} from "@/lib/validations/user";
import generateUserToken from "@/lib/utils/generateUserToken";
import {NextResponse} from "next/server";

class AuthService {
  async authenticate(data: any) {
    const {identifier, password, issuer} = data;
    const dbUser = await dbService.user.findOne({
      $or: [{email: identifier?.toLowerCase()}, {phoneNumber: identifier?.toLowerCase()}],
    }).select('+password').lean();

    if (!dbUser) throw new ApiError(401, 'Invalid email or password');
    const {password: userPwd, ...user} = dbUser;
    if (!await comparePassword(password, userPwd)) throw new ApiError(401, 'Invalid email or password');
    return user as unknown as HydratedDocument<User>;
  }

  async getUserBySSO(query: QuerySsoUser) {
    const existingUser = await dbService.user.findOne({...query});

    if (existingUser) {
      return existingUser;
    } else {
      throw new ApiError(400, 'Account does not exist');
    }

  }


  async login(user: User, issuer: 'mobile' | 'web') {
    const token = await generateUserToken(user);
    if (issuer === 'mobile') {
      return {
        token,
        user,
      };
    } else {
      const response = NextResponse.json({
        data: {user},
        message: 'Login successful',
      });
      response.cookies.set('next-auth.session-token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        path: '/',
      });
      return response;
    }
  }

  async register(data: RegistrationFormSchema & {role?: UserRole}) {
    // Check if user with this email already exists
    const existingUser = await dbService.user.findOne({ email: data.email.toLowerCase() });
    if (existingUser) {
      throw new ApiError(400, 'Email already in use');
    }

    // Hash the password
    const hashedPassword = await hashPassword(data.password);

    // Create the user
    const user = await dbService.user.create({
      fullName: data.fullName,
      email: data.email.toLowerCase(),
      password: hashedPassword,
      role: data.role ?? UserRole.User,
      emailVerified: false,
    });

    // Remove password from the returned user object
    const { password, ...userWithoutPassword } = user;

    return userWithoutPassword as unknown as User;
  }

  async changePassword(userId: string, data: PasswordChangeSchema) {
    const user = await dbService.user.findById(userId).select('+password');

    if (!user) {
      throw new ApiError(404, 'User not found');
    }

    const isCurrentPasswordValid = await comparePassword(data.currentPassword, user.password);
    if (!isCurrentPasswordValid) {
      throw new ApiError(400, 'Current password is incorrect');
    }

    if (data.currentPassword === data.newPassword) {
      throw new ApiError(400, 'New password must be different from current password');
    }

    const hashedPassword = await hashPassword(data.newPassword);

    user.password = hashedPassword;
    await user.save();

    return { success: true, message: 'Password changed successfully' };
  }
}

export const authService = new AuthService();
