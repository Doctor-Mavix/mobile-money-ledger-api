import type { InjectionToken } from 'tsyringe';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import type { Transfer } from './transfer.types';

export interface TransferRepository {
  findById(id: string): Promise<Transfer | null>;
  /** The idempotency lookup. Scoped to the caller, exactly as the unique index is. */
  findByIdempotencyKey(actorId: string, key: string): Promise<Transfer | null>;
  /** Everything the actor initiated, newest first. */
  listForActor(actorId: string, query: CursorQuery): Promise<CursorPage<Transfer>>;
}

export const TRANSFER_REPOSITORY = Symbol(
  'TransferRepository',
) as InjectionToken<TransferRepository>;
