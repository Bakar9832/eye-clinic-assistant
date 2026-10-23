import { Injectable, Logger } from '@nestjs/common';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** One interface for sending email. Real delivery (SMTP) arrives in Slice 6. */
export abstract class EmailSender {
  abstract send(email: Email): Promise<void>;
}

/** Development only: prints the email to the API log instead of sending it. */
@Injectable()
export class ConsoleEmailSender extends EmailSender {
  private readonly logger = new Logger('Email');

  async send(email: Email) {
    this.logger.log(`To ${email.to} | ${email.subject}\n${email.text}`);
  }
}
