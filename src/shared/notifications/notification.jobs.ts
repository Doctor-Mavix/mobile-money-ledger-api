import { z } from 'zod';

import { LOCALES } from '@shared/utils-services/i18n.service';
import { defineJob } from '@shared/queue/job';

export const NOTIFICATION_QUEUE = 'notifications';

export const sendEmailJob = defineJob(
  NOTIFICATION_QUEUE,
  'send-email',
  z.object({
    to: z.email(),
    subject: z.string().min(1),
    template: z.string().min(1),
    // The locale travels with the job: the worker renders the layout, so it must know which
    // catalogue to greet and sign with.
    locale: z.enum(LOCALES),
    context: z.record(z.string(), z.unknown()).default({}),
  }),
);
