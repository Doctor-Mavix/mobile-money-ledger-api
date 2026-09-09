import { randomInt, randomUUID } from 'node:crypto';

import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@core/config/env';
import type { DatabaseAdapter } from '@core/database/types';
import type { AppModule } from '@core/module';
import { authModule } from '@modules/auth/auth.module';
import { ledgerModule } from '@modules/ledger/ledger.module';
import { transferModule } from '@modules/transfer/transfer.module';
import { walletModule } from '@modules/wallet/wallet.module';
import { GROUP_SEPARATOR } from '@shared/money/money';
import { notificationModule } from '@shared/notifications/notification.module';
import type { SeededActor } from '@tests/actors';
import { bearer, enableMfa, purgeActors, seedActor } from '@tests/actors';
import type { Harness } from '@tests/harness';
import { PROVIDERS, startHarness } from '@tests/harness';
import { statementModule } from './statement.module';

const MODULES: readonly AppModule[] = [
  notificationModule,
  authModule,
  walletModule,
  ledgerModule,
  transferModule,
  statementModule,
];

const WALLETS = `${env.API_PREFIX}/wallets`;
const TRANSFERS = `${env.API_PREFIX}/transfers`;
const STATEMENTS = `${env.API_PREFIX}/statements`;

const BLOCK = `10.${String(randomInt(256))}.${String(randomInt(256))}`;
let addresses = 0;
const nextAddress = (): string => {
  addresses += 1;

  return `${BLOCK}.${String(addresses % 250)}`;
};

const DAY_MS = 86_400_000;

interface Holder {
  actor: SeededActor;
  walletId: string;
  totp: () => string;
}

describe.each(PROVIDERS)('statement module on $name', ({ name }) => {
  let harness: Harness;
  let adapter: DatabaseAdapter;
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

  /** A wallet with a history worth printing: one cash-in and one outgoing transfer. */
  const withHistory = async (): Promise<Holder> => {
    const operator = await holder(['agent']);
    const owner = await holder();
    const peer = await holder();

    const funded = await post(`${TRANSFERS}/cash-in`, operator.actor.accessToken)
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({ walletId: owner.walletId, amount: '750000', mfaCode: operator.totp() });
    expect(funded.status, JSON.stringify(funded.body)).toBe(201);

    const sent = await post(TRANSFERS, owner.actor.accessToken)
      .set('Idempotency-Key', `key-${randomUUID()}`)
      .send({
        sourceWalletId: owner.walletId,
        targetWalletId: peer.walletId,
        amount: '25000',
        mfaCode: owner.totp(),
        reference: 'Loyer aout',
      });
    expect(sent.status, JSON.stringify(sent.body)).toBe(201);

    return owner;
  };

  const period = (): string => {
    const to = new Date(Date.now() + DAY_MS);
    const from = new Date(Date.now() - DAY_MS);

    return `from=${from.toISOString()}&to=${to.toISOString()}`;
  };

  beforeAll(async () => {
    harness = await startHarness(name, MODULES);
    adapter = harness.adapter;
  });

  afterAll(async () => {
    await purgeActors(adapter, actorIds);
    await harness.stop();
  });

  it('downloads a CSV statement with the formatted history', async () => {
    const owner = await withHistory();

    const response = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?${period()}&format=csv`,
      owner.actor.accessToken,
    ).buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.headers['content-disposition']).toContain('attachment;');
    // Without this a browser renders the file inline, in the origin of the API, and a reference
    // the user chose the content of becomes script.
    expect(response.headers['content-disposition']).toContain(owner.walletId);
    expect(response.headers['cache-control']).toBe('no-store');

    const body =
      typeof response.text === 'string' && response.text !== ''
        ? response.text
        : Buffer.from(response.body as Buffer).toString('utf8');
    const lines = body.trim().split('\n');

    expect(lines[0]).toContain('Reference');
    // Header, the cash-in, the outgoing transfer.
    expect(lines).toHaveLength(3);

    // The label the payer typed, not the transfer's UUID.
    expect(lines[2]).toContain('Loyer aout');
    // The cash-in carried no label, so that row falls back to an identifier rather than a blank.
    expect(lines[1]).toMatch(/,[0-9a-f-]{36},/u);

    // XOF has no minor unit, so amounts print as whole francs and the balance runs down.
    expect(lines[1]).toContain(`750${GROUP_SEPARATOR}000 XOF`);
    expect(lines[2]).toContain(`25${GROUP_SEPARATOR}000 XOF`);
    expect(lines[2]).toContain(`725${GROUP_SEPARATOR}000 XOF`);
  });

  it('downloads a PDF statement', async () => {
    const owner = await withHistory();

    const response = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?${period()}&format=pdf`,
      owner.actor.accessToken,
    ).buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('application/pdf');
    expect(response.headers['content-disposition']).toContain('.pdf');

    const bytes = Buffer.isBuffer(response.body)
      ? response.body
      : Buffer.from(response.text, 'binary');

    expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(bytes.length).toBeGreaterThan(1_000);
  });

  it('defaults to CSV when no format is asked for', async () => {
    const owner = await withHistory();

    const response = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?${period()}`,
      owner.actor.accessToken,
    ).buffer(true);

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
  });

  /**
   * The ownership check has to happen before a single byte is written, or the response is already
   * a 200 with a `Content-Disposition` by the time the refusal is known.
   */
  it('refuses a statement for a wallet the caller does not own, before writing anything', async () => {
    const owner = await withHistory();
    const stranger = await holder();

    const response = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?${period()}&format=csv`,
      stranger.actor.accessToken,
    );

    expect(response.status).toBe(404);
    expect(response.headers['content-disposition']).toBeUndefined();
  });

  it('refuses a period that is inverted or longer than a year', async () => {
    const owner = await withHistory();
    const now = Date.now();

    const inverted = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?from=${new Date(now).toISOString()}` +
        `&to=${new Date(now - DAY_MS).toISOString()}`,
      owner.actor.accessToken,
    );
    expect(inverted.status).toBe(400);

    const tooLong = await get(
      `${STATEMENTS}/wallets/${owner.walletId}?from=${new Date(now - 400 * DAY_MS).toISOString()}` +
        `&to=${new Date(now).toISOString()}`,
      owner.actor.accessToken,
    );
    expect(tooLong.status).toBe(400);
  });

  it('refuses a statement without a token', async () => {
    const owner = await withHistory();

    const response = await harness.agent
      .get(`${STATEMENTS}/wallets/${owner.walletId}?${period()}`)
      .set('x-forwarded-for', nextAddress());

    expect(response.status).toBe(401);
  });
});
