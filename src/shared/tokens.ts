import type { InjectionToken } from 'tsyringe';

import type { CsvExportService } from './documents/csv-export.service';
import type { ExcelExportService } from './documents/excel-export.service';
import type { PdfExportService } from './documents/pdf-export.service';
import type { MediaService } from './media/media.service';
import type { ObjectStorage } from './media/storage.types';
import type { MailerService } from './messaging/mailer.types';
import type { SmsService } from './messaging/sms.types';
import type { QueueService } from './queue/queue.service';
import type { RealtimeGateway, SocketAuthenticator } from './realtime/realtime.types';
import type { CacheService } from './utils-services/cache.service';
import type { HttpClientService } from './utils-services/http-client.service';
import type { I18nService } from './utils-services/i18n.service';
import type { IdService } from './utils-services/id.service';
import type { LockService } from './utils-services/lock.service';
import type { OtpService } from './utils-services/otp.service';
import type { PhoneService } from './utils-services/phone.service';
import type { QrCodeService } from './utils-services/qrcode.service';
import type { SlugService } from './utils-services/slug.service';
import type { TokenService } from './utils-services/token.service';

/**
 * Kit services are resolved by token like everything else, so a module never imports a
 * concrete implementation and stays extractable into its own service.
 */
export const SHARED_TOKENS = {
  Cache: Symbol('CacheService') as InjectionToken<CacheService>,
  Lock: Symbol('LockService') as InjectionToken<LockService>,
  Otp: Symbol('OtpService') as InjectionToken<OtpService>,
  OpaqueToken: Symbol('TokenService') as InjectionToken<TokenService>,
  Id: Symbol('IdService') as InjectionToken<IdService>,
  Slug: Symbol('SlugService') as InjectionToken<SlugService>,
  Phone: Symbol('PhoneService') as InjectionToken<PhoneService>,
  QrCode: Symbol('QrCodeService') as InjectionToken<QrCodeService>,
  HttpClient: Symbol('HttpClientService') as InjectionToken<HttpClientService>,
  I18n: Symbol('I18nService') as InjectionToken<I18nService>,
  Queue: Symbol('QueueService') as InjectionToken<QueueService>,
  Mailer: Symbol('MailerService') as InjectionToken<MailerService>,
  Sms: Symbol('SmsService') as InjectionToken<SmsService>,
  Realtime: Symbol('RealtimeGateway') as InjectionToken<RealtimeGateway>,
  SocketAuthenticator: Symbol('SocketAuthenticator') as InjectionToken<SocketAuthenticator>,
  Storage: Symbol('ObjectStorage') as InjectionToken<ObjectStorage>,
  Media: Symbol('MediaService') as InjectionToken<MediaService>,
  CsvExport: Symbol('CsvExportService') as InjectionToken<CsvExportService>,
  ExcelExport: Symbol('ExcelExportService') as InjectionToken<ExcelExportService>,
  PdfExport: Symbol('PdfExportService') as InjectionToken<PdfExportService>,
} as const;
