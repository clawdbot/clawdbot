import { resolveGatewayStartupRetryAfterMs } from "@openclaw/gateway-client/browser";

type GatewayStartupRetryOptions<T> = {
  retryWindowMs: number;
  request: (remainingMs: number) => Promise<T>;
  requestFailure: (error: unknown) => Error;
  retryDeadlineMessage: string;
};

function waitForGatewayStartupRetry(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    globalThis.setTimeout(resolve, delayMs);
  });
}

export async function retryGatewayStartupRequest<T>({
  retryWindowMs,
  request,
  requestFailure,
  retryDeadlineMessage,
}: GatewayStartupRetryOptions<T>): Promise<T> {
  const deadlineAt = Date.now() + retryWindowMs;
  let latestStartupError: Error | undefined;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw latestStartupError ?? new Error(retryDeadlineMessage);
    }

    try {
      return await request(remainingMs);
    } catch (error) {
      const requestError = error instanceof Error ? error : requestFailure(error);
      const retryAfterMs = resolveGatewayStartupRetryAfterMs(requestError);
      if (retryAfterMs === null) {
        throw requestError;
      }

      const retryRemainingMs = deadlineAt - Date.now();
      if (retryRemainingMs <= 0) {
        throw requestError;
      }

      latestStartupError = requestError;
      await waitForGatewayStartupRetry(Math.min(retryAfterMs, retryRemainingMs));
    }
  }
}
