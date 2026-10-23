import { Injectable } from '@nestjs/common';

/** "Now", injectable, so tests can move time forward instead of waiting. */
export abstract class Clock {
  abstract now(): Date;
}

@Injectable()
export class SystemClock extends Clock {
  now() {
    return new Date();
  }
}
