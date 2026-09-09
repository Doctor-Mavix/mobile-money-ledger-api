import type { Currency } from '@shared/money/money';

export const WALLET_STATUSES = ['active', 'frozen', 'closed'] as const;

export type WalletStatus = (typeof WALLET_STATUSES)[number];

export const WALLET_KINDS = ['user', 'system'] as const;

export type WalletKind = (typeof WALLET_KINDS)[number];

/**
 * The `actorId` every house wallet is filed under. A sentinel rather than a nullable column:
 * `NULL` is distinct from `NULL` in a Postgres unique index, so a nullable owner would let two
 * house wallets exist for the same currency and split the counterpart in half.
 */
export const SYSTEM_ACTOR_ID = 'system';

export interface Wallet {
  id: string;
  actorId: string;
  kind: WalletKind;
  currency: Currency;
  /** Minor units. Negative only on a system wallet, where it measures money in circulation. */
  balance: bigint;
  status: WalletStatus;
  createdAt: Date;
  updatedAt: Date;
}
