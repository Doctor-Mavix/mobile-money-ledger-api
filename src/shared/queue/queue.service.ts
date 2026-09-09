import type { ConnectionOptions, JobsOptions } from 'bullmq';
import { Queue, Worker } from 'bullmq';

import type { Logger } from '@core/logger/logger';
import type { JobHandler, JobType } from './job';

export interface QueueServiceOptions {
  redisUrl: string;
  prefix: string;
  concurrency: number;
  attempts: number;
  logger: Logger;
  /** False runs jobs inline, in the calling process. Useful in tests and single-process dev. */
  enabled: boolean;
}

export interface EnqueueOptions {
  delayMs?: number;
  attempts?: number;
  /** Two jobs enqueued with the same id collapse into one — deduplication, not a retry. */
  jobId?: string;
}

/**
 * BullMQ owns its connections rather than reusing the application's: workers issue blocking
 * commands and require `maxRetriesPerRequest: null`, which is the opposite of what the request
 * path wants. It also namespaces itself with `prefix`, so ioredis' `keyPrefix` must stay off
 * here — BullMQ builds its keys itself and a double prefix silently splits a queue in two.
 */
function connectionFromUrl(redisUrl: string): ConnectionOptions {
  const url = new URL(redisUrl);
  const database = url.pathname.slice(1);

  return {
    host: url.hostname,
    port: Number(url.port === '' ? 6379 : url.port),
    ...(url.username === '' ? {} : { username: url.username }),
    ...(url.password === '' ? {} : { password: url.password }),
    ...(database === '' ? {} : { db: Number(database) }),
    ...(url.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

const handlerKey = (queue: string, name: string): string => `${queue}:${name}`;

interface RegisteredJob {
  job: JobType<never>;
  handler: JobHandler<never>;
}

/**
 * Background work, so a request never waits on an email, a resize or an export. Handlers are
 * registered at boot and executed either by a BullMQ worker or inline, which keeps the calling
 * code identical whether or not the deployment runs a separate worker process.
 */
export class QueueService {
  private readonly queues = new Map<string, Queue>();
  private readonly handlers = new Map<string, RegisteredJob>();
  private readonly workers: Worker[] = [];

  constructor(private readonly options: QueueServiceOptions) {}

  register<TPayload>(job: JobType<TPayload>, handler: JobHandler<TPayload>): void {
    this.handlers.set(handlerKey(job.queue, job.name), {
      // The map holds jobs of every payload shape at once, so it is typed at the only payload
      // they have in common. `register` is the single place that erases the parameter; every
      // read goes back through the job's own type.
      job: job as JobType<never>,
      handler,
    });
  }

  async enqueue<TPayload>(
    job: JobType<TPayload>,
    payload: TPayload,
    options: EnqueueOptions = {},
  ): Promise<void> {
    if (!this.options.enabled) {
      await this.runInline(job, payload);
      return;
    }

    const jobOptions: JobsOptions = {
      attempts: options.attempts ?? this.options.attempts,
      backoff: { type: 'exponential', delay: 1_000 },
      // Completed jobs are kept only long enough to be inspected: an unbounded history is a
      // Redis memory leak that shows up weeks after the deploy that caused it.
      removeOnComplete: { age: 3_600, count: 1_000 },
      removeOnFail: { age: 7 * 24 * 3_600 },
      ...(options.delayMs === undefined ? {} : { delay: options.delayMs }),
      ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    };

    await this.queueFor(job.queue).add(job.name, payload, jobOptions);
  }

  /** Starts one worker per queue that has at least one handler registered. */
  startWorkers(): void {
    if (!this.options.enabled) {
      return;
    }

    const queueNames = new Set(
      [...this.handlers.keys()].map((key) => key.slice(0, key.indexOf(':'))),
    );

    for (const queueName of queueNames) {
      const worker = new Worker(
        queueName,
        async (job) => {
          const registered = this.handlers.get(handlerKey(queueName, job.name));

          if (registered === undefined) {
            // A job whose handler this build does not know must fail loudly and be retried by
            // a newer build, never be quietly dropped.
            throw new Error(`No handler registered for job "${queueName}:${job.name}"`);
          }

          await registered.handler(registered.job.schema.parse(job.data), {
            attempt: job.attemptsMade + 1,
            jobId: job.id ?? 'unknown',
          });
        },
        {
          connection: connectionFromUrl(this.options.redisUrl),
          prefix: this.options.prefix,
          concurrency: this.options.concurrency,
        },
      );

      worker.on('failed', (job, error) => {
        this.options.logger.error(
          { err: error, queue: queueName, job: job?.name, attempt: job?.attemptsMade },
          'job failed',
        );
      });

      worker.on('error', (error: unknown) => {
        this.options.logger.error({ err: error, queue: queueName }, 'worker error');
      });

      this.workers.push(worker);
    }

    this.options.logger.info({ queues: [...queueNames] }, 'workers started');
  }

  async close(): Promise<void> {
    await Promise.all(this.workers.map((worker) => worker.close()));
    await Promise.all([...this.queues.values()].map((queue) => queue.close()));
  }

  private queueFor(name: string): Queue {
    const existing = this.queues.get(name);

    if (existing !== undefined) {
      return existing;
    }

    const queue = new Queue(name, {
      connection: connectionFromUrl(this.options.redisUrl),
      prefix: this.options.prefix,
    });

    this.queues.set(name, queue);

    return queue;
  }

  private async runInline<TPayload>(job: JobType<TPayload>, payload: TPayload): Promise<void> {
    const registered = this.handlers.get(handlerKey(job.queue, job.name));

    if (registered === undefined) {
      throw new Error(`No handler registered for job "${job.queue}:${job.name}"`);
    }

    try {
      // Inline mode must not turn a background failure into a failed request: the caller
      // asked for the job to be scheduled, and scheduling succeeded.
      await registered.handler(job.schema.parse(payload) as never, {
        attempt: 1,
        jobId: 'inline',
      });
    } catch (error) {
      this.options.logger.error({ err: error, job: job.name }, 'inline job failed');
    }
  }
}
