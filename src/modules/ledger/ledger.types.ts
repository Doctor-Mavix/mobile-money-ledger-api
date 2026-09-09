import type { Currency } from '@shared/money/money';

/**
 * One side of one movement. Written inside the transaction that moved the money, then never
 * touched again — the database refuses UPDATE and DELETE on this table, see the `money`
 * migration.
 */
export interface LedgerEntry {
  id: string;
  transferId: string;
  walletId: string;
  /** Signed minor units: negative debits this wallet, positive credits it. */
  amount: bigint;
  currency: Currency;
  /** The balance this wallet held once this entry was applied. */
  balanceAfter: bigint;
  /** Per wallet, gapless, starting at 1. */
  sequence: number;
  createdAt: Date;
}

/**
 * An entry carrying the label the payer wrote on the movement. Used only on the statement path:
 * a reference column showing a UUID answers nothing, and "what did I pay on the 12th" is the
 * question a statement exists for.
 */
export interface StatementEntry extends LedgerEntry {
  reference: string | null;
}

/**
 * What a caller asks the ledger to post. The amount is positive and the direction comes from
 * which wallet is named as the source, so a caller cannot express "credit both sides".
 */
export interface Movement {
  transferId: string;
  idempotencyKey: string;
  /** Whoever initiated it: the holder for a transfer, the kiosk operator for a cash movement. */
  actorId: string;
  sourceWalletId: string;
  targetWalletId: string;
  amount: bigint;
  currency: Currency;
  reference: string | null;
}

export interface PostedMovement {
  transferId: string;
  sourceBalance: bigint;
  targetBalance: bigint;
  entries: LedgerEntry[];
}

/**
 * What the ledger says about one wallet after re-reading every entry it holds. `balanceMatches`
 * is the question the whole table exists to answer.
 */
export interface WalletIntegrity {
  walletId: string;
  entries: number;
  /** The wallet's own `balance` column. */
  storedBalance: bigint;
  /** The sum of every entry ever posted to that wallet. */
  replayedBalance: bigint;
  balanceMatches: boolean;
  /** Every `balanceAfter` equals the running total up to that entry. */
  runningBalanceMatches: boolean;
  /** Sequences are 1..n with no gap and no repeat. */
  sequenceIntact: boolean;
}

export interface LedgerIntegrity {
  wallets: WalletIntegrity[];
  /** Every movement's legs sum to zero, so the sum over every entry in the table does too. */
  globalSum: bigint;
  /** Movements whose two legs do not cancel out. Always empty, or the ledger is broken. */
  unbalancedTransferIds: string[];
  consistent: boolean;
}
