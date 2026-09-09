import { sqlClientOf } from '@core/database';
import { ConfigurationError } from '@core/errors/app-error';
import type { AppModule } from '@core/module';
import { WALLET_SERVICE } from '@modules/wallet/wallet.tokens';
import { LEDGER_REPOSITORY } from './ledger.repository';
import { LedgerController } from './ledger.controller';
import { PrismaLedgerRepository } from './sql/ledger.prisma.repository';

/**
 * Owns the append-only entries *and* the transaction that posts them. Putting the write here
 * rather than in the transfer module is deliberate: the invariant being protected is
 * "a balance only ever moves together with the entry that explains it", and that invariant
 * belongs to whoever owns the entries.
 *
 * The consequence is worth stating plainly: wallet, ledger and transfer are three modules but
 * one extraction unit. Splitting them across services would replace this transaction with a
 * saga, and a saga cannot promise that two simultaneous transfers never overdraw an account.
 */
export const ledgerModule: AppModule = {
  name: 'ledger',
  controllers: [LedgerController],
  register(registration) {
    const { container } = registration;

    if (!container.isRegistered(WALLET_SERVICE, true)) {
      throw new ConfigurationError(
        'The ledger module needs the wallet module — add "wallet" to MODULES_ENABLED.',
      );
    }

    container.registerInstance(
      LEDGER_REPOSITORY,
      new PrismaLedgerRepository(sqlClientOf(registration.adapter)),
    );
  },
};
