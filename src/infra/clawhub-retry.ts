// Defines the bounded retry contract shared by ClawHub runtime and release reads.
import { parseRetryAfterHeaderSeconds } from "./retry-after.js";
import { retryAsync } from "./retry.js";

const CLAWHUB_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const CLAWHUB_MAX_RETRY_AFTER_MS = 60_000;

type ClawHubResponseHandle = {
  response: Response;
};

type ClawHubRetryOptions<T extends ClawHubResponseHandle> = {
  disposeRetry: (result: T) => Promise<void>;
  retryRateLimit?: boolean;
  signal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
};

class RetryableClawHubResponse<T extends ClawHubResponseHandle> extends Error {
  constructor(readonly result: T) {
    super(`ClawHub request returned retryable status ${result.response.status}`);
  }
}

function isRetryableClawHubStatus(status: number, retryRateLimit: boolean): boolean {
  return (
    (retryRateLimit && status === 429) ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfterSeconds = parseRetryAfterHeaderSeconds(headers.get("retry-after"));
  if (retryAfterSeconds === undefined) {
    return undefined;
  }
  const delayMs = retryAfterSeconds * 1_000;
  return delayMs <= CLAWHUB_MAX_RETRY_AFTER_MS ? delayMs : undefined;
}

/**
 * Retries idempotent ClawHub reads on transient HTTP and transport failures.
 * Callers retain the final response so their existing body limits and errors apply.
 */
export async function retryClawHubRead<T extends ClawHubResponseHandle>(
  request: () => Promise<T>,
  options: ClawHubRetryOptions<T>,
): Promise<T> {
  try {
    return await retryAsync(
      async () => {
        options.signal?.throwIfAborted();
        const result = await request();
        if (isRetryableClawHubStatus(result.response.status, options.retryRateLimit === true)) {
          throw new RetryableClawHubResponse(result);
        }
        return result;
      },
      {
        attempts: CLAWHUB_RETRY_DELAYS_MS.length + 1,
        minDelayMs: 0,
        maxDelayMs: CLAWHUB_MAX_RETRY_AFTER_MS,
        delayMs: ({ attempt }) => CLAWHUB_RETRY_DELAYS_MS[attempt - 1] ?? 0,
        retryAfterMs: (error) =>
          error instanceof RetryableClawHubResponse
            ? parseRetryAfterMs(error.result.response.headers)
            : undefined,
        shouldRetry: () => options.signal?.aborted !== true,
        onRetry: async ({ err }) => {
          if (err instanceof RetryableClawHubResponse) {
            await options.disposeRetry(err.result);
          }
        },
        sleep: options.sleep,
      },
    );
  } catch (error) {
    // Callers own final HTTP error handling and therefore need the response.
    if (error instanceof RetryableClawHubResponse) {
      return error.result;
    }
    throw error;
  }
}
