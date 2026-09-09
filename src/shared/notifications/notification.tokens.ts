import type { InjectionToken } from 'tsyringe';

import type { NotificationService } from './notification.service';

/**
 * Declared apart from the service so the controller can inject it without importing the
 * implementation, which would make the two files circular.
 */
export const NOTIFICATION_SERVICE = Symbol(
  'NotificationService',
) as InjectionToken<NotificationService>;
