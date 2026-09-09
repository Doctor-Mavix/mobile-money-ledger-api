import type { Currency } from '@shared/money/money';

export const TRANSFER_STATUSES = ['completed', 'failed'] as const;

export type TransferStatus = (typeof TRANSFER_STATUSES)[number];

export interface Transfer {
  id: string;
  idempotencyKey: string;
  actorId: string;
  sourceWalletId: string;
  targetWalletId: string;
  amount: bigint;
  currency: Currency;
  status: TransferStatus;
  reference: string | null;
  failureReason: string | null;
  createdAt: Date;
}

/** What a holder sends to move money to someone else. */
export interface TransferRequest {
  actorId: string;
  idempotencyKey: string;
  sourceWalletId: string;
  targetWalletId: string;
  amount: bigint;
  mfaCode: string;
  reference: string | null;
}

/**
 * Money entering or leaving the platform, performed by a kiosk operator on a holder's wallet —
 * the cash-in and cash-out every mobile-money network runs on. The counterpart is the house
 * wallet, so the ledger stays closed.
 */
export interface CashMovementRequest {
  /** The operator, who is the one being held accountable and the one proving MFA. */
  operatorId: string;
  idempotencyKey: string;
  walletId: string;
  amount: bigint;
  mfaCode: string;
  reference: string | null;
}
