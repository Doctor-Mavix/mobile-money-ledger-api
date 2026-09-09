import type { InjectionToken } from 'tsyringe';

import { sqlClientOf } from '@core/database';
import { ConfigurationError } from '@core/errors/app-error';
import type { AppModule } from '@core/module';
import { AUTH_REPOSITORY } from '@modules/auth/auth.repository';
import { MfaService } from '@modules/auth/mfa.service';
import { LEDGER_REPOSITORY } from '@modules/ledger/ledger.repository';
import { WALLET_SERVICE } from '@modules/wallet/wallet.tokens';
import { NOTIFICATION_SERVICE } from '@shared/notifications/notification.tokens';
import { SHARED_TOKENS } from '@shared/tokens';
import { MfaStepUpVerifier } from './step-up';
import { TRANSFER_REPOSITORY } from './transfer.repository';
import { TransferController } from './transfer.controller';
import { TransferService } from './transfer.service';
import { TRANSFER_SERVICE } from './transfer.tokens';
import { PrismaTransferRepository } from './sql/transfer.prisma.repository';

/** Typed as `unknown` so the four differently-typed tokens can share one presence check. */
const REQUIRED: readonly { token: InjectionToken<unknown>; module: string }[] = [
  { token: WALLET_SERVICE, module: 'wallet' },
  { token: LEDGER_REPOSITORY, module: 'ledger' },
  { token: AUTH_REPOSITORY, module: 'auth' },
  { token: NOTIFICATION_SERVICE, module: 'notification' },
];

/**
 * Decides whether money may move; the ledger module decides how. Everything specific to this
 * module is policy — who owns the wallet, whether the two-factor code is valid, whether this
 * idempotency key has been seen — and none of it touches a balance directly.
 */
export const transferModule: AppModule = {
  name: 'transfer',
  controllers: [TransferController],
  register(registration) {
    const { container } = registration;

    for (const dependency of REQUIRED) {
      if (!container.isRegistered(dependency.token, true)) {
        throw new ConfigurationError(
          `The transfer module needs the ${dependency.module} module — ` +
            `add "${dependency.module}" to MODULES_ENABLED.`,
        );
      }
    }

    const repository = new PrismaTransferRepository(sqlClientOf(registration.adapter));

    container.registerInstance(TRANSFER_REPOSITORY, repository);
    container.registerInstance(
      TRANSFER_SERVICE,
      new TransferService({
        transfers: repository,
        ledger: container.resolve(LEDGER_REPOSITORY),
        wallets: container.resolve(WALLET_SERVICE),
        stepUp: new MfaStepUpVerifier(
          container.resolve(AUTH_REPOSITORY),
          container.resolve(MfaService),
        ),
        locks: container.resolve(SHARED_TOKENS.Lock),
        notifications: container.resolve(NOTIFICATION_SERVICE),
        ids: container.resolve(SHARED_TOKENS.Id),
      }),
    );
  },
};
