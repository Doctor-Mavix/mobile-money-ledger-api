import { randomInt, randomUUID } from 'node:crypto';

import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@core/config/env';
import type { DatabaseAdapter } from '@core/database/types';
import type { AppModule } from '@core/module';
import { authModule } from '@modules/auth/auth.module';
import { LEDGER_REPOSITORY } from '@modules/ledger/ledger.repository';
import type { LedgerRepository } from '@modules/ledger/ledger.repository';
import { ledgerModule } from '@modules/ledger/ledger.module';
import { walletModule } from '@modules/wallet/wallet.module';
import { notificationModule } from '@shared/notifications/notification.module';
import type { SeededActor } from '@tests/actors';
import { bearer, enableMfa, purgeActors, seedActor } from '@tests/actors';
import type { Harness } from '@tests/harness';
import { PROVIDERS, startHarness } from '@tests/harness';
import { transferModule } from './transfer.module';

const MODULES: readonly AppModule[] = [
  notificationModule,
  authModule,
  walletModule,
  ledgerModule,
  transferModule,
];

const WALLETS = `${env.API_PREFIX}/wallets`;
const TRANSFERS = `${env.API_PREFIX}/transfers`;

/**
 * The global rate limiter keys on the client address, and the concurrency test fires a burst
 * from a single caller. Each test draws its own address so one burst cannot throttle the next
 * test, and the block is random per run so a leftover window does not fail the second run.
 */
const BLOCK = `10.${String(randomInt(256))}.${String(randomInt(256))}`;
let addresses = 0;
const nextAddress = (): string => {
  addresses += 1;

  return `${BLOCK}.${String(addresses % 250)}`;
};

/** XOF has no minor unit, so these amounts read as whole francs. */
const CURRENCY = 'XOF';

interface Holder {
  actor: SeededActor;
  walletId: string;
  /** A code the real verifier accepts, generated fresh so a period rollover cannot stale it. */
  totp: () => string;
}

describe.each(PROVIDERS)('transfer module on $name', ({ name }) => {
  let harness: Harness;
  let adapter: DatabaseAdapter;
  let ledger: LedgerRepository;
  const actorIds: string[] = [];

  const idempotencyKey = (): string => `key-${randomUUID()}`;

  const post = (path: string, token: string, ip: string): Test =>
    harness.agent.post(path).set('Authorization', bearer(token)).set('x-forwarded-for', ip);

  const get = (path: string, token: string, ip: string): Test =>
    harness.agent.get(path).set('Authorization', bearer(token)).set('x-forwarded-for', ip);

  /**
   * An actor who has switched two-factor on and holds one open wallet — the state every money
   * route assumes. Built through the wallet endpoint rather than the repository so the suite
   * fails if opening a wallet breaks.
   */
  const holder = async (roles: readonly string[] = []): Promise<Holder> => {
    const actor = await seedActor(harness.container, { roles });
    actorIds.push(actor.id);

    const totp = await enableMfa(harness.container, actor);
    const opened = await post(WALLETS, actor.accessToken, nextAddress()).send({
      currency: CURRENCY,
    });

    expect(opened.status).toBe(201);
    return { actor, walletId: opened.body.data.id as string, totp };
  };

  /** Money enters the platform the only way it can: a kiosk operator credits a wallet. */
  const fund = async (operator: Holder, target: Holder, amount: bigint): Promise<void> => {
    const response = await post(`${TRANSFERS}/cash-in`, operator.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({ walletId: target.walletId, amount: amount.toString(), mfaCode: operator.totp() });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
  };

  const balanceOf = async (owner: Holder): Promise<bigint> => {
    const response = await get(
      `${WALLETS}/${owner.walletId}`,
      owner.actor.accessToken,
      nextAddress(),
    );

    expect(response.status).toBe(200);

    return BigInt(response.body.data.balance as string);
  };

  beforeAll(async () => {
    harness = await startHarness(name, MODULES);
    adapter = harness.adapter;
    ledger = harness.container.resolve(LEDGER_REPOSITORY);
  });

  afterAll(async () => {
    // Only the auth rows are removed. The ledger is append-only by design — the database refuses
    // a DELETE on it — so its rows, and the wallets they reference, are deliberately left behind.
    // They stay balanced, so they cost a little space and change no assertion.
    await purgeActors(adapter, actorIds);
    await harness.stop();
  });

  /**
   * The reason this project exists. Ten transfers leave at once against a balance that can fund
   * five of them; if the row lock in `PrismaLedgerRepository.post` were missing, several would
   * read the same balance, all decide they are affordable, and the wallet would end up negative.
   */
  it('never overdraws a wallet when transfers are posted concurrently', async () => {
    const operator = await holder(['agent']);
    const source = await holder();
    const target = await holder();

    const amount = 2_000n;
    const affordable = 5;
    await fund(operator, source, amount * BigInt(affordable));

    const ip = nextAddress();
    const attempts = 10;
    const responses = await Promise.all(
      Array.from({ length: attempts }, async () =>
        post(TRANSFERS, source.actor.accessToken, ip)
          .set('Idempotency-Key', idempotencyKey())
          .send({
            sourceWalletId: source.walletId,
            targetWalletId: target.walletId,
            amount: amount.toString(),
            mfaCode: source.totp(),
          }),
      ),
    );

    const accepted = responses.filter((response) => response.status === 201);
    const refused = responses.filter((response) => response.status === 422);

    expect(accepted).toHaveLength(affordable);
    expect(refused).toHaveLength(attempts - affordable);
    expect(refused.every((response) => response.body.error.code === 'INSUFFICIENT_FUNDS')).toBe(
      true,
    );

    // Stated twice on purpose: the exact total is the assertion, and "not negative" is the
    // invariant, which stays readable in the failure output if the total is ever wrong.
    const remaining = await balanceOf(source);
    expect(remaining).toBe(0n);
    expect(remaining >= 0n).toBe(true);
    expect(await balanceOf(target)).toBe(amount * BigInt(affordable));

    const audit = await ledger.verify([source.walletId, target.walletId]);
    const sourceAudit = audit.wallets.find((wallet) => wallet.walletId === source.walletId);

    expect(audit.consistent).toBe(true);
    expect(audit.unbalancedTransferIds).toEqual([]);
    // Six entries: one credit from the cash-in, five debits from the transfers. Gapless
    // sequences are the proof no movement escaped the lock.
    expect(sourceAudit?.entries).toBe(affordable + 1);
    expect(sourceAudit?.sequenceIntact).toBe(true);
    expect(sourceAudit?.runningBalanceMatches).toBe(true);
  });

  /**
   * The three properties are asserted separately because they fail for different reasons and a
   * bare `consistent: false` does not say which. The two entry-level ones survive a lost update
   * — entries are always written in balanced pairs — so it is `balanceMatches` that catches a
   * wallet whose column and history have drifted apart.
   */
  it('reads the whole ledger back as consistent', async () => {
    const audit = await ledger.verify();
    const broken = audit.wallets.filter(
      (wallet) => !wallet.balanceMatches || !wallet.runningBalanceMatches || !wallet.sequenceIntact,
    );

    expect(audit.globalSum).toBe(0n);
    expect(audit.unbalancedTransferIds).toEqual([]);
    expect(broken).toEqual([]);
    expect(audit.consistent).toBe(true);
  });

  it('replays an idempotency key instead of moving the money twice', async () => {
    const operator = await holder(['agent']);
    const source = await holder();
    const target = await holder();

    await fund(operator, source, 5_000n);

    const ip = nextAddress();
    const key = idempotencyKey();
    const body = {
      sourceWalletId: source.walletId,
      targetWalletId: target.walletId,
      amount: '1500',
      mfaCode: source.totp(),
    };

    const first = await post(TRANSFERS, source.actor.accessToken, ip)
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(201);
    expect(first.body.data.replayed).toBe(false);

    const second = await post(TRANSFERS, source.actor.accessToken, ip)
      .set('Idempotency-Key', key)
      .send({ ...body, mfaCode: source.totp() });

    // 200, not 201: the client is being told it found what it had already created.
    expect(second.status).toBe(200);
    expect(second.body.data.replayed).toBe(true);
    expect(second.body.data.id).toBe(first.body.data.id);

    expect(await balanceOf(source)).toBe(3_500n);
    expect(await balanceOf(target)).toBe(1_500n);
  });

  it('refuses a transfer without an Idempotency-Key header', async () => {
    const source = await holder();
    const target = await holder();

    const response = await post(TRANSFERS, source.actor.accessToken, nextAddress()).send({
      sourceWalletId: source.walletId,
      targetWalletId: target.walletId,
      amount: '100',
      mfaCode: source.totp(),
    });

    expect(response.status).toBe(400);
  });

  it('refuses a transfer with a wrong two-factor code', async () => {
    const source = await holder();
    const target = await holder();

    const response = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: source.walletId,
        targetWalletId: target.walletId,
        amount: '100',
        mfaCode: '000000',
      });

    expect(response.status).toBe(401);
  });

  it('refuses to move money for an actor who has not enabled two-factor', async () => {
    const actor = await seedActor(harness.container);
    actorIds.push(actor.id);

    const opened = await post(WALLETS, actor.accessToken, nextAddress()).send({
      currency: CURRENCY,
    });
    expect(opened.status).toBe(201);

    const target = await holder();
    const response = await post(TRANSFERS, actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: opened.body.data.id as string,
        targetWalletId: target.walletId,
        amount: '100',
        mfaCode: '123456',
      });

    expect(response.status).toBe(403);
  });

  it('refuses a transfer from a wallet the caller does not own, without confirming it exists', async () => {
    const owner = await holder();
    const stranger = await holder();

    const response = await post(TRANSFERS, stranger.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: owner.walletId,
        targetWalletId: stranger.walletId,
        amount: '100',
        mfaCode: stranger.totp(),
      });

    // 404 rather than 403: the second answer would let the endpoint be walked to discover who
    // banks here.
    expect(response.status).toBe(404);
  });

  it('refuses a wallet transferring to itself', async () => {
    const operator = await holder(['agent']);
    const source = await holder();

    await fund(operator, source, 1_000n);

    const response = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: source.walletId,
        targetWalletId: source.walletId,
        amount: '100',
        mfaCode: source.totp(),
      });

    expect(response.status).toBe(409);
    expect(await balanceOf(source)).toBe(1_000n);
  });

  it('refuses to move money out of a frozen wallet', async () => {
    const admin = await seedActor(harness.container, { roles: ['admin'] });
    actorIds.push(admin.id);

    const operator = await holder(['agent']);
    const source = await holder();
    const target = await holder();

    await fund(operator, source, 1_000n);

    const frozen = await post(
      `${WALLETS}/${source.walletId}/freeze`,
      admin.accessToken,
      nextAddress(),
    );
    expect(frozen.status).toBe(200);
    expect(frozen.body.data.status).toBe('frozen');

    const response = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: source.walletId,
        targetWalletId: target.walletId,
        amount: '100',
        mfaCode: source.totp(),
      });

    expect(response.status).toBe(403);

    // A freeze has to stop money arriving too, or it is only half an answer to a fraud report.
    const incoming = await post(`${TRANSFERS}/cash-in`, operator.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({ walletId: source.walletId, amount: '100', mfaCode: operator.totp() });

    expect(incoming.status).toBe(403);
    expect(await balanceOf(source)).toBe(1_000n);

    // Unfreezing has to actually give the wallet back, or a fraud report is a one-way door.
    const thawed = await post(
      `${WALLETS}/${source.walletId}/unfreeze`,
      admin.accessToken,
      nextAddress(),
    );
    expect(thawed.status).toBe(200);
    expect(thawed.body.data.status).toBe('active');

    const retried = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: source.walletId,
        targetWalletId: target.walletId,
        amount: '100',
        mfaCode: source.totp(),
      });

    expect(retried.status).toBe(201);
    expect(await balanceOf(source)).toBe(900n);
  });

  /** Cash out: the kiosk hands over notes and the money returns to the house wallet. */
  it('takes money back out of the platform on cash-out', async () => {
    const operator = await holder(['agent']);
    const owner = await holder();

    await fund(operator, owner, 4_000n);

    const response = await post(`${TRANSFERS}/cash-out`, operator.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({ walletId: owner.walletId, amount: '1500', mfaCode: operator.totp() });

    expect(response.status, JSON.stringify(response.body)).toBe(201);
    expect(await balanceOf(owner)).toBe(2_500n);

    const audit = await ledger.verify([owner.walletId]);
    expect(audit.consistent).toBe(true);
  });

  it('refuses a cash-out larger than the wallet holds', async () => {
    const operator = await holder(['agent']);
    const owner = await holder();

    await fund(operator, owner, 500n);

    const response = await post(`${TRANSFERS}/cash-out`, operator.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({ walletId: owner.walletId, amount: '600', mfaCode: operator.totp() });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('INSUFFICIENT_FUNDS');
    expect(await balanceOf(owner)).toBe(500n);
  });

  it('keeps cash-in and cash-out behind the agent role', async () => {
    const plain = await holder();

    for (const route of ['cash-in', 'cash-out']) {
      const response = await post(`${TRANSFERS}/${route}`, plain.actor.accessToken, nextAddress())
        .set('Idempotency-Key', idempotencyKey())
        .send({ walletId: plain.walletId, amount: '100', mfaCode: plain.totp() });

      expect(response.status, route).toBe(403);
    }
  });

  it('records a refused transfer so the same key returns the same refusal', async () => {
    const source = await holder();
    const target = await holder();

    const key = idempotencyKey();
    const body = {
      sourceWalletId: source.walletId,
      targetWalletId: target.walletId,
      amount: '100',
      mfaCode: source.totp(),
    };

    const first = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', key)
      .send(body);

    expect(first.status).toBe(422);
    expect(first.body.error.code).toBe('INSUFFICIENT_FUNDS');

    const replay = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', key)
      .send({ ...body, mfaCode: source.totp() });

    expect(replay.status).toBe(200);
    expect(replay.body.data.status).toBe('failed');
    expect(replay.body.data.failureReason).toBe('insufficient_funds');
    expect(replay.body.data.replayed).toBe(true);
  });

  it('shows a transfer to both holders and to nobody else', async () => {
    const operator = await holder(['agent']);
    const source = await holder();
    const target = await holder();
    const stranger = await holder();

    await fund(operator, source, 900n);

    const created = await post(TRANSFERS, source.actor.accessToken, nextAddress())
      .set('Idempotency-Key', idempotencyKey())
      .send({
        sourceWalletId: source.walletId,
        targetWalletId: target.walletId,
        amount: '900',
        mfaCode: source.totp(),
      });

    expect(created.status).toBe(201);
    const id = created.body.data.id as string;

    for (const party of [source, target]) {
      const seen = await get(`${TRANSFERS}/${id}`, party.actor.accessToken, nextAddress());

      expect(seen.status).toBe(200);
      expect(seen.body.data.amount).toBe('900');
    }

    const hidden = await get(`${TRANSFERS}/${id}`, stranger.actor.accessToken, nextAddress());
    expect(hidden.status).toBe(404);

    const listed = await get(TRANSFERS, source.actor.accessToken, nextAddress());
    expect(listed.status).toBe(200);
    expect((listed.body.data as { id: string }[]).some((row) => row.id === id)).toBe(true);
  });

  it('refuses an amount that is not a whole number of minor units', async () => {
    const source = await holder();
    const target = await holder();

    for (const amount of ['12.50', '-100', '0', 'abc']) {
      const response = await post(TRANSFERS, source.actor.accessToken, nextAddress())
        .set('Idempotency-Key', idempotencyKey())
        .send({
          sourceWalletId: source.walletId,
          targetWalletId: target.walletId,
          amount,
          mfaCode: source.totp(),
        });

      expect(response.status, `amount ${amount} was accepted`).toBe(422);
    }
  });
});
