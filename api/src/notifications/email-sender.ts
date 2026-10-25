import { Injectable, Logger } from '@nestjs/common';
import nodemailer, { type Transporter } from 'nodemailer';

export interface Email {
  to: string;
  subject: string;
  text: string;
}

/** One interface for sending email. Which one is used is decided by .env (see emailSenderFromEnv). */
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

/**
 * Any SMTP server: Mailpit on this PC during development (catches everything, sends
 * nothing), a real provider later. Switching is a .env change.
 */
export class SmtpEmailSender extends EmailSender {
  constructor(
    private readonly transport: Pick<Transporter, 'sendMail'>,
    private readonly from: string,
  ) {
    super();
  }

  async send(email: Email) {
    await this.transport.sendMail({ from: this.from, to: email.to, subject: email.subject, text: email.text });
  }
}

/** SMTP when SMTP_HOST is set, otherwise the console. */
export function emailSenderFromEnv(env: NodeJS.ProcessEnv = process.env): EmailSender {
  if (!env.SMTP_HOST) return new ConsoleEmailSender();
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    // true = TLS from the first byte (port 465). Mailpit and port 587 use false.
    secure: env.SMTP_SECURE === 'true',
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
  });
  return new SmtpEmailSender(transport, env.EMAIL_FROM || 'Eye Clinic <no-reply@clinic.example>');
}
