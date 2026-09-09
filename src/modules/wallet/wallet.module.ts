import { sqlClientOf } from '@core/database';
import type { AppModule } from '@core/module';
import { SHARED_TOKENS } from '@shared/tokens';
import { WALLET_REPOSITORY } from './wallet.repository';
import { WalletController } from './wallet.controller';
import { WalletService } from './wallet.service';
import { WALLET_SERVICE } from './wallet.tokens';
import { PrismaWalletRepository } from './sql/wallet.prisma.repository';

/**
 * Owns the wallets table and the lifecycle of a wallet. It deliberately owns no way to change a
 * balance: the only code allowed to do that is the posting transaction in the transfer module,
 * which writes the ledger in the same breath. A wallet with its own `credit()` would be a
 * balance that can move without leaving a trace.
 */
export const walletModule: AppModule = {
  name: 'wallet',
  controllers: [WalletController],
  register(registration) {
    const { container } = registration;
    const repository = new PrismaWalletRepository(sqlClientOf(registration.adapter));

    container.registerInstance(WALLET_REPOSITORY, repository);
    container.registerInstance(
      WALLET_SERVICE,
      new WalletService({ repository, ids: container.resolve(SHARED_TOKENS.Id) }),
    );
  },
};
