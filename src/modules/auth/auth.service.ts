import { randomUUID } from 'node:crypto';

import { inject, injectable } from 'tsyringe';

import { env } from '@core/config/env';
import { TOKENS } from '@core/container/tokens';
import { BadRequestError, TooManyRequestsError, UnauthorizedError } from '@core/errors/app-error';
import type { Logger } from '@core/logger/logger';
import { requestContext } from '@core/http/request-context';
import type { NotificationService } from '@shared/notifications/notification.service';
import { NOTIFICATION_SERVICE } from '@shared/notifications/notification.tokens';
import type { OtpService } from '@shared/utils-services/otp.service';
import type { I18nService, Locale } from '@shared/utils-services/i18n.service';
import { SHARED_TOKENS } from '@shared/tokens';
import { AUTH_REPOSITORY } from './auth.repository';
import type { AuthRepository } from './auth.repository';
import type {
  Actor,
  ActorType,
  ActorWithSecrets,
  AuthEvent,
  DeviceInfo,
  LoginResult,
  Session,
  TokenPair,
} from './auth.types';
import { AuditService } from './audit.service';
import { JwtService } from './jwt.service';
import { LoginThrottle } from './login-throttle';
import { MfaService } from './mfa.service';
import type { MfaActivation, MfaSetup } from './mfa.service';
import { PasswordService } from './password.service';
import { RefreshReuseError, SessionService } from './session.service';

/** One message for every credential failure — see `credentialsRejected`. */
const UNIFORM_FAILURE = 'Email or password is incorrect';

const VERIFY_EMAIL_PURPOSE = 'verify-email';
const RESET_PASSWORD_PURPOSE = 'reset-password';
const VERIFY_EMAIL_TTL_SECONDS = 24 * 3600;
const RESET_PASSWORD_TTL_SECONDS = 15 * 60;

export interface RegisterInput {
  actorType: ActorType;
  email: string;
  password: string;
  displayName: string;
  phone?: string | undefined;
}

export interface LoginInput {
  actorType: ActorType;
  email: string;
  password: string;
}

@injectable()
export class AuthService {
  constructor(
    @inject(AUTH_REPOSITORY) private readonly repository: AuthRepository,
    @inject(PasswordService) private readonly passwords: PasswordService,
    @inject(JwtService) private readonly jwt: JwtService,
    @inject(SessionService) private readonly sessions: SessionService,
    @inject(MfaService) private readonly mfa: MfaService,
    @inject(LoginThrottle) private readonly throttle: LoginThrottle,
    @inject(AuditService) private readonly audit: AuditService,
    @inject(SHARED_TOKENS.Otp) private readonly otp: OtpService,
    @inject(NOTIFICATION_SERVICE) private readonly notifications: NotificationService,
    @inject(SHARED_TOKENS.I18n) private readonly i18n: I18nService,
    @inject(TOKENS.Logger) private readonly logger: Logger,
  ) {}

  async register(input: RegisterInput, device: DeviceInfo, locale: Locale): Promise<Actor> {
    this.assertPasswordPolicy(input.password);

    const email = normaliseEmail(input.email);
    const created = await this.repository.createActor({
      id: randomUUID(),
      actorType: input.actorType,
      email,
      displayName: input.displayName,
      passwordHash: await this.passwords.hash(input.password),
      phone: input.phone ?? null,
      roles: [],
      permissions: [],
      status: 'pending',
    });

    await this.sendEmailVerification(created.actor, locale);
    await this.record('register', created.actor.actorType, device, created.actor.id);

    return created.actor;
  }

  async verifyEmail(
    actorType: ActorType,
    email: string,
    code: string,
    device: DeviceInfo,
  ): Promise<void> {
    const subject = subjectOf(actorType, normaliseEmail(email));
    const verdict = await this.otp.verify(VERIFY_EMAIL_PURPOSE, subject, code);

    if (verdict !== 'valid') {
      throw new BadRequestError('This code is not valid or has expired');
    }

    const found = await this.repository.findByEmail(actorType, normaliseEmail(email));

    if (found === null) {
      return;
    }

    await this.repository.updateActor(found.actor.id, {
      emailVerifiedAt: new Date(),
      // A pending account becomes usable here; a disabled one stays disabled, because
      // confirming an address is not a way to reactivate an account someone shut off.
      ...(found.actor.status === 'pending' ? { status: 'active' as const } : {}),
    });

    await this.record('email_verified', actorType, device, found.actor.id);
  }

  async login(input: LoginInput, device: DeviceInfo): Promise<LoginResult> {
    const email = normaliseEmail(input.email);
    const scopes = throttleScopes(input.actorType, email, device.ip);
    const verdict = await this.throttle.check(scopes);

    if (verdict.locked) {
      await this.record('login_locked', input.actorType, device, null, { email });

      throw new TooManyRequestsError(
        `Too many attempts. Try again in ${String(verdict.retryAfterSeconds)} seconds.`,
      );
    }

    const found = await this.repository.findByEmail(input.actorType, email);

    if (found === null) {
      // The work is done anyway so an unknown account does not answer faster than a known one.
      await this.passwords.wasteTime();

      return this.credentialsRejected(input.actorType, device, scopes, email);
    }

    const valid = await this.passwords.verify(found.secrets.passwordHash, input.password);

    if (!valid) {
      return this.credentialsRejected(input.actorType, device, scopes, email);
    }

    if (found.actor.status === 'disabled') {
      // Same message as a wrong password: whether an account exists and is suspended is not
      // something an unauthenticated caller gets to learn.
      return this.credentialsRejected(input.actorType, device, scopes, email);
    }

    await this.throttle.clear(scopes);

    if (found.actor.mfaEnabledAt !== null) {
      const challengeToken = await this.mfa.issueChallenge(found.actor.id, found.actor.actorType);
      await this.record('mfa_required', found.actor.actorType, device, found.actor.id);

      return {
        status: 'mfa_required',
        challengeToken,
        expiresIn: env.MFA_CHALLENGE_TTL_SECONDS,
      };
    }

    return this.completeLogin(found, device);
  }

  async verifyMfa(challengeToken: string, code: string, device: DeviceInfo): Promise<LoginResult> {
    let verified;

    try {
      verified = await this.mfa.verifyChallenge(challengeToken, code);
    } catch (error) {
      await this.record('mfa_failed', 'unknown', device, null);
      throw error;
    }

    await this.record(
      verified.usedBackupCode ? 'backup_code_used' : 'mfa_success',
      verified.actor.actor.actorType,
      device,
      verified.actor.actor.id,
    );

    return this.completeLogin(verified.actor, device);
  }

  /**
   * Rotation on every use, and any mismatch on a live session is treated as theft: the token
   * is 256 random bits, so a wrong one was not guessed — it was a copy someone kept.
   */
  async refresh(refreshToken: string, device: DeviceInfo): Promise<TokenPair> {
    let rotated;

    try {
      rotated = await this.sessions.rotate(refreshToken, device);
    } catch (error) {
      if (error instanceof RefreshReuseError) {
        const revoked = await this.sessions.revokeAll(error.actorId);
        const found = await this.repository.findById(error.actorId);

        await this.record(
          'refresh_reuse_detected',
          found?.actor.actorType ?? 'unknown',
          device,
          error.actorId,
          { revokedSessions: String(revoked) },
        );

        this.logger.warn(
          { actorId: error.actorId, revoked },
          'refresh token reuse detected, every session revoked',
        );

        if (found !== null) {
          await this.notifySecurity(found.actor, 'security.sessionsRevoked');
        }

        throw new UnauthorizedError('Your session is no longer valid');
      }

      throw error;
    }

    const found = await this.repository.findById(rotated.session.actorId);

    if (found === null || found.actor.status === 'disabled') {
      await this.sessions.revoke(rotated.session.actorId, rotated.session.id);
      throw new UnauthorizedError('Your session is no longer valid');
    }

    await this.record('token_refreshed', found.actor.actorType, device, found.actor.id);

    return this.issueTokens(found.actor, rotated.session, rotated.refreshToken);
  }

  async logout(actorId: string, sessionId: string, device: DeviceInfo): Promise<void> {
    const revoked = await this.sessions.revoke(actorId, sessionId);

    if (revoked) {
      const found = await this.repository.findById(actorId);
      await this.record('logout', found?.actor.actorType ?? 'unknown', device, actorId);
    }
  }

  async logoutAll(actorId: string, device: DeviceInfo): Promise<number> {
    const revoked = await this.sessions.revokeAll(actorId);
    const found = await this.repository.findById(actorId);

    await this.record('session_revoked', found?.actor.actorType ?? 'unknown', device, actorId, {
      revokedSessions: String(revoked),
    });

    return revoked;
  }

  listSessions(actorId: string): Promise<Session[]> {
    return this.sessions.listForActor(actorId);
  }

  async revokeSession(actorId: string, sessionId: string, device: DeviceInfo): Promise<void> {
    const revoked = await this.sessions.revoke(actorId, sessionId);

    if (!revoked) {
      throw new BadRequestError('This session does not exist');
    }

    const found = await this.repository.findById(actorId);
    await this.record('session_revoked', found?.actor.actorType ?? 'unknown', device, actorId);
  }

  async changePassword(
    actorId: string,
    currentPassword: string,
    newPassword: string,
    sessionId: string,
    device: DeviceInfo,
  ): Promise<void> {
    this.assertPasswordPolicy(newPassword);

    const found = await this.repository.findById(actorId);

    if (found === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    if (!(await this.passwords.verify(found.secrets.passwordHash, currentPassword))) {
      throw new UnauthorizedError('Your current password is incorrect');
    }

    await this.repository.updateActor(actorId, {
      passwordHash: await this.passwords.hash(newPassword),
    });

    // Everything except the device doing the change: whoever else was signed in with the old
    // password loses access, which is the point of changing it.
    await this.sessions.revokeAll(actorId, sessionId);
    await this.record('password_changed', found.actor.actorType, device, actorId);
    await this.notifySecurity(found.actor, 'security.passwordChanged');
  }

  /**
   * Always answers the same way. Telling the caller whether the address is known turns the
   * reset form into an account-enumeration oracle, which is the usual way lists get built.
   */
  async requestPasswordReset(
    actorType: ActorType,
    email: string,
    device: DeviceInfo,
    locale: Locale,
  ): Promise<void> {
    const normalised = normaliseEmail(email);
    const found = await this.repository.findByEmail(actorType, normalised);

    if (found === null) {
      return;
    }

    const subject = subjectOf(actorType, normalised);
    // Issuing a new code overwrites the previous one, so an older reset email stops working.
    const code = await this.otp.issue(RESET_PASSWORD_PURPOSE, subject, {
      ttlSeconds: RESET_PASSWORD_TTL_SECONDS,
    });

    await this.notifications.notify({
      recipient: { email: normalised },
      locale,
      type: 'auth.password-reset',
      title: this.i18n.translate('auth.reset.subject', {}, locale),
      body: this.i18n.translate('auth.reset.body', { code }, locale),
      channels: ['email'],
    });

    await this.record('password_reset_requested', actorType, device, found.actor.id);
  }

  async resetPassword(
    actorType: ActorType,
    email: string,
    code: string,
    newPassword: string,
    device: DeviceInfo,
  ): Promise<void> {
    this.assertPasswordPolicy(newPassword);

    const normalised = normaliseEmail(email);
    const verdict = await this.otp.verify(
      RESET_PASSWORD_PURPOSE,
      subjectOf(actorType, normalised),
      code,
    );

    if (verdict !== 'valid') {
      throw new BadRequestError('This code is not valid or has expired');
    }

    const found = await this.repository.findByEmail(actorType, normalised);

    if (found === null) {
      throw new BadRequestError('This code is not valid or has expired');
    }

    await this.repository.updateActor(found.actor.id, {
      passwordHash: await this.passwords.hash(newPassword),
    });

    // A reset is the response to a suspected compromise, so nothing survives it.
    await this.sessions.revokeAll(found.actor.id);
    await this.record('password_reset_completed', actorType, device, found.actor.id);
    await this.notifySecurity(found.actor, 'security.passwordChanged');
  }

  beginMfaSetup(actorId: string): Promise<MfaSetup> {
    return this.mfa.beginSetup(actorId);
  }

  async confirmMfaSetup(actorId: string, code: string, device: DeviceInfo): Promise<MfaActivation> {
    const activation = await this.mfa.confirmSetup(actorId, code);
    const found = await this.repository.findById(actorId);

    await this.record('mfa_enabled', found?.actor.actorType ?? 'unknown', device, actorId);

    return activation;
  }

  /**
   * Turning the second factor off is a step-up action: it needs the password *and* a live code.
   * Otherwise a stolen access token — the one thing MFA exists to survive — is enough to
   * remove MFA and keep the account.
   */
  async disableMfa(
    actorId: string,
    password: string,
    code: string,
    device: DeviceInfo,
  ): Promise<void> {
    const found = await this.repository.findById(actorId);

    if (found === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    if (found.actor.mfaEnabledAt === null) {
      throw new BadRequestError('Two-factor authentication is not enabled');
    }

    if (!(await this.passwords.verify(found.secrets.passwordHash, password))) {
      throw new UnauthorizedError('Your current password is incorrect');
    }

    if (!(await this.mfa.verifyForActor(found, code))) {
      throw new UnauthorizedError('This code is not valid');
    }

    await this.mfa.disable(actorId);
    await this.record('mfa_disabled', found.actor.actorType, device, actorId);
  }

  async currentActor(actorId: string): Promise<Actor> {
    const found = await this.repository.findById(actorId);

    if (found === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    return found.actor;
  }

  private async completeLogin(found: ActorWithSecrets, device: DeviceInfo): Promise<LoginResult> {
    const issued = await this.sessions.issue(found.actor.id, found.actor.actorType, device);

    await this.repository.updateActor(found.actor.id, { lastLoginAt: new Date() });
    await this.record('login_success', found.actor.actorType, device, found.actor.id);

    return {
      status: 'authenticated',
      actor: found.actor,
      tokens: await this.issueTokens(found.actor, issued.session, issued.refreshToken),
    };
  }

  private async issueTokens(
    actor: Actor,
    session: Session,
    refreshToken: string,
  ): Promise<TokenPair> {
    return {
      accessToken: await this.jwt.sign({
        actorId: actor.id,
        actorType: actor.actorType,
        roles: actor.roles,
        permissions: actor.permissions,
        sessionId: session.id,
      }),
      refreshToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    };
  }

  private async credentialsRejected(
    actorType: ActorType,
    device: DeviceInfo,
    scopes: readonly string[],
    email: string,
  ): Promise<never> {
    const verdict = await this.throttle.recordFailure(scopes);

    await this.record('login_failed', actorType, device, null, { email });

    if (verdict.locked) {
      throw new TooManyRequestsError(
        `Too many attempts. Try again in ${String(verdict.retryAfterSeconds)} seconds.`,
      );
    }

    throw new UnauthorizedError(UNIFORM_FAILURE);
  }

  private assertPasswordPolicy(password: string): void {
    if (password.length < env.PASSWORD_MIN_LENGTH) {
      throw new BadRequestError(
        `The password must be at least ${String(env.PASSWORD_MIN_LENGTH)} characters long`,
      );
    }
  }

  private async sendEmailVerification(actor: Actor, locale: Locale): Promise<void> {
    const code = await this.otp.issue(
      VERIFY_EMAIL_PURPOSE,
      subjectOf(actor.actorType, actor.email),
      {
        ttlSeconds: VERIFY_EMAIL_TTL_SECONDS,
      },
    );

    await this.notifications.notify({
      recipient: { email: actor.email },
      locale,
      type: 'auth.verify-email',
      title: this.i18n.translate('auth.verify.subject', {}, locale),
      body: this.i18n.translate('auth.verify.body', { code }, locale),
      channels: ['email'],
    });
  }

  private async notifySecurity(actor: Actor, key: string): Promise<void> {
    await this.notifications.notify({
      recipient: { actorId: actor.id, email: actor.email },
      type: 'auth.security',
      title: this.i18n.translate(`auth.${key}.subject`),
      body: this.i18n.translate(`auth.${key}.body`),
      channels: ['in_app', 'email'],
    });
  }

  private async record(
    event: AuthEvent,
    actorType: ActorType,
    device: DeviceInfo,
    actorId: string | null,
    metadata: Record<string, string> = {},
  ): Promise<void> {
    await this.audit.record({
      actorId,
      actorType,
      event,
      ip: device.ip,
      userAgent: device.userAgent,
      requestId: requestContext.requestId() ?? null,
      metadata,
    });
  }
}

/** Addresses are compared case-insensitively, or the same person registers twice. */
function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

function subjectOf(actorType: ActorType, email: string): string {
  return `${actorType}:${email}`;
}

function throttleScopes(actorType: ActorType, email: string, ip: string | null): string[] {
  const scopes = [`account:${actorType}:${email}`];

  if (ip !== null) {
    scopes.push(`ip:${ip}`);
  }

  return scopes;
}
