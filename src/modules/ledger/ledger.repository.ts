import type { InjectionToken } from 'tsyringe';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import type {
  LedgerEntry,
  LedgerIntegrity,
  Movement,
  PostedMovement,
  StatementEntry,
} from './ledger.types';

export interface StatementRange {
  from: Date;
  to: Date;
}

export interface LedgerRepository {
  /**
   * The one write path for money. Locks both wallets, refuses an overdraft, updates the two
   * balances, records the transfer and appends both entries — all in one transaction, so a
   * crash halfway through leaves neither a moved balance nor an orphan entry.
   */
  post(movement: Movement): Promise<PostedMovement>;

  /**
   * Records a movement that was refused, in its own transaction, so replaying the same
   * idempotency key returns the same refusal instead of trying again.
   */
  recordFailure(movement: Movement, reason: string): Promise<void>;

  listForWallet(walletId: string, query: CursorQuery): Promise<CursorPage<LedgerEntry>>;

  /** Streams a period in ascending order for the statement, one page of memory at a time. */
  streamRange(walletId: string, range: StatementRange): AsyncIterable<StatementEntry>;

  /** Re-reads the ledger and checks it against the balances it is supposed to explain. */
  verify(walletIds?: readonly string[]): Promise<LedgerIntegrity>;
}

export const LEDGER_REPOSITORY = Symbol('LedgerRepository') as InjectionToken<LedgerRepository>;
