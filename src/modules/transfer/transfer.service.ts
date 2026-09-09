import { NotFoundError } from '@core/errors/app-error';
import type { CursorPage, CursorQuery } from '@core/database/pagination';
import { InsufficientFundsError } from '@modules/ledger/ledger.errors';
import type { LedgerRepository } from '@modules/ledger/ledger.repository';
import type { Movement, PostedMovement } from '@modules/ledger/ledger.types';
import type { WalletService } from '@modules/wallet/wallet.service';
import type { Wallet } from '@modules/wallet/wallet.types';
import { formatMoney } from '@shared/money/money';
import type { Currency } from '@shared/money/money';
import type { NotificationService } from '@shared/notifications/notification.service';
import type { IdService } from '@shared/utils-services/id.service';
import type { LockService } from '@shared/utils-services/lock.service';
import type { TransferRepository } from './transfer.repository';
import type { CashMovementRequest, Transfer, TransferRequest } from './transfer.types';
import type { StepUpVerifier } from './step-up';

/**
 * Long enough to cover a slow posting transaction, short enough that a crashed instance does
 * not block the same key for a noticeable time. The lock only has to outlive one attempt.
 */
const LOCK_TTL_MS = 15_000;

export interface TransferResult {
  transfer: Transfer;
  /** Absent on a replay: the balances are re-read from the wallet, not from the ledger. */
  posted: PostedMovement | null;
  replayed: boolean;
}

export interface TransferServiceOptions {
  transfers: TransferRepository;
  ledger: LedgerRepository;
  wallets: WalletService;
  stepUp: StepUpVerifier;
  locks: LockService;
  notifications: NotificationService;
  ids: IdService;
}

interface Plan {
  actorId: string;
  sourceWalletId: string;
  targetWalletId: string;
  currency: Currency;
  /** Who to tell about it, and what to call it. */
  notify: { actorId: string; type: string; title: string; body: string } | null;
}

export class TransferService {
  private readonly options: TransferServiceOptions;

  constructor(options: TransferServiceOptions) {
    this.options = options;
  }

  /** Holder to holder. The holder proves MFA and owns the wallet the money leaves. */
  async transfer(request: TransferRequest): Promise<TransferResult> {
    return this.execute(request.actorId, request.idempotencyKey, async () => {
      await this.options.stepUp.verify(request.actorId, request.mfaCode);

      const source = await this.options.wallets.requireOwned(
        request.actorId,
        request.sourceWalletId,
      );
      const target = await this.options.wallets.require(request.targetWalletId);

      return {
        plan: {
          actorId: request.actorId,
          sourceWalletId: source.id,
          targetWalletId: target.id,
          currency: source.currency,
          notify: {
            actorId: target.actorId,
            type: 'transfer.received',
            title: 'Money received',
            body: `You received ${formatMoney(request.amount, source.currency)}.`,
          },
        },
        amount: request.amount,
        reference: request.reference,
      };
    });
  }

  /** Cash in: the house wallet funds the holder's. Performed by a kiosk operator. */
  async cashIn(request: CashMovementRequest): Promise<TransferResult> {
    return this.cashMovement(request, 'in');
  }

  /** Cash out: the holder's wallet returns the money to the house. */
  async cashOut(request: CashMovementRequest): Promise<TransferResult> {
    return this.cashMovement(request, 'out');
  }

  async listForActor(actorId: string, query: CursorQuery): Promise<CursorPage<Transfer>> {
    return this.options.transfers.listForActor(actorId, query);
  }

  /**
   * Visible to whoever initiated it and to the two holders it touched. A transfer someone else
   * made between two wallets you do not hold is a 404, not a 403: the second answer would
   * confirm the id exists.
   */
  async requireVisible(actorId: string, transferId: string): Promise<Transfer> {
    const transfer = await this.options.transfers.findById(transferId);

    if (transfer === null) {
      throw new NotFoundError('This transfer does not exist');
    }

    if (transfer.actorId === actorId) {
      return transfer;
    }

    const owned = await this.options.wallets.listForActor(actorId);
    const ids = new Set(owned.map((wallet) => wallet.id));

    if (ids.has(transfer.sourceWalletId) || ids.has(transfer.targetWalletId)) {
      return transfer;
    }

    throw new NotFoundError('This transfer does not exist');
  }

  private async cashMovement(
    request: CashMovementRequest,
    direction: 'in' | 'out',
  ): Promise<TransferResult> {
    return this.execute(request.operatorId, request.idempotencyKey, async () => {
      await this.options.stepUp.verify(request.operatorId, request.mfaCode);

      const holder = await this.options.wallets.require(request.walletId);
      const house = await this.houseWalletFor(holder);
      const inbound = direction === 'in';

      return {
        plan: {
          actorId: request.operatorId,
          sourceWalletId: inbound ? house.id : holder.id,
          targetWalletId: inbound ? holder.id : house.id,
          currency: holder.currency,
          notify: {
            actorId: holder.actorId,
            type: inbound ? 'wallet.cash_in' : 'wallet.cash_out',
            title: inbound ? 'Deposit received' : 'Withdrawal completed',
            body: `${formatMoney(request.amount, holder.currency)} ${
              inbound ? 'was added to' : 'was withdrawn from'
            } your wallet.`,
          },
        },
        amount: request.amount,
        reference: request.reference,
      };
    });
  }

  private async houseWalletFor(holder: Wallet): Promise<Wallet> {
    return this.options.wallets.ensureHouseWallet(holder.currency);
  }

  /**
   * The shape every money movement shares.
   *
   * The lock is taken on the idempotency key and refused immediately rather than queued: two
   * copies of the same request arriving together is a double-tap or a client retry, and the
   * honest answer is "that one is already running", not a second execution once the first
   * finishes. It is what stops the duplicate; the row lock inside `post` is what stops the
   * overdraft. Neither substitutes for the other.
   */
  private async execute(
    actorId: string,
    idempotencyKey: string,
    prepare: () => Promise<{ plan: Plan; amount: bigint; reference: string | null }>,
  ): Promise<TransferResult> {
    return this.options.locks.withLock(
      `transfer:${actorId}:${idempotencyKey}`,
      { ttlMs: LOCK_TTL_MS },
      async () => {
        const replay = await this.options.transfers.findByIdempotencyKey(actorId, idempotencyKey);

        if (replay !== null) {
          return { transfer: replay, posted: null, replayed: true };
        }

        const { plan, amount, reference } = await prepare();
        const movement: Movement = {
          transferId: this.options.ids.uuid(),
          idempotencyKey,
          actorId: plan.actorId,
          sourceWalletId: plan.sourceWalletId,
          targetWalletId: plan.targetWalletId,
          amount,
          currency: plan.currency,
          reference,
        };

        return this.post(movement, plan);
      },
    );
  }

  private async post(movement: Movement, plan: Plan): Promise<TransferResult> {
    let posted: PostedMovement;

    try {
      posted = await this.options.ledger.post(movement);
    } catch (error) {
      if (error instanceof InsufficientFundsError) {
        // Recorded so the same key returns the same refusal. Trying again after a top-up is a
        // new request and needs a new key — a key that could succeed on its second use would
        // not be an idempotency key.
        await this.options.ledger.recordFailure(movement, 'insufficient_funds');
      }

      throw error;
    }

    const transfer = await this.options.transfers.findById(movement.transferId);

    if (transfer === null) {
      throw new NotFoundError('This transfer does not exist');
    }

    if (plan.notify !== null) {
      await this.options.notifications.notify({
        recipient: { actorId: plan.notify.actorId },
        type: plan.notify.type,
        title: plan.notify.title,
        body: plan.notify.body,
        data: { transferId: transfer.id, amount: movement.amount.toString() },
        channels: ['in_app'],
      });
    }

    return { transfer, posted, replayed: false };
  }
}
