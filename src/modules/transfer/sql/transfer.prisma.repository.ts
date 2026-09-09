import type { Prisma, Transfer as TransferRow } from '@prisma-client';

import type { CursorPage, CursorQuery } from '@core/database/pagination';
import { buildCursorPage } from '@core/database/pagination';
import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { Currency } from '@shared/money/money';
import type { TransferRepository } from '../transfer.repository';
import type { Transfer } from '../transfer.types';

function toTransfer(row: TransferRow): Transfer {
  return {
    id: row.id,
    idempotencyKey: row.idempotencyKey,
    actorId: row.actorId,
    sourceWalletId: row.sourceWalletId,
    targetWalletId: row.targetWalletId,
    amount: row.amount,
    currency: row.currency as Currency,
    status: row.status,
    reference: row.reference,
    failureReason: row.failureReason,
    createdAt: row.createdAt,
  };
}

function cursorWhere(query: CursorQuery): Prisma.TransferWhereInput | undefined {
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

/**
 * Reads only. Transfers are written by the posting transaction in the ledger module, because a
 * transfer row and the entries that explain it have to appear together or not at all.
 */
export class PrismaTransferRepository implements TransferRepository {
  constructor(private readonly client: SqlClient) {}

  async findById(id: string): Promise<Transfer | null> {
    const row = await this.client.transfer.findUnique({ where: { id } });

    return row === null ? null : toTransfer(row);
  }

  async findByIdempotencyKey(actorId: string, key: string): Promise<Transfer | null> {
    const row = await this.client.transfer.findUnique({
      where: { actorId_idempotencyKey: { actorId, idempotencyKey: key } },
    });

    return row === null ? null : toTransfer(row);
  }

  async listForActor(actorId: string, query: CursorQuery): Promise<CursorPage<Transfer>> {
    const rows = await this.client.transfer.findMany({
      where: { actorId, ...cursorWhere(query) },
      orderBy: [{ createdAt: query.direction }, { id: query.direction }],
      take: query.limit + 1,
    });

    return buildCursorPage(rows.map(toTransfer), query.limit, (item) => ({
      value: item.createdAt.toISOString(),
      id: item.id,
    }));
  }
}
