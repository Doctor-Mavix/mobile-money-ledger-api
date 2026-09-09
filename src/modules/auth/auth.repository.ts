import type { InjectionToken } from 'tsyringe';

import type { ActorPatch, ActorType, ActorWithSecrets, AuditEntry, NewActor } from './auth.types';

export interface AuthRepository {
  createActor(data: NewActor): Promise<ActorWithSecrets>;
  findById(id: string): Promise<ActorWithSecrets | null>;
  /** The pair (actorType, email) is the identity: one address can hold several accounts. */
  findByEmail(actorType: ActorType, email: string): Promise<ActorWithSecrets | null>;
  updateActor(id: string, patch: ActorPatch): Promise<ActorWithSecrets | null>;
  /** Append-only: there is deliberately no update or delete for audit rows. */
  recordAudit(entry: AuditEntry & { id: string }): Promise<void>;
  countAuditEvents(actorId: string, event: string): Promise<number>;
}

export const AUTH_REPOSITORY = Symbol('AuthRepository') as InjectionToken<AuthRepository>;
