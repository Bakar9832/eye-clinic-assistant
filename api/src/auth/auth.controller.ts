import { Body, Controller, HttpCode, HttpStatus, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { LoginDto, RequestCodeDto, SetPasswordDto } from './auth.dto.js';
import { AuthService, type NewSession } from './auth.service.js';
import { SESSION_COOKIE } from './session.guard.js';
import { ClientIp } from '../http/client-ip.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-code')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(@Body() body: RequestCodeDto, @ClientIp() ip: string) {
    await this.auth.requestCode(body.email, ip);
    return { message: 'If that address can receive email, a code is on its way.' };
  }

  /** Sign-up or forgot password: the emailed code, then the new password. Logs in. */
  @Post('set-password')
  @HttpCode(HttpStatus.OK)
  async setPassword(@Body() body: SetPasswordDto, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    setSessionCookie(res, await this.auth.setPassword(body.email, body.code, body.password, ip, body));
    return { loggedIn: true };
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(@Body() body: LoginDto, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    setSessionCookie(res, await this.auth.login(body.email, body.password, ip, 'PATIENT'));
    return { loggedIn: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @ClientIp() ip: string, @Res({ passthrough: true }) res: Response) {
    await this.auth.logout(req.cookies?.[SESSION_COOKIE], ip);
    res.clearCookie(SESSION_COOKIE, { path: '/' });
  }
}

function setSessionCookie(res: Response, session: NewSession) {
  res.cookie(SESSION_COOKIE, session.token, {
    httpOnly: true, // page scripts can't read it, so an XSS bug can't steal it
    sameSite: 'lax', // not sent with cross-site form posts
    secure: process.env.NODE_ENV === 'production', // HTTPS only outside local development
    path: '/',
    expires: session.expiresAt,
  });
}
