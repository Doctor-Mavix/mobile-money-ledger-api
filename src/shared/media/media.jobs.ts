import { z } from 'zod';

import { defineJob } from '@shared/queue/job';

export const MEDIA_QUEUE = 'media';

/**
 * Only the id travels: the image itself is already in the bucket, and putting megabytes of
 * payload through Redis would trade a fast queue for a slow one.
 */
export const processImageJob = defineJob(
  MEDIA_QUEUE,
  'process-image',
  z.object({ mediaId: z.uuid() }),
);
