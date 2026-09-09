import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';

import type { Logger } from '@core/logger/logger';
import type { MailMessage, MailerService } from './mailer.types';
import { TemplateRenderer, htmlToText } from './template.renderer';

export interface SmtpMailerOptions {
  host: string;
  port: number;
  secure: boolean;
  user: string;
  password: string;
  from: string;
  templateDirectory: string;
  cacheTemplates: boolean;
  logger: Logger;
}

export class SmtpMailer implements MailerService {
  private readonly transporter: Transporter;
  private readonly renderer: TemplateRenderer;

  constructor(private readonly options: SmtpMailerOptions) {
    this.transporter = nodemailer.createTransport({
      host: options.host,
      port: options.port,
      secure: options.secure,
      // Mailpit and MailHog accept anonymous connections; sending empty credentials would be
      // rejected as a failed login attempt.
      ...(options.user === '' ? {} : { auth: { user: options.user, pass: options.password } }),
    });

    this.renderer = new TemplateRenderer(options.templateDirectory, options.cacheTemplates);
  }

  async send(message: MailMessage): Promise<void> {
    const html = this.renderer.render(message.template, {
      subject: message.subject,
      ...message.context,
    });

    await this.transporter.sendMail({
      from: this.options.from,
      to: message.to,
      subject: message.subject,
      html,
      text: htmlToText(html),
      ...(message.replyTo === undefined ? {} : { replyTo: message.replyTo }),
      ...(message.attachments === undefined ? {} : { attachments: [...message.attachments] }),
    });

    this.options.logger.debug({ to: message.to, template: message.template }, 'email sent');
  }
}
