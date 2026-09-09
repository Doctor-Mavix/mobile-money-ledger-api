import type { AppModule } from '@core/module';
import { notificationModule } from '@shared/notifications/notification.module';
import { authModule } from './auth/auth.module';
import { healthModule } from './health/health.module';
import { ledgerModule } from './ledger/ledger.module';
import { statementModule } from './statement/statement.module';
import { transferModule } from './transfer/transfer.module';
import { walletModule } from './wallet/wallet.module';

/** Registration order matters: a module resolves the tokens the earlier ones registered. */
export const APP_MODULES: readonly AppModule[] = [
  healthModule,
  notificationModule,
  authModule,
  walletModule,
  ledgerModule,
  transferModule,
  statementModule,
];
