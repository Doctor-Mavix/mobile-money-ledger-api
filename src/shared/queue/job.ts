import type { ZodType } from 'zod';

/**
 * A job payload is written by one process and read by another, possibly running an older
 * build. That is a system boundary, so the schema travels with the job and every payload is
 * parsed on the way out of Redis rather than trusted.
 */
export interface JobType<TPayload> {
  readonly queue: string;
  readonly name: string;
  readonly schema: ZodType<TPayload>;
}

export interface JobContext {
  readonly attempt: number;
  readonly jobId: string;
}

export type JobHandler<TPayload> = (payload: TPayload, context: JobContext) => Promise<void>;

export function defineJob<TPayload>(
  queue: string,
  name: string,
  schema: ZodType<TPayload>,
): JobType<TPayload> {
  return { queue, name, schema };
}
