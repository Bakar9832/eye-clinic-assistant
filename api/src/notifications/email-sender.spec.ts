import { ConsoleEmailSender, SmtpEmailSender, emailSenderFromEnv } from './email-sender.js';

describe('choosing the email sender from .env', () => {
  it('no SMTP_HOST: the console, as in development', () => {
    expect(emailSenderFromEnv({})).toBeInstanceOf(ConsoleEmailSender);
  });

  it('SMTP_HOST set (e.g. Mailpit on localhost:1025): SMTP', () => {
    expect(emailSenderFromEnv({ SMTP_HOST: 'localhost', SMTP_PORT: '1025' })).toBeInstanceOf(SmtpEmailSender);
  });

  it('SMTP sends from EMAIL_FROM, as plain text', async () => {
    const sendMail = vi.fn().mockResolvedValue({});
    const sender = new SmtpEmailSender({ sendMail }, 'Demo Eye Clinic <clinic@example.com>');

    await sender.send({ to: 'test.two@example.com', subject: 'Hi', text: 'Body' });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'Demo Eye Clinic <clinic@example.com>',
      to: 'test.two@example.com',
      subject: 'Hi',
      text: 'Body',
    });
  });
});
