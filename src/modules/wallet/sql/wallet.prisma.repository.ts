import { v7 as uuidv7 } from 'uuid';

import type { Wallet as WalletRow } from '@prisma-client';

import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { Currency } from '@shared/money/money';
import type { NewWallet, WalletRepository } from '../wallet.repository';
import { SYSTEM_ACTOR_ID } from '../wallet.types';
import type { Wallet, WalletStatus } from '../wallet.types';

const UNIQUE_VIOLATION = 'P2002';

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}

export function toWallet(row: WalletRow): Wallet {
  return {
    id: row.id,
    actorId: row.actorId,
    kind: row.kind,
    // The column is a free-form string so a project can add a currency without a migration;
    // every write goes through `currencySchema`, so what comes back is one of the known set.
    currency: row.currency as Currency,
    balance: row.balance,
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export class PrismaWalletRepository implements WalletRepository {
  constructor(private readonly client: SqlClient) {}

  async create(data: NewWallet): Promise<Wallet> {
    return toWallet(await this.client.wallet.create({ data }));
  }

  async findById(id: string): Promise<Wallet | null> {
    const row = await this.client.wallet.findUnique({ where: { id } });

    return row === null ? null : toWallet(row);
  }

  async findByOwner(actorId: string, currency: Currency): Promise<Wallet | null> {
    const row = await this.client.wallet.findUnique({
      where: { actorId_currency: { actorId, currency } },
    });

    return row === null ? null : toWallet(row);
  }

  async listForActor(actorId: string): Promise<Wallet[]> {
    const rows = await this.client.wallet.findMany({
      where: { actorId },
      orderBy: [{ currency: 'asc' }],
    });

    return rows.map(toWallet);
  }

  async setStatus(id: string, status: WalletStatus): Promise<Wallet | null> {
    const result = await this.client.wallet.updateManyAndReturn({
      where: { id },
      data: { status },
    });
    const row = result[0];

    return row === undefined ? null : toWallet(row);
  }

  async ensureSystemWallet(currency: Currency): Promise<Wallet> {
    const existing = await this.findByOwner(SYSTEM_ACTOR_ID, currency);

    if (existing !== null) {
      return existing;
    }

    try {
      return await this.create({
        id: uuidv7(),
        actorId: SYSTEM_ACTOR_ID,
        kind: 'system',
        currency,
      });
    } catch (error) {
      if (!isUniqueViolation(error)) {
        throw error;
      }

      // Another instance opened it between the read and the insert. The unique index is what
      // decided, and the row it kept is the one both callers must now use.
      const won = await this.findByOwner(SYSTEM_ACTOR_ID, currency);

      if (won === null) {
        throw error;
      }

      return won;
    }
  }
}
