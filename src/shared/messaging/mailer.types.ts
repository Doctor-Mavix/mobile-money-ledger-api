export interface MailAttachment {
  filename: string;
  content: Buffer;
  contentType?: string;
}

export interface MailMessage {
  to: string;
  subject: string;
  /** Template file name without extension, resolved inside the mail template directory. */
  template: string;
  context?: Record<string, unknown>;
  attachments?: readonly MailAttachment[];
  replyTo?: string;
}

/**
 * One interface, three lives: SMTP in production, Mailpit in development, a no-op when no host
 * is configured. Swapping in a transactional provider is a new class, not a change in callers.
 */
export interface MailerService {
  send(message: MailMessage): Promise<void>;
}
