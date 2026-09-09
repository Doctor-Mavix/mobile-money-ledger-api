import type { InjectionToken } from 'tsyringe';

import type { Currency } from '@shared/money/money';
import type { Wallet, WalletKind, WalletStatus } from './wallet.types';

export interface NewWallet {
  id: string;
  actorId: string;
  kind: WalletKind;
  currency: Currency;
}

export interface WalletRepository {
  create(data: NewWallet): Promise<Wallet>;
  findById(id: string): Promise<Wallet | null>;
  findByOwner(actorId: string, currency: Currency): Promise<Wallet | null>;
  listForActor(actorId: string): Promise<Wallet[]>;
  setStatus(id: string, status: WalletStatus): Promise<Wallet | null>;
  /**
   * Returns the house wallet for a currency, opening it on first use. Concurrent callers race
   * on the `(actor_id, currency)` unique index and the loser reads the winner's row, so there
   * is never a second counterpart.
   */
  ensureSystemWallet(currency: Currency): Promise<Wallet>;
}

export const WALLET_REPOSITORY = Symbol('WalletRepository') as InjectionToken<WalletRepository>;
