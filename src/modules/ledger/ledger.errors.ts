import { AppError } from '@core/errors/app-error';
import { ErrorCode } from '@core/errors/error-codes';
import { HttpStatus } from '@core/http/http-status';
import { formatMoney } from '@shared/money/money';
import type { Currency } from '@shared/money/money';

/**
 * 422 rather than 409: the request was understood and is well formed, it is the state of the
 * account that refuses it. A 409 would invite a client to retry, which will fail identically
 * until money arrives.
 *
 * The available balance is disclosed because the caller owns the wallet and can read it from
 * `GET /wallets` anyway; withholding it here would only cost the client a round trip.
 */
export class InsufficientFundsError extends AppError {
  constructor(available: bigint, requested: bigint, currency: Currency) {
    super(
      `This wallet holds ${formatMoney(available, currency)} and the transfer needs ` +
        formatMoney(requested, currency),
      HttpStatus.UNPROCESSABLE_ENTITY,
      {
        code: ErrorCode.INSUFFICIENT_FUNDS,
        details: {
          available: available.toString(),
          requested: requested.toString(),
          currency,
        },
      },
    );
  }
}
