import type { Logger } from '@core/logger/logger';
import type { MailMessage, MailerService } from './mailer.types';

/**
 * What runs when no SMTP host is configured. It logs instead of throwing: a project that has
 * not set up email yet must still be able to sign users up, and the log line makes the
 * missing configuration obvious the first time it matters.
 */
export class NoopMailer implements MailerService {
  constructor(private readonly logger: Logger) {}

  send(message: MailMessage): Promise<void> {
    this.logger.warn(
      { to: message.to, subject: message.subject, template: message.template },
      'email not sent: SMTP_HOST is not configured',
    );

    return Promise.resolve();
  }
}
