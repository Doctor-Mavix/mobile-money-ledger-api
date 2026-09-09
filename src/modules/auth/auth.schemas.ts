import { z } from 'zod';

import { env } from '@core/config/env';

/**
 * Which actor types exist belongs to the generated project, so the schema only constrains the
 * shape. This project has two — `user`, who holds an account, and `agent`, who runs the back
 * office — and the default is the one a public sign-up form should not have to name.
 *
 * The template hard-codes `citizen` here, the actor type of the project it was extracted from.
 * Renaming a domain concept by editing a default inside a Zod schema is a template gap: it
 * belongs in configuration, not in a validation file every project has to remember to patch.
 */
const actorTypeSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]{1,30}$/, 'must be a lowercase actor type')
  .default('user');

const emailSchema = z.email().max(254);
const passwordSchema = z.string().min(env.PASSWORD_MIN_LENGTH).max(200);
const otpCodeSchema = z
  .string()
  .trim()
  .regex(/^\d{6}$/, 'must be a 6-digit code');

/** TOTP is 6 digits, a backup code is 10 hex characters — one field accepts either. */
const mfaCodeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[0-9a-f]{10})$/, 'must be a 6-digit code or a backup code');

export const registerSchema = z.strictObject({
  actorType: actorTypeSchema,
  email: emailSchema,
  password: passwordSchema,
  displayName: z.string().trim().min(2).max(120),
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9][0-9 .-]{6,19}$/, 'must be a phone number')
    .optional(),
});

export type RegisterBody = z.infer<typeof registerSchema>;

export const loginSchema = z.strictObject({
  actorType: actorTypeSchema,
  email: emailSchema,
  // Not `passwordSchema`: raising the minimum length must not make old passwords unusable,
  // and rejecting a short one here would leak the policy to anyone probing the form.
  password: z.string().min(1).max(200),
});

export type LoginBody = z.infer<typeof loginSchema>;

export const verifyEmailSchema = z.strictObject({
  actorType: actorTypeSchema,
  email: emailSchema,
  code: otpCodeSchema,
});

export type VerifyEmailBody = z.infer<typeof verifyEmailSchema>;

export const verifyMfaSchema = z.strictObject({
  challengeToken: z.uuid(),
  code: mfaCodeSchema,
});

export type VerifyMfaBody = z.infer<typeof verifyMfaSchema>;

export const refreshSchema = z.strictObject({
  refreshToken: z.string().min(20).max(200),
});

export type RefreshBody = z.infer<typeof refreshSchema>;

export const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

export type ChangePasswordBody = z.infer<typeof changePasswordSchema>;

export const requestPasswordResetSchema = z.strictObject({
  actorType: actorTypeSchema,
  email: emailSchema,
});

export type RequestPasswordResetBody = z.infer<typeof requestPasswordResetSchema>;

export const resetPasswordSchema = z.strictObject({
  actorType: actorTypeSchema,
  email: emailSchema,
  code: otpCodeSchema,
  newPassword: passwordSchema,
});

export type ResetPasswordBody = z.infer<typeof resetPasswordSchema>;

export const confirmMfaSchema = z.strictObject({
  code: otpCodeSchema,
});

export type ConfirmMfaBody = z.infer<typeof confirmMfaSchema>;

export const disableMfaSchema = z.strictObject({
  password: z.string().min(1).max(200),
  code: mfaCodeSchema,
});

export type DisableMfaBody = z.infer<typeof disableMfaSchema>;

export const sessionIdParamsSchema = z.strictObject({
  id: z.uuid(),
});
