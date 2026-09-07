import { createPermitPool } from "openclaw/plugin-sdk/concurrency-runtime";

const TELEGRAM_STARTUP_PROBE_CONCURRENCY = 2;
const startupProbePermits = createPermitPool(TELEGRAM_STARTUP_PROBE_CONCURRENCY);

function buildStartupProbeAbortError(): Error {
  return new Error("telegram startup probe wait aborted");
}

export async function withTelegramStartupProbeSlot<T>(
  abortSignal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const release = await startupProbePermits.acquire({ signal: abortSignal });
  if (!release) {
    throw buildStartupProbeAbortError();
  }
  try {
    if (abortSignal?.aborted) {
      throw buildStartupProbeAbortError();
    }
    return await run();
  } finally {
    release();
  }
}
