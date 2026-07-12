// Defines the bounded retry contract shared by ClawHub runtime and release reads.
import { parseRetryAfterHttpDateMs } from "../../packages/ai/src/internal/retry-after.js";

const CLAWHUB_RETRY_DELAYS_MS = [1_000, 3_000, 10_000] as const;
const CLAWHUB_MAX_RETRY_AFTER_MS = 60_000;

type ClawHubResponseHandle = {
  response: Response;
};

type ClawHubRetryOptions<T extends ClawHubResponseHandle> = {
  disposeRetry: (result: T) => Promise<void>;
  retryRateLimit?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

function isRetryableClawHubStatus(status: number, retryRateLimit: boolean): boolean {
  return (retryRateLimit && status === 429) || status === 502 || status === 503 || status === 504;
}

function parseRetryAfterMs(headers: Headers): number | undefined {
  const retryAfter = headers.get("retry-after")?.trim();
  if (!retryAfter) {
    return undefined;
  }
  if (/^\d+$/.test(retryAfter)) {
    const seconds = Number(retryAfter);
    const delayMs = Math.round(seconds * 1_000);
    return delayMs <= CLAWHUB_MAX_RETRY_AFTER_MS ? delayMs : undefined;
  }
  const retryAt = parseRetryAfterHttpDateMs(retryAfter);
  if (retryAt === undefined) {
    return undefined;
  }
  const delayMs = Math.max(0, retryAt - Date.now());
  return delayMs <= CLAWHUB_MAX_RETRY_AFTER_MS ? delayMs : undefined;
}

function retryDelayMs(response: Response | undefined, attempt: number): number {
  return (
    (response ? parseRetryAfterMs(response.headers) : undefined) ??
    CLAWHUB_RETRY_DELAYS_MS[attempt] ??
    0
  );
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Retries idempotent ClawHub reads on transient HTTP and transport failures.
 * Callers retain the final response so their existing body limits and errors apply.
 */
export async function retryClawHubRead<T extends ClawHubResponseHandle>(
  request: () => Promise<T>,
  options: ClawHubRetryOptions<T>,
): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    let result: T;
    try {
      result = await request();
    } catch (error) {
      if (attempt >= CLAWHUB_RETRY_DELAYS_MS.length) {
        throw error;
      }
      await (options.sleep ?? defaultSleep)(retryDelayMs(undefined, attempt));
      continue;
    }

    if (
      !isRetryableClawHubStatus(result.response.status, options.retryRateLimit === true) ||
      attempt >= CLAWHUB_RETRY_DELAYS_MS.length
    ) {
      return result;
    }

    const delayMs = retryDelayMs(result.response, attempt);
    await options.disposeRetry(result);
    await (options.sleep ?? defaultSleep)(delayMs);
  }
}
