import { ConflictError, ForbiddenError, NotFoundError } from '@core/errors/app-error';
import type { IdService } from '@shared/utils-services/id.service';
import type { Currency } from '@shared/money/money';
import type { WalletRepository } from './wallet.repository';
import type { Wallet, WalletStatus } from './wallet.types';

export interface WalletServiceOptions {
  repository: WalletRepository;
  ids: IdService;
}

export class WalletService {
  private readonly repository: WalletRepository;
  private readonly ids: IdService;

  constructor(options: WalletServiceOptions) {
    this.repository = options.repository;
    this.ids = options.ids;
  }

  async open(actorId: string, currency: Currency): Promise<Wallet> {
    const existing = await this.repository.findByOwner(actorId, currency);

    if (existing !== null) {
      throw new ConflictError(`You already hold a ${currency} wallet`);
    }

    return this.repository.create({ id: this.ids.uuid(), actorId, kind: 'user', currency });
  }

  async listForActor(actorId: string): Promise<Wallet[]> {
    return this.repository.listForActor(actorId);
  }

  /**
   * The only way a route reaches a wallet. A wallet belonging to someone else raises the same
   * 404 as one that does not exist, so the endpoint cannot be walked to discover who banks here.
   */
  async requireOwned(actorId: string, walletId: string): Promise<Wallet> {
    const wallet = await this.repository.findById(walletId);

    if (wallet?.actorId !== actorId) {
      throw new NotFoundError('This wallet does not exist');
    }

    return wallet;
  }

  /** Used by the back office, which is allowed to see a wallet it does not own. */
  async require(walletId: string): Promise<Wallet> {
    const wallet = await this.repository.findById(walletId);

    if (wallet === null) {
      throw new NotFoundError('This wallet does not exist');
    }

    return wallet;
  }

  /**
   * The counterpart of money entering or leaving the platform, opened on first use. Not a route:
   * nobody asks for the house wallet, the cash-in path needs one and takes it.
   */
  async ensureHouseWallet(currency: Currency): Promise<Wallet> {
    return this.repository.ensureSystemWallet(currency);
  }

  async setStatus(walletId: string, status: WalletStatus): Promise<Wallet> {
    const wallet = await this.repository.setStatus(walletId, status);

    if (wallet === null) {
      throw new NotFoundError('This wallet does not exist');
    }

    return wallet;
  }

  /**
   * Read before any movement. A frozen wallet is the answer to a fraud report, so it has to
   * stop money leaving *and* money arriving: a credit onto a frozen wallet would still be a
   * completed cash-in an attacker can point a victim at.
   */
  assertUsable(wallet: Wallet): void {
    if (wallet.status !== 'active') {
      throw new ForbiddenError(`This wallet is ${wallet.status} and cannot be used`);
    }
  }
}
