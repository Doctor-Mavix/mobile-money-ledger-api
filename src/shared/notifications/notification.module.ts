import { env } from '@core/config/env';
import { TOKENS } from '@core/container/tokens';
import { sqlClientOf } from '@core/database';
import type { AppModule, ModuleRegistration } from '@core/module';
import { SHARED_TOKENS } from '@shared/tokens';
import { NotificationController } from './notification.controller';
import { sendEmailJob } from './notification.jobs';
import { NOTIFICATION_REPOSITORY } from './notification.repository';
import type { NotificationRepository } from './notification.repository';
import { NotificationService } from './notification.service';
import { NOTIFICATION_SERVICE } from './notification.tokens';
import { PrismaNotificationRepository } from './sql/notification.prisma.repository';

function createRepository(registration: ModuleRegistration): NotificationRepository {
  return new PrismaNotificationRepository(sqlClientOf(registration.adapter));
}

/**
 * Part of the kit, but mounted like any other module: it owns a table, routes and a job
 * handler, so it registers itself rather than being hand-wired into the bootstrap.
 */
export const notificationModule: AppModule = {
  name: 'notification',
  controllers: [NotificationController],
  register(registration) {
    const { container } = registration;
    const repository = createRepository(registration);
    const queue = container.resolve(SHARED_TOKENS.Queue);
    const mailer = container.resolve(SHARED_TOKENS.Mailer);

    container.registerInstance(NOTIFICATION_REPOSITORY, repository);
    container.registerInstance(
      NOTIFICATION_SERVICE,
      new NotificationService({
        repository,
        realtime: container.resolve(SHARED_TOKENS.Realtime),
        queue,
        ids: container.resolve(SHARED_TOKENS.Id),
        logger: container.resolve(TOKENS.Logger),
        appName: env.APP_NAME,
      }),
    );

    const i18n = container.resolve(SHARED_TOKENS.I18n);

    queue.register(sendEmailJob, async (payload) => {
      await mailer.send({
        to: payload.to,
        subject: payload.subject,
        template: payload.template,
        context: {
          ...payload.context,
          locale: payload.locale,
          greeting: i18n.translate('email.greeting', {}, payload.locale),
          signature: i18n.translate('email.signature', { appName: env.APP_NAME }, payload.locale),
          footer: i18n.translate('email.footer', {}, payload.locale),
        },
      });
    });
  },
};
