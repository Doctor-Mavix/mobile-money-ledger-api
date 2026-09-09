import type { Principal } from '@core/security/principal';

export const ACTOR_STATUSES = ['pending', 'active', 'disabled'] as const;
export type ActorStatus = (typeof ACTOR_STATUSES)[number];

/**
 * Kept as a plain string rather than an enum: which actor types exist is a property of the
 * generated project, not of the auth module. A project adds `customer` without touching this
 * file, which is the whole point of a single generic auth module.
 */
export type ActorType = string;

export interface Actor {
  id: string;
  actorType: ActorType;
  email: string;
  status: ActorStatus;
  displayName: string;
  phone: string | null;
  emailVerifiedAt: Date | null;
  phoneVerifiedAt: Date | null;
  roles: readonly string[];
  permissions: readonly string[];
  mfaEnabledAt: Date | null;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Everything a credential check needs, and nothing a response may ever contain. Keeping the
 * hashes in a separate type is what makes it hard to leak one by spreading an actor into JSON.
 */
export interface ActorSecrets {
  passwordHash: string;
  mfaSecret: string | null;
  mfaBackupCodes: readonly string[];
}

export interface ActorWithSecrets {
  actor: Actor;
  secrets: ActorSecrets;
}

export interface NewActor {
  id: string;
  actorType: ActorType;
  email: string;
  displayName: string;
  passwordHash: string;
  phone: string | null;
  roles: readonly string[];
  permissions: readonly string[];
  status: ActorStatus;
}

export interface ActorPatch {
  status?: ActorStatus;
  displayName?: string;
  passwordHash?: string;
  emailVerifiedAt?: Date | null;
  phoneVerifiedAt?: Date | null;
  roles?: readonly string[];
  permissions?: readonly string[];
  mfaSecret?: string | null;
  mfaEnabledAt?: Date | null;
  mfaBackupCodes?: readonly string[];
  lastLoginAt?: Date | null;
}

/** The authenticated caller, rebuilt from the access token on every request. */
export type AuthenticatedActor = Principal;

export interface AccessTokenClaims {
  sub: string;
  actorType: ActorType;
  roles: readonly string[];
  permissions: readonly string[];
  sid: string;
  jti: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Seconds, so a client can schedule its refresh without parsing the JWT. */
  expiresIn: number;
}

export interface AuthenticatedResult {
  status: 'authenticated';
  actor: Actor;
  tokens: TokenPair;
}

/**
 * Returned instead of tokens when MFA is on. No access token is ever issued before the second
 * factor is verified, so a stolen password alone gets an attacker a challenge id and nothing else.
 */
export interface MfaRequiredResult {
  status: 'mfa_required';
  challengeToken: string;
  expiresIn: number;
}

export type LoginResult = AuthenticatedResult | MfaRequiredResult;

export interface DeviceInfo {
  ip: string | null;
  userAgent: string | null;
}

export interface Session {
  id: string;
  actorId: string;
  actorType: ActorType;
  ip: string | null;
  userAgent: string | null;
  createdAt: Date;
  lastSeenAt: Date;
}

export const AUTH_EVENTS = [
  'register',
  'email_verified',
  'login_success',
  'login_failed',
  'login_locked',
  'mfa_required',
  'mfa_success',
  'mfa_failed',
  'mfa_enabled',
  'mfa_disabled',
  'backup_code_used',
  'token_refreshed',
  'refresh_reuse_detected',
  'logout',
  'password_changed',
  'password_reset_requested',
  'password_reset_completed',
  'session_revoked',
] as const;

export type AuthEvent = (typeof AUTH_EVENTS)[number];

export interface AuditEntry {
  actorId: string | null;
  actorType: ActorType;
  event: AuthEvent;
  ip: string | null;
  userAgent: string | null;
  requestId: string | null;
  metadata: Record<string, string>;
}
