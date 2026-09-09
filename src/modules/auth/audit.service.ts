import { randomUUID } from 'node:crypto';

import { z } from 'zod';

import type { Logger } from '@core/logger/logger';
import { defineJob } from '@shared/queue/job';
import type { QueueService } from '@shared/queue/queue.service';
import type { AuthRepository } from './auth.repository';
import { AUTH_EVENTS } from './auth.types';
import type { AuditEntry } from './auth.types';

const auditPayloadSchema = z.object({
  id: z.uuid(),
  actorId: z.string().nullable(),
  actorType: z.string(),
  event: z.enum(AUTH_EVENTS),
  ip: z.string().nullable(),
  userAgent: z.string().nullable(),
  requestId: z.string().nullable(),
  metadata: z.record(z.string(), z.string()),
});

export const recordAuditJob = defineJob('auth', 'record-audit', auditPayloadSchema);

/**
 * The security log is written through the queue, so a slow or unavailable database never adds
 * latency to a login — and never fails one either. The trade is that an entry can land a
 * moment after the response; for an audit trail that is the right side of the trade.
 */
export class AuditService {
  constructor(
    private readonly queue: QueueService,
    private readonly logger: Logger,
  ) {}

  async record(entry: AuditEntry): Promise<void> {
    try {
      await this.queue.enqueue(recordAuditJob, { ...entry, id: randomUUID() });
    } catch (error) {
      // Losing the audit entry must not lose the login it describes. It is logged instead,
      // so the event still exists somewhere an operator can find it.
      this.logger.error({ err: error, event: entry.event }, 'could not queue an audit entry');
    }
  }
}

export function registerAuditJob(queue: QueueService, repository: AuthRepository): void {
  queue.register(recordAuditJob, async (entry) => {
    await repository.recordAudit(entry);
  });
}
