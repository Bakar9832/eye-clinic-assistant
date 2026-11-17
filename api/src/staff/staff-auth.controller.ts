import { Body, Controller, Get, HttpCode, HttpStatus, Ip, Post, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequestCodeDto, VerifyDto } from '../auth/auth.dto.js';
import { AuthService } from '../auth/auth.service.js';
import { PrismaClient } from '../generated/prisma/client.js';
import { CurrentStaff, STAFF_COOKIE, StaffGuard, type StaffActor } from './staff.guard.js';

/** The staff door: same email-code flow as patients, separate codes, cookie and sessions. */
@Controller('staff')
export class StaffAuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly prisma: PrismaClient,
  ) {}

  @Post('auth/request-code')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(@Body() body: RequestCodeDto, @Ip() ip: string) {
    await this.auth.requestCode(body.email, ip, 'STAFF');
    return { message: 'If that address can receive email, a code is on its way.' };
  }

  @Post('auth/verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: VerifyDto, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    const session = await this.auth.verify(body.email, body.code, ip, 'STAFF');
    res.cookie(STAFF_COOKIE, session.token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.NODE_ENV === 'production',
      path: '/staff', // never sent to patient routes
      expires: session.expiresAt,
    });
    return { loggedIn: true };
  }

  @Post('auth/logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[STAFF_COOKIE], ip);
    res.clearCookie(STAFF_COOKIE, { path: '/staff' });
  }

  @Get('me')
  @UseGuards(StaffGuard)
  async me(@CurrentStaff() staff: StaffActor) {
    const user = await this.prisma.staffUser.findUniqueOrThrow({ where: { id: staff.id } });
    return { id: user.id, email: user.email, displayName: user.displayName, role: user.role };
  }
}
