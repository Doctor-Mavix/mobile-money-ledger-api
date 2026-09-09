import type { Currency } from '@shared/money/money';
import type { LedgerEntry, LedgerIntegrity, WalletIntegrity } from './ledger.types';

export interface LedgerEntryView {
  id: string;
  transferId: string;
  /** Signed minor units as digits: negative debits the wallet, positive credits it. */
  amount: string;
  currency: Currency;
  balanceAfter: string;
  sequence: number;
  createdAt: Date;
}

export function toLedgerEntryView(entry: LedgerEntry): LedgerEntryView {
  return {
    id: entry.id,
    transferId: entry.transferId,
    amount: entry.amount.toString(),
    currency: entry.currency,
    balanceAfter: entry.balanceAfter.toString(),
    sequence: entry.sequence,
    createdAt: entry.createdAt,
  };
}

export interface WalletIntegrityView extends Omit<
  WalletIntegrity,
  'storedBalance' | 'replayedBalance'
> {
  storedBalance: string;
  replayedBalance: string;
}

export interface LedgerIntegrityView extends Omit<LedgerIntegrity, 'wallets' | 'globalSum'> {
  wallets: WalletIntegrityView[];
  globalSum: string;
}

export function toLedgerIntegrityView(integrity: LedgerIntegrity): LedgerIntegrityView {
  return {
    ...integrity,
    globalSum: integrity.globalSum.toString(),
    wallets: integrity.wallets.map((wallet) => ({
      ...wallet,
      storedBalance: wallet.storedBalance.toString(),
      replayedBalance: wallet.replayedBalance.toString(),
    })),
  };
}
