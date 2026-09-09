import type { DependencyContainer } from 'tsyringe';

import { env, isProduction } from '@core/config/env';
import { TOKENS } from '@core/container/tokens';
import { sqlClientOf } from '@core/database';
import type { Logger } from '@core/logger/logger';
import { CsvExportService } from './documents/csv-export.service';
import { ExcelExportService } from './documents/excel-export.service';
import { PdfExportService } from './documents/pdf-export.service';
import { processImageJob } from './media/media.jobs';
import { MediaService } from './media/media.service';
import { UnconfiguredStorage } from './media/noop.storage';
import { S3Storage } from './media/s3.storage';
import { PrismaMediaRepository } from './media/sql/media.prisma.repository';
import type { ObjectStorage } from './media/storage.types';
import { NoopMailer } from './messaging/noop.mailer';
import { SmtpMailer } from './messaging/smtp.mailer';
import { LogSmsService } from './messaging/sms.types';
import { QueueService } from './queue/queue.service';
import { NoopRealtimeGateway } from './realtime/noop.gateway';
import { SocketIoGateway } from './realtime/socketio.gateway';
import type { RealtimeGateway } from './realtime/realtime.types';
import { SHARED_TOKENS } from './tokens';
import { CacheService } from './utils-services/cache.service';
import { HttpClientService } from './utils-services/http-client.service';
import { I18nService } from './utils-services/i18n.service';
import { IdService } from './utils-services/id.service';
import { LockService } from './utils-services/lock.service';
import { OtpService } from './utils-services/otp.service';
import { PhoneService } from './utils-services/phone.service';
import { QrCodeService } from './utils-services/qrcode.service';
import { SlugService } from './utils-services/slug.service';
import { TokenService } from './utils-services/token.service';
import type { MailerService } from './messaging/mailer.types';

const MAIL_TEMPLATE_DIRECTORY = 'templates/email';

/**
 * Wired by hand rather than by `@injectable()`: the bundler does not emit decorator metadata,
 * and several kit services take a plain options object no container could resolve. Explicit
 * construction also puts every "which implementation, and why" decision in one readable place.
 *
 * Must run after the Redis connection is registered and before modules register.
 */
export function registerSharedServices(container: DependencyContainer): void {
  const redis = container.resolve(TOKENS.Redis);
  const logger = container.resolve(TOKENS.Logger);

  container.registerInstance(SHARED_TOKENS.Cache, new CacheService(redis));
  container.registerInstance(SHARED_TOKENS.Lock, new LockService(redis));
  container.registerInstance(SHARED_TOKENS.Otp, new OtpService(redis));
  container.registerInstance(SHARED_TOKENS.OpaqueToken, new TokenService(redis));
  container.registerInstance(SHARED_TOKENS.Id, new IdService());
  container.registerInstance(SHARED_TOKENS.Slug, new SlugService());
  container.registerInstance(SHARED_TOKENS.Phone, new PhoneService());
  container.registerInstance(SHARED_TOKENS.QrCode, new QrCodeService());
  container.registerInstance(SHARED_TOKENS.HttpClient, new HttpClientService());
  container.registerInstance(SHARED_TOKENS.I18n, new I18nService());
  container.registerInstance(SHARED_TOKENS.Sms, new LogSmsService(logger));
  container.registerInstance(SHARED_TOKENS.CsvExport, new CsvExportService());
  container.registerInstance(SHARED_TOKENS.ExcelExport, new ExcelExportService());
  container.registerInstance(SHARED_TOKENS.PdfExport, new PdfExportService());

  container.registerInstance(
    SHARED_TOKENS.Queue,
    new QueueService({
      redisUrl: env.REDIS_URL,
      prefix: env.QUEUE_PREFIX,
      concurrency: env.QUEUE_CONCURRENCY,
      attempts: env.QUEUE_ATTEMPTS,
      enabled: env.QUEUE_ENABLED,
      logger,
    }),
  );

  container.registerInstance(SHARED_TOKENS.Mailer, createMailer(logger));
  container.registerInstance(SHARED_TOKENS.Realtime, createRealtimeGateway(container));
  registerMedia(container);
}

/**
 * Media owns a table and a job handler but no routes of its own: it is always reached through
 * the module that owns the file, so it is wired here rather than mounted as a module.
 */
function registerMedia(container: DependencyContainer): void {
  const adapter = container.resolve(TOKENS.DatabaseAdapter);
  const storage = createStorage();
  const queue = container.resolve(SHARED_TOKENS.Queue);

  const media = new MediaService({
    repository: new PrismaMediaRepository(sqlClientOf(adapter)),
    storage,
    queue,
    realtime: container.resolve(SHARED_TOKENS.Realtime),
    ids: container.resolve(SHARED_TOKENS.Id),
    logger: container.resolve(TOKENS.Logger),
    maxUploadBytes: env.MEDIA_MAX_UPLOAD_BYTES,
    urlExpirySeconds: env.S3_URL_EXPIRY_SECONDS,
  });

  container.registerInstance(SHARED_TOKENS.Storage, storage);
  container.registerInstance(SHARED_TOKENS.Media, media);

  queue.register(processImageJob, async (payload) => {
    await media.processImage(payload.mediaId);
  });
}

function createStorage(): ObjectStorage {
  return env.S3_ENDPOINT === ''
    ? new UnconfiguredStorage()
    : new S3Storage({
        endpoint: env.S3_ENDPOINT,
        region: env.S3_REGION,
        bucket: env.S3_BUCKET,
        accessKey: env.S3_ACCESS_KEY,
        secretKey: env.S3_SECRET_KEY,
        forcePathStyle: env.S3_FORCE_PATH_STYLE,
      });
}

function createMailer(logger: Logger): MailerService {
  return env.SMTP_HOST === ''
    ? new NoopMailer(logger)
    : new SmtpMailer({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: env.SMTP_SECURE,
        user: env.SMTP_USER,
        password: env.SMTP_PASSWORD,
        from: env.MAIL_FROM,
        templateDirectory: MAIL_TEMPLATE_DIRECTORY,
        // Reading a template from disk on every send is what makes editing one take effect
        // without a restart; in production the file never changes, so it is cached.
        cacheTemplates: isProduction,
        logger,
      });
}

function createRealtimeGateway(container: DependencyContainer): RealtimeGateway {
  if (!env.REALTIME_ENABLED) {
    return new NoopRealtimeGateway();
  }

  return new SocketIoGateway({
    redis: container.resolve(TOKENS.Redis),
    logger: container.resolve(TOKENS.Logger),
    path: env.REALTIME_PATH,
    corsOrigins: env.CORS_ORIGINS,
    isProduction,
    authenticator: () =>
      container.isRegistered(SHARED_TOKENS.SocketAuthenticator, true)
        ? container.resolve(SHARED_TOKENS.SocketAuthenticator)
        : undefined,
  });
}

export { SHARED_TOKENS };
