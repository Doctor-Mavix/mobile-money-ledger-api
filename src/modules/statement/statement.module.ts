import { ConfigurationError } from '@core/errors/app-error';
import type { AppModule } from '@core/module';
import { LEDGER_REPOSITORY } from '@modules/ledger/ledger.repository';
import { WALLET_SERVICE } from '@modules/wallet/wallet.tokens';
import { SHARED_TOKENS } from '@shared/tokens';
import { StatementController } from './statement.controller';
import { StatementService } from './statement.service';
import { STATEMENT_SERVICE } from './statement.tokens';

/**
 * Owns no table. It reads the ledger and renders it, which is the whole reason the ledger is
 * append-only: a statement is only worth printing if the rows behind it cannot have changed
 * since they were posted.
 */
export const statementModule: AppModule = {
  name: 'statement',
  controllers: [StatementController],
  register(registration) {
    const { container } = registration;

    if (!container.isRegistered(LEDGER_REPOSITORY, true)) {
      throw new ConfigurationError(
        'The statement module needs the ledger module — add "ledger" to MODULES_ENABLED.',
      );
    }

    container.registerInstance(
      STATEMENT_SERVICE,
      new StatementService({
        ledger: container.resolve(LEDGER_REPOSITORY),
        wallets: container.resolve(WALLET_SERVICE),
        csv: container.resolve(SHARED_TOKENS.CsvExport),
        pdf: container.resolve(SHARED_TOKENS.PdfExport),
      }),
    );
  },
};
