import type { IncomingHttpHeaders } from 'node:http';

import { z } from 'zod';

import { BadRequestError } from '@core/errors/app-error';
import { amountSchema } from '@shared/money/money';

/**
 * A TOTP code or one of the ten backup codes — the same pair the login challenge accepts, so a
 * holder who lost their phone can still move their own money.
 */
const mfaCodeSchema = z
  .string()
  .trim()
  .regex(/^(\d{6}|[0-9a-f]{10})$/, 'must be a 6-digit code or a backup code');

const referenceSchema = z.string().trim().min(1).max(140).nullable().default(null);

export const transferSchema = z.strictObject({
  sourceWalletId: z.uuid(),
  targetWalletId: z.uuid(),
  amount: amountSchema,
  mfaCode: mfaCodeSchema,
  reference: referenceSchema,
});

export const cashMovementSchema = z.strictObject({
  walletId: z.uuid(),
  amount: amountSchema,
  mfaCode: mfaCodeSchema,
  reference: referenceSchema,
});

/**
 * Opaque to the server: it only has to be stable for one logical request and unguessable enough
 * that two clients do not collide. Bounded so it cannot be used as free storage on the index.
 */
const idempotencyKeySchema = z
  .string()
  .trim()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9._:-]+$/, 'must contain only letters, digits and . _ : -');

const IDEMPOTENCY_HEADER = 'idempotency-key';

/**
 * Read here rather than through `@Validate`, which covers body, query and params but not
 * headers. Keeping the key in the header is what makes it a property of the *delivery* of the
 * request rather than of its content: a proxy or an SDK can add it without touching the body.
 *
 * That the decorator has no `headers` slot is a template gap — every idempotent endpoint has to
 * reach into `req.headers` by hand and validate it itself.
 */
export function requireIdempotencyKey(req: { headers: IncomingHttpHeaders }): string {
  const raw = req.headers[IDEMPOTENCY_HEADER];
  const result = idempotencyKeySchema.safeParse(typeof raw === 'string' ? raw : undefined);

  if (!result.success) {
    throw new BadRequestError(
      'This endpoint needs an "Idempotency-Key" header: 8 to 200 characters of letters, ' +
        'digits and . _ : -',
    );
  }

  return result.data;
}
