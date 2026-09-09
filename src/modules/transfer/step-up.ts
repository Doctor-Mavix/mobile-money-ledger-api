import { ForbiddenError, UnauthorizedError } from '@core/errors/app-error';
import type { AuthRepository } from '@modules/auth/auth.repository';
import type { MfaService } from '@modules/auth/mfa.service';

/**
 * Re-proving who you are, in the middle of a session that is already authenticated. A stolen
 * access token is enough to read a balance; it must not be enough to empty it.
 *
 * This is a port rather than a direct call into the auth module because the two things a
 * step-up needs — the actor's sealed MFA secret and the code validator — are internals of that
 * module. The transfer service knows only that some collaborator can say yes or no.
 *
 * That the kit has no step-up primitive of its own is a template gap: every project that moves
 * money, changes an email or deletes an account has to reinvent these twenty lines.
 */
export interface StepUpVerifier {
  /** Resolves when the code is valid; throws otherwise. Never returns false. */
  verify(actorId: string, code: string): Promise<void>;
}

export class MfaStepUpVerifier implements StepUpVerifier {
  constructor(
    private readonly repository: AuthRepository,
    private readonly mfa: MfaService,
  ) {}

  async verify(actorId: string, code: string): Promise<void> {
    const found = await this.repository.findById(actorId);

    if (found === null) {
      throw new UnauthorizedError('Your session is no longer valid');
    }

    // Refused rather than waved through: "MFA is mandatory for transfers" has to mean the
    // account cannot move money until it is switched on, or it is a suggestion.
    if (found.actor.mfaEnabledAt === null) {
      throw new ForbiddenError(
        'Two-factor authentication must be enabled before you can move money',
      );
    }

    if (!(await this.mfa.verifyForActor(found, code))) {
      throw new UnauthorizedError('This two-factor code is not valid');
    }
  }
}
