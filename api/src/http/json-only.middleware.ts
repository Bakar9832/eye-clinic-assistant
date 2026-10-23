import { HttpStatus, Injectable, NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

const CHANGES_STATE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * CSRF protection. A malicious site can make a browser submit an HTML form to us with
 * the session cookie attached, but a form can't send Content-Type: application/json,
 * and a cross-site fetch() that tries is blocked by the browser unless we allow it
 * (we don't). So every request that changes something must be JSON.
 */
@Injectable()
export class JsonOnlyMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    if (CHANGES_STATE.has(req.method) && !(req.headers['content-type'] ?? '').startsWith('application/json')) {
      res.status(HttpStatus.UNSUPPORTED_MEDIA_TYPE).json({
        error: 'JSON_REQUIRED',
        reasons: [{ code: 'JSON_REQUIRED', message: 'Send this request as application/json.' }],
      });
      return;
    }
    next();
  }
}
