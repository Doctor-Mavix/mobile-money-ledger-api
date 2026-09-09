import type { Locale } from '@shared/utils-services/i18n.service';

export const NOTIFICATION_CHANNELS = ['in_app', 'email'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

/** Free-form so a module can carry its own ids without the kit knowing about it. */
export type NotificationData = Record<string, string>;

export interface Notification {
  id: string;
  actorId: string;
  type: string;
  title: string;
  body: string;
  data: NotificationData;
  readAt: Date | null;
  createdAt: Date;
}

export interface NotificationRecipient {
  /** Required for the in-app channel: it is the room and the owner of the stored row. */
  actorId?: string;
  email?: string;
}

export interface NotificationRequest {
  recipient: NotificationRecipient;
  locale?: Locale;
  /** Dotted key, also used as the i18n prefix: `auth.verify` → `notification.<type>.*`. */
  type: string;
  title: string;
  body: string;
  data?: NotificationData;
  channels: readonly NotificationChannel[];
  /** Optional call to action rendered in the email. */
  action?: { url: string; label: string };
}
