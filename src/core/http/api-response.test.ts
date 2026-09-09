import { describe, expect, it } from 'vitest';

import { ErrorCode } from '@core/errors/error-codes';
import { ApiPayload, errorBody, successBody } from '@core/http/api-response';

describe('successBody', () => {
  it('omits optional keys instead of emitting undefined values', () => {
    expect(successBody({ id: 1 })).toEqual({ success: true, data: { id: 1 } });
  });

  it('includes message, meta and requestId when provided', () => {
    const body = successBody([1, 2], {
      message: 'listed',
      meta: { total: 2 },
      requestId: 'req-1',
    });

    expect(body).toEqual({
      success: true,
      data: [1, 2],
      message: 'listed',
      meta: { total: 2 },
      requestId: 'req-1',
    });
  });
});

describe('errorBody', () => {
  it('nests the code and message under `error`', () => {
    const body = errorBody({ code: ErrorCode.NOT_FOUND, message: 'missing' });

    expect(body).toEqual({ success: false, error: { code: 'NOT_FOUND', message: 'missing' } });
  });
});

describe('ApiPayload', () => {
  it('carries the envelope options chosen by the controller', () => {
    const payload = ApiPayload.of({ id: 1 }, { status: 202, message: 'accepted' });

    expect(payload.data).toEqual({ id: 1 });
    expect(payload.options).toEqual({ status: 202, message: 'accepted' });
  });

  it('defaults to empty options', () => {
    expect(ApiPayload.of('x').options).toEqual({});
  });
});
