import { Body, Controller, HttpCode, HttpStatus, Ip, Post, Req, Res } from '@nestjs/common';
import { Transform } from 'class-transformer';
import { IsEmail, Matches, MaxLength } from 'class-validator';
import type { Request, Response } from 'express';
import { AuthService, type NewSession } from './auth.service.js';
import { SESSION_COOKIE } from './session.guard.js';

// Pasted emails often carry spaces; trim before the format check.
const trim = ({ value }: { value: unknown }) => (typeof value === 'string' ? value.trim() : value);

class RequestCodeDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;
}

class VerifyDto {
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  email!: string;

  @Matches(/^\d{6}$/, { message: 'code must be 6 digits' })
  code!: string;
}

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('request-code')
  @HttpCode(HttpStatus.ACCEPTED)
  async requestCode(@Body() body: RequestCodeDto, @Ip() ip: string) {
    await this.auth.requestCode(body.email, ip);
    return { message: 'If that address can receive email, a code is on its way.' };
  }

  @Post('verify')
  @HttpCode(HttpStatus.OK)
  async verify(@Body() body: VerifyDto, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    setSessionCookie(res, await this.auth.verify(body.email, body.code, ip));
    return { loggedIn: true };
  }

  @Post('demo')
  @HttpCode(HttpStatus.OK)
  async demo(@Ip() ip: string, @Res({ passthrough: true }) res: Response) {
    setSessionCookie(res, await this.auth.demoLogin(ip));
    return { loggedIn: true };
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  async logout(@Req() req: Request, @Ip() ip: string, @Res({ passthrough: true }) res: Response) {
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
