import type { Logger } from '@core/logger/logger';

export interface SmsMessage {
  /** E.164, as produced by PhoneService — never a locally formatted number. */
  to: string;
  body: string;
}

/**
 * Providers differ per country and change often on the African market, so the template ships
 * the contract and a logging provider; adding Twilio or a local aggregator is one class.
 */
export interface SmsService {
  send(message: SmsMessage): Promise<void>;
}

export class LogSmsService implements SmsService {
  constructor(private readonly logger: Logger) {}

  send(message: SmsMessage): Promise<void> {
    this.logger.info(
      { to: message.to, body: message.body },
      'sms not sent: no provider configured',
    );

    return Promise.resolve();
  }
}
