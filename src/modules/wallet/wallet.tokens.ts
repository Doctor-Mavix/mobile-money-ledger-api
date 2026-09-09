import type { InjectionToken } from 'tsyringe';

import type { WalletService } from './wallet.service';

/**
 * Declared apart from `wallet.service.ts` so the modules that depend on a wallet — transfer,
 * statement — import a symbol and a type, never the implementation.
 */
export const WALLET_SERVICE = Symbol('WalletService') as InjectionToken<WalletService>;
