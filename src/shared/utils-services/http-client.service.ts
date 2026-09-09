import { ServiceUnavailableError } from '@core/errors/app-error';

export interface HttpClientOptions {
  timeoutMs?: number;
  /** Total attempts, first one included. */
  attempts?: number;
  retryDelayMs?: number;
  /** Consecutive failures that trip the breaker for this host. */
  failureThreshold?: number;
  breakerResetMs?: number;
}

export interface HttpRequest {
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULTS = {
  timeoutMs: 10_000,
  attempts: 3,
  retryDelayMs: 200,
  failureThreshold: 5,
  breakerResetMs: 30_000,
} as const;

interface BreakerState {
  failures: number;
  openedAt: number | null;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 5xx and network errors are worth another try; a 400 will fail identically forever. */
function isRetryable(status: number): boolean {
  return status >= 500 || status === 429;
}

/**
 * Outbound HTTP with the three things a naked `fetch` lacks in production: a timeout, a
 * bounded retry, and a breaker that stops hammering a provider that is already down —
 * which is also what stops that provider's outage from becoming our own thread starvation.
 */
export class HttpClientService {
  private readonly breakers = new Map<string, BreakerState>();

  constructor(private readonly options: HttpClientOptions = {}) {}

  async request<T>(url: string, request: HttpRequest = {}): Promise<T> {
    const response = await this.send(url, request);

    return (await response.json()) as T;
  }

  async send(url: string, request: HttpRequest = {}): Promise<Response> {
    const host = new URL(url).host;
    this.assertBreakerClosed(host);

    const attempts = this.options.attempts ?? DEFAULTS.attempts;
    let lastError: unknown;

    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await this.sendOnce(url, request);

        if (!isRetryable(response.status)) {
          this.recordSuccess(host);
          return response;
        }

        lastError = new ServiceUnavailableError(`${url} answered ${String(response.status)}`);
      } catch (error) {
        lastError = error;
      }

      if (attempt < attempts - 1) {
        // Exponential backoff: retrying a struggling service at a fixed rate is how a blip
        // becomes an outage.
        await sleep((this.options.retryDelayMs ?? DEFAULTS.retryDelayMs) * 2 ** attempt);
      }
    }

    this.recordFailure(host);
    throw lastError;
  }

  private async sendOnce(url: string, request: HttpRequest): Promise<Response> {
    const timeoutMs = request.timeoutMs ?? this.options.timeoutMs ?? DEFAULTS.timeoutMs;
    const hasBody = request.body !== undefined;

    return fetch(url, {
      method: request.method ?? 'GET',
      headers: {
        ...(hasBody ? { 'content-type': 'application/json' } : {}),
        ...request.headers,
      },
      ...(hasBody ? { body: JSON.stringify(request.body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  }

  private assertBreakerClosed(host: string): void {
    const state = this.breakers.get(host);

    if (state?.openedAt == null) {
      return;
    }

    if (Date.now() - state.openedAt < (this.options.breakerResetMs ?? DEFAULTS.breakerResetMs)) {
      throw new ServiceUnavailableError(`Circuit open for ${host}`);
    }

    // Half-open: let the next call through and judge the provider on its answer.
    this.breakers.set(host, { failures: 0, openedAt: null });
  }

  private recordSuccess(host: string): void {
    this.breakers.delete(host);
  }

  private recordFailure(host: string): void {
    const failures = (this.breakers.get(host)?.failures ?? 0) + 1;
    const threshold = this.options.failureThreshold ?? DEFAULTS.failureThreshold;

    this.breakers.set(host, {
      failures,
      openedAt: failures >= threshold ? Date.now() : null,
    });
  }
}
