import { v7 as uuidv7 } from 'uuid';

import type { LedgerEntry as LedgerEntryRow, Prisma } from '@prisma-client';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import { buildCursorPage } from '@core/database/pagination';
import type { SqlClient } from '@core/database/sql/prisma.adapter';
import { ConflictError, ForbiddenError, NotFoundError } from '@core/errors/app-error';
import type { Currency } from '@shared/money/money';
import { InsufficientFundsError } from '../ledger.errors';
import type { LedgerRepository, StatementRange } from '../ledger.repository';
import type {
  LedgerEntry,
  LedgerIntegrity,
  Movement,
  PostedMovement,
  StatementEntry,
  WalletIntegrity,
} from '../ledger.types';

/** How many rows a statement pulls per round trip. Bounded memory, whatever the period. */
const STREAM_BATCH = 500;

interface LockedWalletRow {
  id: string;
  currency: string;
  balance: bigint;
  status: string;
  kind: string;
}

function toEntry(row: LedgerEntryRow): LedgerEntry {
  return {
    id: row.id,
    transferId: row.transferId,
    walletId: row.walletId,
    amount: row.amount,
    currency: row.currency as Currency,
    balanceAfter: row.balanceAfter,
    sequence: row.sequence,
    createdAt: row.createdAt,
  };
}

function cursorWhere(query: CursorQuery): Prisma.LedgerEntryWhereInput | undefined {
  if (query.cursor === null) {
    return undefined;
  }

  const createdAt = new Date(query.cursor.value);
  const ascending = query.direction === 'asc';

  return {
    OR: [
      { createdAt: ascending ? { gt: createdAt } : { lt: createdAt } },
      { createdAt, id: ascending ? { gt: query.cursor.id } : { lt: query.cursor.id } },
    ],
  };
}

export class PrismaLedgerRepository implements LedgerRepository {
  constructor(private readonly client: SqlClient) {}

  /**
   * Every guarantee this project makes about money lives in this method.
   *
   * `SELECT ... FOR UPDATE` is what makes two simultaneous transfers safe. Without it both
   * requests read the same balance, both conclude there is enough, and both write — the second
   * write silently erases the first and the wallet ends up overdrawn. With it, the second
   * request blocks on the row until the first commits, then re-reads a balance that already
   * includes the first movement.
   *
   * The two wallets are locked in a fixed order (by id). Two transfers in opposite directions
   * between the same pair would otherwise each hold the row the other is waiting for, and
   * Postgres would resolve it by killing one of them as a deadlock.
   *
   * The sequence numbers are read inside the same lock, which is what makes them gapless: a
   * concurrent poster to either wallet cannot be between the read and the insert.
   */
  async post(movement: Movement): Promise<PostedMovement> {
    // Checked here rather than only in the caller: a movement onto itself would lock one row,
    // read the same balance twice and post two entries that cancel out — a free way to inflate
    // someone's statement, and the one shape the `FOR UPDATE` below cannot protect against.
    if (movement.sourceWalletId === movement.targetWalletId) {
      throw new ConflictError('A wallet cannot transfer to itself');
    }

    return this.client.$transaction(async (tx) => {
      const [first, second] = [movement.sourceWalletId, movement.targetWalletId].sort();

      const locked = await tx.$queryRaw<LockedWalletRow[]>`
        SELECT "id", "currency", "balance", "status", "kind"
        FROM "wallets"
        WHERE "id" IN (${first}, ${second})
        ORDER BY "id"
        FOR UPDATE
      `;

      const source = locked.find((row) => row.id === movement.sourceWalletId);
      const target = locked.find((row) => row.id === movement.targetWalletId);

      if (source === undefined || target === undefined) {
        throw new NotFoundError('This wallet does not exist');
      }

      for (const wallet of [source, target]) {
        if (wallet.status !== 'active') {
          throw new ForbiddenError(`A wallet involved in this movement is ${wallet.status}`);
        }

        if (wallet.currency !== movement.currency) {
          throw new ConflictError('Both wallets must hold the same currency');
        }
      }

      // A system wallet is the counterpart of money issued to users, so it is expected to sit
      // below zero; the CHECK constraint exempts it for the same reason.
      if (source.kind !== 'system' && source.balance < movement.amount) {
        throw new InsufficientFundsError(source.balance, movement.amount, movement.currency);
      }

      const sourceBalance = source.balance - movement.amount;
      const targetBalance = target.balance + movement.amount;

      await tx.transfer.create({
        data: {
          id: movement.transferId,
          idempotencyKey: movement.idempotencyKey,
          actorId: movement.actorId,
          sourceWalletId: movement.sourceWalletId,
          targetWalletId: movement.targetWalletId,
          amount: movement.amount,
          currency: movement.currency,
          status: 'completed',
          reference: movement.reference,
        },
      });

      await tx.wallet.update({
        where: { id: source.id },
        data: { balance: sourceBalance },
      });
      await tx.wallet.update({
        where: { id: target.id },
        data: { balance: targetBalance },
      });

      const sequences = await this.nextSequences(tx, [source.id, target.id]);
      const rows = await tx.ledgerEntry.createManyAndReturn({
        data: [
          {
            id: uuidv7(),
            transferId: movement.transferId,
            walletId: source.id,
            amount: -movement.amount,
            currency: movement.currency,
            balanceAfter: sourceBalance,
            sequence: sequences[source.id] ?? 1,
          },
          {
            id: uuidv7(),
            transferId: movement.transferId,
            walletId: target.id,
            amount: movement.amount,
            currency: movement.currency,
            balanceAfter: targetBalance,
            sequence: sequences[target.id] ?? 1,
          },
        ],
      });

      return {
        transferId: movement.transferId,
        sourceBalance,
        targetBalance,
        entries: rows.map(toEntry),
      };
    });
  }

  async recordFailure(movement: Movement, reason: string): Promise<void> {
    await this.client.transfer.create({
      data: {
        id: movement.transferId,
        idempotencyKey: movement.idempotencyKey,
        actorId: movement.actorId,
        sourceWalletId: movement.sourceWalletId,
        targetWalletId: movement.targetWalletId,
        amount: movement.amount,
        currency: movement.currency,
        status: 'failed',
        reference: movement.reference,
        failureReason: reason,
      },
    });
  }

  async listForWallet(walletId: string, query: CursorQuery): Promise<CursorPage<LedgerEntry>> {
    const rows = await this.client.ledgerEntry.findMany({
      where: { walletId, ...cursorWhere(query) },
      orderBy: [{ createdAt: query.direction }, { id: query.direction }],
      take: query.limit + 1,
    });

    return buildCursorPage(rows.map(toEntry), query.limit, (item) => ({
      value: item.createdAt.toISOString(),
      id: item.id,
    }));
  }

  /**
   * Walks the period by `sequence`, which is dense and unique per wallet, rather than by
   * `OFFSET`: a twelve-month statement stays as fast on its last page as on its first.
   */
  async *streamRange(walletId: string, range: StatementRange): AsyncIterable<StatementEntry> {
    let after = 0;

    for (;;) {
      const rows = await this.client.ledgerEntry.findMany({
        where: {
          walletId,
          sequence: { gt: after },
          createdAt: { gte: range.from, lte: range.to },
        },
        orderBy: { sequence: 'asc' },
        take: STREAM_BATCH,
        // One join per batch of 500, not one query per row: the label belongs to the transfer,
        // and a statement is the one place it has to be shown.
        include: { transfer: { select: { reference: true } } },
      });

      const last = rows.at(-1);

      if (last === undefined) {
        return;
      }

      for (const row of rows) {
        yield { ...toEntry(row), reference: row.transfer.reference };
      }

      after = last.sequence;
    }
  }

  /**
   * Every read happens inside one repeatable-read snapshot. Spread over separate statements the
   * check would compare a balance from before a movement with the entries from after it and
   * report a book that is in fact intact — and an integrity check that cries wolf under load is
   * worse than none, because the one time it is right nobody will believe it.
   */
  async verify(walletIds?: readonly string[]): Promise<LedgerIntegrity> {
    return this.client.$transaction(
      async (tx) => {
        const scope = walletIds === undefined ? {} : { id: { in: [...walletIds] } };
        const wallets = await tx.wallet.findMany({
          where: scope,
          select: { id: true, balance: true },
        });

        // Sequentially, not with Promise.all: the statements share one snapshot, and a Prisma
        // interactive transaction runs on a single connection.
        const audits: WalletIntegrity[] = [];

        for (const wallet of wallets) {
          audits.push(await this.verifyWallet(tx, wallet));
        }

        const groups = await tx.ledgerEntry.groupBy({
          by: ['transferId'],
          _sum: { amount: true },
        });
        const unbalancedTransferIds = groups
          .filter((group) => (group._sum.amount ?? 0n) !== 0n)
          .map((group) => group.transferId);

        const total = await tx.ledgerEntry.aggregate({ _sum: { amount: true } });
        const globalSum = total._sum.amount ?? 0n;

        return {
          wallets: audits,
          globalSum,
          unbalancedTransferIds,
          consistent:
            globalSum === 0n &&
            unbalancedTransferIds.length === 0 &&
            audits.every(
              (audit) =>
                audit.balanceMatches && audit.runningBalanceMatches && audit.sequenceIntact,
            ),
        };
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /**
   * Replays one wallet entry by entry rather than trusting a SUM: a ledger can add up to the
   * right total while still having a `balanceAfter` that never matched, which is the signature
   * of a movement that escaped the row lock.
   */
  private async verifyWallet(
    tx: Pick<SqlClient, 'ledgerEntry'>,
    wallet: { id: string; balance: bigint },
  ): Promise<WalletIntegrity> {
    const entries = await tx.ledgerEntry.findMany({
      where: { walletId: wallet.id },
      orderBy: { sequence: 'asc' },
      select: { amount: true, balanceAfter: true, sequence: true },
    });

    let running = 0n;
    let runningBalanceMatches = true;
    let sequenceIntact = true;

    for (const [index, entry] of entries.entries()) {
      running += entry.amount;

      if (entry.balanceAfter !== running) {
        runningBalanceMatches = false;
      }

      if (entry.sequence !== index + 1) {
        sequenceIntact = false;
      }
    }

    return {
      walletId: wallet.id,
      entries: entries.length,
      storedBalance: wallet.balance,
      replayedBalance: running,
      balanceMatches: running === wallet.balance,
      runningBalanceMatches,
      sequenceIntact,
    };
  }

  private async nextSequences(
    tx: Pick<SqlClient, 'ledgerEntry'>,
    walletIds: readonly string[],
  ): Promise<Record<string, number>> {
    const groups = await tx.ledgerEntry.groupBy({
      by: ['walletId'],
      where: { walletId: { in: [...walletIds] } },
      _max: { sequence: true },
    });

    const next: Record<string, number> = Object.fromEntries(walletIds.map((id) => [id, 1]));

    for (const group of groups) {
      next[group.walletId] = (group._max.sequence ?? 0) + 1;
    }

    return next;
  }
}
