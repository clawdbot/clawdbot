import { apiThrottler } from "./bot.runtime.js";

type ApiThrottlerTransformer = ReturnType<typeof apiThrottler>;

const throttlerByToken = new Map<string, ApiThrottlerTransformer>();

export function getOrCreateAccountThrottler(
  token: string,
  createThrottler: () => ApiThrottlerTransformer = apiThrottler,
): ApiThrottlerTransformer {
  let throttler = throttlerByToken.get(token);
  if (!throttler) {
    throttler = createThrottler();
    throttlerByToken.set(token, throttler);
  }
  return throttler;
}

export function clearAccountThrottlersForTest(): void {
  throttlerByToken.clear();
}
