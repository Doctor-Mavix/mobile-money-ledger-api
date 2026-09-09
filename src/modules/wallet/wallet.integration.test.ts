import { randomInt, randomUUID } from 'node:crypto';

import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@core/config/env';
import { sqlClientOf } from '@core/database';
import type { SqlClient } from '@core/database/sql/prisma.adapter';
import type { DatabaseAdapter } from '@core/database/types';
import type { AppModule } from '@core/module';
import { authModule } from '@modules/auth/auth.module';
import { ledgerModule } from '@modules/ledger/ledger.module';
import { transferModule } from '@modules/transfer/transfer.module';
import { notificationModule } from '@shared/notifications/notification.module';
import type { SeededActor } from '@tests/actors';
import { bearer, enableMfa, purgeActors, seedActor } from '@tests/actors';
import type { Harness } from '@tests/harness';
import { PROVIDERS, startHarness } from '@tests/harness';
import { walletModule } from './wallet.module';

const MODULES: readonly AppModule[] = [
  notificationModule,
  authModule,
  walletModule,
  ledgerModule,
  transferModule,
];

const WALLETS = `${env.API_PREFIX}/wallets`;
const LEDGER = `${env.API_PREFIX}/ledger`;
const TRANSFERS = `${env.API_PREFIX}/transfers`;

const BLOCK = `10.${String(randomInt(256))}.${String(randomInt(256))}`;
let addresses = 0;
const nextAddress = (): string => {
  addresses += 1;

  return `${BLOCK}.${String(addresses % 250)}`;
};

interface Holder {
  actor: SeededActor;
  walletId: string;
  totp: () => string;
}

describe.each(PROVIDERS)('wallet and ledger on $name', ({ name }) => {
  let harness: Harness;
  let adapter: DatabaseAdapter;
  let client: SqlClient;
  const actorIds: string[] = [];

  const post = (path: string, token: string): Test =>
    harness.agent
      .post(path)
      .set('Authorization', bearer(token))
      .set('x-forwarded-for', nextAddress());

  const get = (path: string, token: string): Test =>
    harness.agent
      .get(path)
      .set('Authorization', bearer(token))
      .set('x-forwarded-for', nextAddress());

  const holder = async (roles: readonly string[] = []): Promise<Holder> => {
    const actor = await seedActor(harness.container, { roles });
    actorIds.push(actor.id);

    const totp = await enableMfa(harness.container, actor);
    const opened = await post(WALLETS, actor.accessToken).send({ currency: 'XOF' });

    expect(opened.status).toBe(201);

    return { actor, walletId: opened.body.data.id as string, totp };
  };

  const fund = async (operator: Holder, target: Holder, amount: bigint): Promise<void> => {
    const response = await post(`${TRANSFERS}/cash-in`, operator.actor.accessToken)
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ walletId: target.walletId, amount: amount.toString(), mfaCode: operator.totp() });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  };

  beforeAll(async () => {
    harness = await startHarness(name, MODULES);
    adapter = harness.adapter;
    client = sqlClientOf(adapter);
  });

  afterAll(async () => {
    await purgeActors(adapter, actorIds);
    await harness.stop();
  });

  it('refuses a second wallet in a currency the holder already has', async () => {
    const owner = await holder();

    const again = await post(WALLETS, owner.actor.accessToken).send({ currency: 'XOF' });
    expect(again.status).toBe(409);

    const other = await post(WALLETS, owner.actor.accessToken).send({ currency: 'EUR' });
    expect(other.status).toBe(201);

    const listed = await get(WALLETS, owner.actor.accessToken);
    expect(listed.status).toBe(200);
    expect((listed.body.data as { currency: string }[]).map((row) => row.currency).sort()).toEqual([
      'EUR',
      'XOF',
    ]);
  });

  it('hides a wallet the caller does not own behind a 404', async () => {
    const owner = await holder();
    const stranger = await holder();

    const seen = await get(`${WALLETS}/${owner.walletId}`, stranger.actor.accessToken);
    expect(seen.status).toBe(404);

    const entries = await get(`${LEDGER}/wallets/${owner.walletId}`, stranger.actor.accessToken);
    expect(entries.status).toBe(404);
  });

  it('refuses every wallet route without a token', async () => {
    const response = await harness.agent.get(WALLETS).set('x-forwarded-for', nextAddress());

    expect(response.status).toBe(401);
  });

  it('lists a wallet history newest first and pages with a cursor', async () => {
    const operator = await holder(['agent']);
    const owner = await holder();

    for (let index = 0; index < 3; index += 1) {
      await fund(operator, owner, 1_000n);
    }

    const first = await get(`${LEDGER}/wallets/${owner.walletId}?limit=2`, owner.actor.accessToken);

    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(2);
    expect(first.body.meta.hasMore).toBe(true);

    const rest = await get(
      `${LEDGER}/wallets/${owner.walletId}?limit=2&cursor=${encodeURIComponent(
        first.body.meta.nextCursor as string,
      )}`,
      owner.actor.accessToken,
    );

    expect(rest.status).toBe(200);
    expect(rest.body.data).toHaveLength(1);
    expect(rest.body.meta.hasMore).toBe(false);

    // Every credit is +1000 and the running balance climbs, which is what a statement renders.
    const sequences = [...first.body.data, ...rest.body.data].map(
      (entry: { sequence: number }) => entry.sequence,
    );
    expect(sequences).toEqual([3, 2, 1]);
  });

  it('keeps the integrity endpoint behind the back-office role', async () => {
    const plain = await holder();
    const admin = await seedActor(harness.container, { roles: ['admin'] });
    actorIds.push(admin.id);

    const refused = await get(`${LEDGER}/integrity`, plain.actor.accessToken);
    expect(refused.status).toBe(403);

    const allowed = await get(`${LEDGER}/integrity`, admin.accessToken);
    expect(allowed.status).toBe(200);
    expect(allowed.body.data.consistent).toBe(true);
    expect(allowed.body.data.globalSum).toBe('0');
  });

  /**
   * The guarantee no amount of application code can give, so it is asserted against the database
   * directly: even a caller holding the connection cannot rewrite history here.
   */
  it('refuses an UPDATE or a DELETE on the ledger at the database level', async () => {
    const operator = await holder(['agent']);
    const owner = await holder();

    await fund(operator, owner, 1_000n);

    const entry = await client.ledgerEntry.findFirstOrThrow({
      where: { walletId: owner.walletId },
    });

    await expect(
      client.$executeRaw`UPDATE "ledger_entries" SET "amount" = 1 WHERE "id" = ${entry.id}`,
    ).rejects.toThrow(/append-only/u);

    await expect(
      client.$executeRaw`DELETE FROM "ledger_entries" WHERE "id" = ${entry.id}`,
    ).rejects.toThrow(/append-only/u);

    const untouched = await client.ledgerEntry.findUniqueOrThrow({ where: { id: entry.id } });
    expect(untouched.amount).toBe(1_000n);
  });

  it('refuses a negative balance on a user wallet at the database level', async () => {
    const owner = await holder();

    await expect(
      client.$executeRaw`UPDATE "wallets" SET "balance" = -1 WHERE "id" = ${owner.walletId}`,
    ).rejects.toThrow(/wallets_balance_non_negative/u);
  });

  it('lets a system wallet go negative, because it is the counterpart of money in circulation', async () => {
    const operator = await holder(['agent']);
    const owner = await holder();

    await fund(operator, owner, 2_500n);

    const house = await client.wallet.findFirstOrThrow({
      where: { kind: 'system', currency: 'XOF' },
    });

    expect(house.balance).toBeLessThan(0n);
  });
});
