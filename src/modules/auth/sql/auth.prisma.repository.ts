import type { Actor as ActorRow, Prisma } from '@prisma-client';

import type { SqlClient } from '@core/database/sql/prisma.adapter';
import { ConflictError } from '@core/errors/app-error';
import type { AuthRepository } from '../auth.repository';
import type { ActorPatch, ActorType, ActorWithSecrets, AuditEntry, NewActor } from '../auth.types';

const UNIQUE_VIOLATION = 'P2002';

function toActor(row: ActorRow): ActorWithSecrets {
  return {
    actor: {
      id: row.id,
      actorType: row.actorType,
      email: row.email,
      status: row.status,
      displayName: row.displayName,
      phone: row.phone,
      emailVerifiedAt: row.emailVerifiedAt,
      phoneVerifiedAt: row.phoneVerifiedAt,
      roles: row.roles,
      permissions: row.permissions,
      mfaEnabledAt: row.mfaEnabledAt,
      lastLoginAt: row.lastLoginAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    secrets: {
      passwordHash: row.passwordHash,
      mfaSecret: row.mfaSecret,
      mfaBackupCodes: row.mfaBackupCodes,
    },
  };
}

/** Prisma rejects `undefined` differently from an absent key, so only set fields are forwarded. */
function toUpdateData(patch: ActorPatch): Prisma.ActorUpdateInput {
  const data: Prisma.ActorUpdateInput = {};

  if (patch.status !== undefined) data.status = patch.status;
  if (patch.displayName !== undefined) data.displayName = patch.displayName;
  if (patch.passwordHash !== undefined) data.passwordHash = patch.passwordHash;
  if (patch.emailVerifiedAt !== undefined) data.emailVerifiedAt = patch.emailVerifiedAt;
  if (patch.phoneVerifiedAt !== undefined) data.phoneVerifiedAt = patch.phoneVerifiedAt;
  if (patch.roles !== undefined) data.roles = [...patch.roles];
  if (patch.permissions !== undefined) data.permissions = [...patch.permissions];
  if (patch.mfaSecret !== undefined) data.mfaSecret = patch.mfaSecret;
  if (patch.mfaEnabledAt !== undefined) data.mfaEnabledAt = patch.mfaEnabledAt;
  if (patch.mfaBackupCodes !== undefined) data.mfaBackupCodes = [...patch.mfaBackupCodes];
  if (patch.lastLoginAt !== undefined) data.lastLoginAt = patch.lastLoginAt;

  return data;
}

export class PrismaAuthRepository implements AuthRepository {
  constructor(private readonly client: SqlClient) {}

  async createActor(data: NewActor): Promise<ActorWithSecrets> {
    try {
      const row = await this.client.actor.create({
        data: {
          ...data,
          roles: [...data.roles],
          permissions: [...data.permissions],
        },
      });

      return toActor(row);
    } catch (error) {
      // The unique index is the only thing that can settle a race between two registrations
      // of the same address; checking first and inserting after would let both through.
      if (isUniqueViolation(error)) {
        throw new ConflictError('This account already exists', { cause: error });
      }

      throw error;
    }
  }

  async findById(id: string): Promise<ActorWithSecrets | null> {
    const row = await this.client.actor.findUnique({ where: { id } });

    return row === null ? null : toActor(row);
  }

  async findByEmail(actorType: ActorType, email: string): Promise<ActorWithSecrets | null> {
    const row = await this.client.actor.findUnique({
      where: { actorType_email: { actorType, email } },
    });

    return row === null ? null : toActor(row);
  }

  async updateActor(id: string, patch: ActorPatch): Promise<ActorWithSecrets | null> {
    const rows = await this.client.actor.updateManyAndReturn({
      where: { id },
      data: toUpdateData(patch),
    });
    const row = rows[0];

    return row === undefined ? null : toActor(row);
  }

  async recordAudit(entry: AuditEntry & { id: string }): Promise<void> {
    await this.client.authAudit.create({ data: { ...entry, metadata: entry.metadata } });
  }

  async countAuditEvents(actorId: string, event: string): Promise<number> {
    return this.client.authAudit.count({ where: { actorId, event } });
  }
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === UNIQUE_VIOLATION
  );
}
