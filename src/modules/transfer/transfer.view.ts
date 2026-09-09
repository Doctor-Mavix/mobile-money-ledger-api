import type { Currency } from '@shared/money/money';
import type { TransferResult } from './transfer.service';
import type { Transfer, TransferStatus } from './transfer.types';

export interface TransferView {
  id: string;
  sourceWalletId: string;
  targetWalletId: string;
  /** Minor units as digits, always positive: the direction is the pair of wallet ids. */
  amount: string;
  currency: Currency;
  status: TransferStatus;
  reference: string | null;
  failureReason: string | null;
  createdAt: Date;
}

export function toTransferView(transfer: Transfer): TransferView {
  return {
    id: transfer.id,
    sourceWalletId: transfer.sourceWalletId,
    targetWalletId: transfer.targetWalletId,
    amount: transfer.amount.toString(),
    currency: transfer.currency,
    status: transfer.status,
    reference: transfer.reference,
    failureReason: transfer.failureReason,
    createdAt: transfer.createdAt,
  };
}

export interface TransferResultView extends TransferView {
  /**
   * The balances as of this movement, so a client does not have to re-read the wallet to redraw
   * the screen. Null on a replay: the answer is the transfer that already happened, and the
   * balance since then is not this movement's business.
   */
  sourceBalance: string | null;
  targetBalance: string | null;
  /** True when this request had already been executed under the same idempotency key. */
  replayed: boolean;
}

export function toTransferResultView(result: TransferResult): TransferResultView {
  return {
    ...toTransferView(result.transfer),
    sourceBalance: result.posted?.sourceBalance.toString() ?? null,
    targetBalance: result.posted?.targetBalance.toString() ?? null,
    replayed: result.replayed,
  };
}
