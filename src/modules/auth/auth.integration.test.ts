import { randomInt } from 'node:crypto';

import { Secret, TOTP } from 'otpauth';
import type { Test } from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { env } from '@core/config/env';
import type { DatabaseAdapter } from '@core/database/types';
import type { AppModule } from '@core/module';
import { notificationModule } from '@shared/notifications/notification.module';
import type { SeedActorOptions, SeededActor } from '@tests/actors';
import { TEST_PASSWORD, bearer, purgeActors, seedActor, testEmail } from '@tests/actors';
import type { Harness } from '@tests/harness';
import { PROVIDERS, startHarness } from '@tests/harness';
import { authModule } from './auth.module';

/** Auth refuses to register without notifications: it has no other way to send a code. */
const MODULES: readonly AppModule[] = [notificationModule, authModule];

const AUTH = `${env.API_PREFIX}/auth`;

/**
 * Every test gets its own client address. Both the login throttle and the global rate limiter
 * key on the IP, so sharing one would make a test that fails a login on purpose break the next
 * test that logs in for real. `trust proxy` is `loopback`, which is exactly what supertest is.
 *
 * The block is drawn at random for each run: a lockout outlives the process that caused it by
 * up to LOGIN_LOCKOUT_MAX_SECONDS, so a fixed block would make the second run of the hour fail.
 */
const BLOCK = `10.${String(randomInt(256))}.${String(randomInt(256))}`;
let addresses = 0;
const nextAddress = (): string => {
  addresses += 1;

  return `${BLOCK}.${String(addresses % 250)}`;
};

interface Client {
  post(path: string): Test;
  get(path: string): Test;
  delete(path: string): Test;
}

function totpFor(email: string, secret: string): string {
  return new TOTP({
    issuer: env.APP_NAME,
    label: email,
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(secret),
  }).generate();
}

describe.each(PROVIDERS)('auth module on $name', ({ name }) => {
  let harness: Harness;
  let adapter: DatabaseAdapter;
  const actorIds: string[] = [];

  /** A supertest agent pinned to one client address, so a suite reads like a single browser. */
  const client = (): Client => {
    const ip = nextAddress();
    const { agent } = harness;

    return {
      post: (path) => agent.post(path).set('x-forwarded-for', ip),
      get: (path) => agent.get(path).set('x-forwarded-for', ip),
      delete: (path) => agent.delete(path).set('x-forwarded-for', ip),
    };
  };

  /** The one-time code as the recipient would read it, straight out of the mail that was sent. */
  const codeFor = (email: string): string => {
    const body = harness.mailer.lastTo(email)?.context?.['body'];
    const match = /\d{6}/.exec(typeof body === 'string' ? body : '');

    expect(match, `no code in the mail sent to ${email}`).not.toBeNull();

    return match?.[0] ?? '';
  };

  const register = async (from: Client, email: string): Promise<void> => {
    const response = await from
      .post(`${AUTH}/register`)
      .send({ email, password: TEST_PASSWORD, displayName: 'Aline Test' });

    expect(response.status).toBe(201);
    actorIds.push(response.body.data.id as string);
  };

  /** Signs an actor in without the registration flow, and remembers it for the cleanup. */
  const signIn = async (options: SeedActorOptions = {}): Promise<SeededActor> => {
    const actor = await seedActor(harness.container, options);
    actorIds.push(actor.id);

    return actor;
  };

  beforeAll(async () => {
    harness = await startHarness(name, MODULES);
    adapter = harness.adapter;
  });

  afterAll(async () => {
    await purgeActors(adapter, actorIds);
    await harness.stop();
  });

  it('walks register, verification, login, a guarded route, refresh and logout', async () => {
    const from = client();
    const email = testEmail('lifecycle');

    await register(from, email);

    const created = harness.mailer.lastTo(email);
    expect(created?.subject).toBeTypeOf('string');

    // The account exists but is not confirmed yet.
    const pending = await from
      .post(`${AUTH}/login`)
      .send({ email, password: TEST_PASSWORD })
      .expect(200);
    expect(pending.body.data.actor).toMatchObject({ status: 'pending', emailVerified: false });

    await from
      .post(`${AUTH}/verify-email`)
      .send({ email, code: codeFor(email) })
      .expect(204);

    const login = await from
      .post(`${AUTH}/login`)
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    expect(login.body.data).toMatchObject({ status: 'authenticated' });
    expect(login.body.data.actor).toMatchObject({ status: 'active', emailVerified: true });
    // Nothing a response may not show ever leaves the controller.
    expect(JSON.stringify(login.body)).not.toContain('passwordHash');

    const { accessToken, refreshToken } = login.body.data;

    await from.get(`${AUTH}/me`).expect(401);

    const me = await from.get(`${AUTH}/me`).set('authorization', bearer(accessToken)).expect(200);
    expect(me.body.data.email).toBe(email);

    const refreshed = await from.post(`${AUTH}/refresh`).send({ refreshToken }).expect(200);
    expect(refreshed.body.data.refreshToken).not.toBe(refreshToken);

    const rotated = refreshed.body.data.accessToken as string;
    await from.get(`${AUTH}/me`).set('authorization', bearer(rotated)).expect(200);

    await from.post(`${AUTH}/logout`).set('authorization', bearer(rotated)).expect(204);

    // The session is gone, so a token that is still cryptographically valid is worth nothing.
    await from.get(`${AUTH}/me`).set('authorization', bearer(rotated)).expect(401);
  });

  it('answers an unknown account and a wrong password in exactly the same way', async () => {
    const from = client();
    const known = testEmail('uniform');

    await register(from, known);

    const wrongPassword = await from
      .post(`${AUTH}/login`)
      .send({ email: known, password: 'not-the-right-password' })
      .expect(401);

    const unknownAccount = await from
      .post(`${AUTH}/login`)
      .send({ email: testEmail('nobody'), password: 'not-the-right-password' })
      .expect(401);

    expect(wrongPassword.body.error).toEqual(unknownAccount.body.error);
  });

  it('locks the caller out once the failures pile up', async () => {
    const from = client();
    const email = testEmail('throttle');

    for (let attempt = 1; attempt < env.LOGIN_MAX_ATTEMPTS; attempt += 1) {
      await from.post(`${AUTH}/login`).send({ email, password: 'wrong-password' }).expect(401);
    }

    const locked = await from
      .post(`${AUTH}/login`)
      .send({ email, password: 'wrong-password' })
      .expect(429);

    expect(locked.body.error.code).toBe('TOO_MANY_REQUESTS');

    // And the lock outlives the attempt that triggered it: the next try is refused before the
    // password is even looked at.
    await from.post(`${AUTH}/login`).send({ email, password: TEST_PASSWORD }).expect(429);
  });

  it('rotates the refresh token and revokes the family when an old one comes back', async () => {
    const from = client();
    const actor = await signIn();

    const first = await from
      .post(`${AUTH}/refresh`)
      .send({ refreshToken: actor.refreshToken })
      .expect(200);

    const second = first.body.data.refreshToken as string;

    // Replaying the token that was just rotated out: 256 random bits cannot have been guessed,
    // so this is a copy someone kept, and every session of the actor goes.
    await from.post(`${AUTH}/refresh`).send({ refreshToken: actor.refreshToken }).expect(401);

    await from.post(`${AUTH}/refresh`).send({ refreshToken: second }).expect(401);
    await from
      .get(`${AUTH}/me`)
      .set('authorization', bearer(first.body.data.accessToken as string))
      .expect(401);
  });

  it('enables MFA, challenges the next login, and spends a backup code once', async () => {
    const from = client();
    const actor = await signIn();
    const auth = bearer(actor.accessToken);

    const setup = await from.post(`${AUTH}/mfa/setup`).set('authorization', auth).expect(200);
    expect(setup.body.data.qrCodeDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(setup.body.data.otpauthUrl).toContain('otpauth://totp/');

    const secret = setup.body.data.secret as string;

    // A wrong code must not switch the second factor on.
    await from
      .post(`${AUTH}/mfa/confirm`)
      .set('authorization', auth)
      .send({ code: '000000' })
      .expect(401);

    const confirmed = await from
      .post(`${AUTH}/mfa/confirm`)
      .set('authorization', auth)
      .send({ code: totpFor(actor.email, secret) })
      .expect(200);

    const backupCodes = confirmed.body.data.backupCodes as string[];
    expect(backupCodes).toHaveLength(10);

    // The password alone now buys a challenge and nothing else.
    const challenged = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    expect(challenged.body.data).toMatchObject({ status: 'mfa_required' });
    expect(challenged.body.data).not.toHaveProperty('accessToken');

    const verified = await from
      .post(`${AUTH}/mfa/verify`)
      .send({
        challengeToken: challenged.body.data.challengeToken,
        code: totpFor(actor.email, secret),
      })
      .expect(200);

    expect(verified.body.data.status).toBe('authenticated');

    const [backupCode] = backupCodes;
    const second = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    await from
      .post(`${AUTH}/mfa/verify`)
      .send({ challengeToken: second.body.data.challengeToken, code: backupCode })
      .expect(200);

    // Single use: the same code presented twice is no longer a code.
    const third = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    await from
      .post(`${AUTH}/mfa/verify`)
      .send({ challengeToken: third.body.data.challengeToken, code: backupCode })
      .expect(401);
  });

  it('refuses to disable MFA without both the password and a live code', async () => {
    const from = client();
    const actor = await signIn();
    const auth = bearer(actor.accessToken);

    const setup = await from.post(`${AUTH}/mfa/setup`).set('authorization', auth).expect(200);
    const secret = setup.body.data.secret as string;

    await from
      .post(`${AUTH}/mfa/confirm`)
      .set('authorization', auth)
      .send({ code: totpFor(actor.email, secret) })
      .expect(200);

    // A stolen access token is exactly what MFA exists to survive, so it is not enough on its own.
    await from
      .post(`${AUTH}/mfa/disable`)
      .set('authorization', auth)
      .send({ password: 'not-the-right-password', code: totpFor(actor.email, secret) })
      .expect(401);

    await from
      .post(`${AUTH}/mfa/disable`)
      .set('authorization', auth)
      .send({ password: actor.password, code: '000000' })
      .expect(401);

    await from
      .post(`${AUTH}/mfa/disable`)
      .set('authorization', auth)
      .send({ password: actor.password, code: totpFor(actor.email, secret) })
      .expect(204);

    // With the second factor gone, the password alone signs in again.
    const login = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    expect(login.body.data.status).toBe('authenticated');
  });

  it('resets a forgotten password without ever saying whether the address exists', async () => {
    const from = client();
    const email = testEmail('reset');

    await register(from, email);

    const unknown = await from
      .post(`${AUTH}/password-reset`)
      .send({ email: testEmail('nobody') })
      .expect(202);

    const known = await from.post(`${AUTH}/password-reset`).send({ email }).expect(202);
    expect(known.body.data).toEqual(unknown.body.data);

    const signedIn = await from
      .post(`${AUTH}/login`)
      .send({ email, password: TEST_PASSWORD })
      .expect(200);

    // Read before the reset: confirming sends a "your password changed" mail that would
    // otherwise be the last one this address received.
    const code = codeFor(email);
    const newPassword = 'a-brand-new-passphrase';

    await from
      .post(`${AUTH}/password-reset/confirm`)
      .send({ email, code, newPassword })
      .expect(204);

    // A reset answers a suspected compromise, so nothing survives it.
    await from
      .get(`${AUTH}/me`)
      .set('authorization', bearer(signedIn.body.data.accessToken as string))
      .expect(401);

    await from.post(`${AUTH}/login`).send({ email, password: TEST_PASSWORD }).expect(401);
    await from.post(`${AUTH}/login`).send({ email, password: newPassword }).expect(200);

    // The code died with its first use.
    await from
      .post(`${AUTH}/password-reset/confirm`)
      .send({ email, code, newPassword: 'yet-another-passphrase' })
      .expect(400);
  });

  it('keeps only the current session when the password changes', async () => {
    const from = client();
    const actor = await signIn();

    const elsewhere = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    const other = bearer(elsewhere.body.data.accessToken as string);

    await from
      .post(`${AUTH}/change-password`)
      .set('authorization', other)
      .send({ currentPassword: actor.password, newPassword: 'a-completely-new-passphrase' })
      .expect(204);

    // The device that made the change stays signed in; the one that did not, does not.
    await from.get(`${AUTH}/me`).set('authorization', other).expect(200);
    await from.get(`${AUTH}/me`).set('authorization', bearer(actor.accessToken)).expect(401);
  });

  it('lists the sessions of the caller and revokes one of them', async () => {
    const from = client();
    const actor = await signIn();

    const elsewhere = await from
      .post(`${AUTH}/login`)
      .send({ email: actor.email, password: actor.password })
      .expect(200);

    const other = bearer(elsewhere.body.data.accessToken as string);
    const listed = await from.get(`${AUTH}/sessions`).set('authorization', other).expect(200);

    expect(listed.body.data).toHaveLength(2);
    expect(
      listed.body.data.filter((session: { current: boolean }) => session.current),
    ).toHaveLength(1);

    await from
      .delete(`${AUTH}/sessions/${actor.sessionId}`)
      .set('authorization', other)
      .expect(204);

    await from.get(`${AUTH}/me`).set('authorization', bearer(actor.accessToken)).expect(401);

    // Revoking a session that is not there is a refusal, not a silent success.
    await from
      .delete(`${AUTH}/sessions/${actor.sessionId}`)
      .set('authorization', other)
      .expect(400);
  });

  it('rejects a malformed body and a token that is not one', async () => {
    const from = client();

    const short = await from
      .post(`${AUTH}/register`)
      .send({ email: testEmail('short'), password: 'tiny', displayName: 'Aline Test' })
      .expect(422);

    expect(short.body.error.code).toBe('VALIDATION_FAILED');

    // Mass assignment: the roles an account holds are not part of the sign-up contract.
    await from
      .post(`${AUTH}/register`)
      .send({
        email: testEmail('escalate'),
        password: TEST_PASSWORD,
        displayName: 'Aline Test',
        roles: ['admin'],
      })
      .expect(422);

    await from.get(`${AUTH}/me`).set('authorization', 'Bearer not-a-jwt').expect(401);
    await from.get(`${AUTH}/me`).set('authorization', 'Basic dXNlcjpwYXNz').expect(401);
  });
});
