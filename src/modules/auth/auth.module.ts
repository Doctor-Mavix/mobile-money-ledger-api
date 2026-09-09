import { TOKENS } from '@core/container/tokens';
import { sqlClientOf } from '@core/database';
import { ConfigurationError } from '@core/errors/app-error';
import type { AppModule, ModuleRegistration } from '@core/module';
import { NOTIFICATION_SERVICE } from '@shared/notifications/notification.tokens';
import { SHARED_TOKENS } from '@shared/tokens';
import { AuditService, registerAuditJob } from './audit.service';
import { AuthController } from './auth.controller';
import { AUTH_REPOSITORY } from './auth.repository';
import type { AuthRepository } from './auth.repository';
import { JwtGuard } from './jwt.guard';
import { JwtService } from './jwt.service';
import { LoginThrottle } from './login-throttle';
import { MfaController } from './mfa.controller';
import { MfaService } from './mfa.service';
import { PasswordService } from './password.service';
import { SessionController } from './session.controller';
import { JwtSocketAuthenticator } from './socket.authenticator';
import { SessionService } from './session.service';
import { PrismaAuthRepository } from './sql/auth.prisma.repository';

function createRepository(registration: ModuleRegistration): AuthRepository {
  return new PrismaAuthRepository(sqlClientOf(registration.adapter));
}

/**
 * Registering `TOKENS.AuthGuard` is what unlocks every non-`@Public()` route in the
 * application: without this module the registry refuses to boot rather than mounting
 * protected routes with nothing in front of them.
 */
export const authModule: AppModule = {
  name: 'auth',
  controllers: [AuthController, MfaController, SessionController],
  // No soft delete on actors on purpose: an account is switched off through `status`, which
  // the login path already checks. A soft-deleted row would still hold live sessions.
  register(registration) {
    const { container } = registration;

    if (!container.isRegistered(NOTIFICATION_SERVICE, true)) {
      throw new ConfigurationError(
        'The auth module needs the notification module — add "notification" to MODULES_ENABLED.',
      );
    }

    const repository = createRepository(registration);
    const redis = container.resolve(TOKENS.Redis);
    const queue = container.resolve(SHARED_TOKENS.Queue);
    const passwords = new PasswordService();

    container.registerInstance(AUTH_REPOSITORY, repository);
    container.registerInstance(PasswordService, passwords);
    container.registerInstance(JwtService, new JwtService());
    container.registerInstance(SessionService, new SessionService(redis));
    container.registerInstance(LoginThrottle, new LoginThrottle(redis));
    container.registerInstance(
      MfaService,
      new MfaService(repository, redis, passwords, container.resolve(SHARED_TOKENS.QrCode)),
    );
    container.registerInstance(
      AuditService,
      new AuditService(queue, container.resolve(TOKENS.Logger)),
    );
    container.registerInstance(TOKENS.AuthGuard, container.resolve(JwtGuard));
    container.registerInstance(
      SHARED_TOKENS.SocketAuthenticator,
      container.resolve(JwtSocketAuthenticator),
    );

    registerAuditJob(queue, repository);
  },
};
