import type { Currency } from '@shared/money/money';
import type { Wallet, WalletKind, WalletStatus } from './wallet.types';

export interface WalletView {
  id: string;
  kind: WalletKind;
  currency: Currency;
  /** Minor units as digits. See `@shared/money/money` for why this is not a JSON number. */
  balance: string;
  status: WalletStatus;
  createdAt: Date;
}

export function toWalletView(wallet: Wallet): WalletView {
  return {
    id: wallet.id,
    kind: wallet.kind,
    currency: wallet.currency,
    balance: wallet.balance.toString(),
    status: wallet.status,
    createdAt: wallet.createdAt,
  };
}
