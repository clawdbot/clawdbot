const TELEGRAM_STARTUP_PROBE_CONCURRENCY = 2;

type StartupProbeSlot = () => void;

type StartupProbeWaiter = {
  resolve: (release: StartupProbeSlot) => void;
  reject: (error: Error) => void;
  abortSignal?: AbortSignal;
  onAbort?: () => void;
};

let activeStartupProbes = 0;
const pendingStartupProbeWaiters: StartupProbeWaiter[] = [];

function buildStartupProbeAbortError(): Error {
  return new Error("telegram startup probe wait aborted");
}

function detachAbortHandler(waiter: StartupProbeWaiter) {
  if (!waiter.abortSignal || !waiter.onAbort) {
    return;
  }
  waiter.abortSignal.removeEventListener("abort", waiter.onAbort);
}

function removePendingWaiter(waiter: StartupProbeWaiter) {
  const index = pendingStartupProbeWaiters.indexOf(waiter);
  if (index >= 0) {
    pendingStartupProbeWaiters.splice(index, 1);
  }
}

function releaseStartupProbeSlot() {
  activeStartupProbes = Math.max(0, activeStartupProbes - 1);
  drainStartupProbeWaiters();
}

function drainStartupProbeWaiters() {
  while (
    activeStartupProbes < TELEGRAM_STARTUP_PROBE_CONCURRENCY &&
    pendingStartupProbeWaiters.length > 0
  ) {
    const waiter = pendingStartupProbeWaiters.shift();
    if (!waiter) {
      return;
    }
    detachAbortHandler(waiter);
    if (waiter.abortSignal?.aborted) {
      waiter.reject(buildStartupProbeAbortError());
      continue;
    }
    activeStartupProbes += 1;
    waiter.resolve(releaseStartupProbeSlot);
  }
}

async function acquireStartupProbeSlot(abortSignal?: AbortSignal): Promise<StartupProbeSlot> {
  if (abortSignal?.aborted) {
    throw buildStartupProbeAbortError();
  }
  if (activeStartupProbes < TELEGRAM_STARTUP_PROBE_CONCURRENCY) {
    activeStartupProbes += 1;
    return releaseStartupProbeSlot;
  }
  return await new Promise<StartupProbeSlot>((resolve, reject) => {
    const waiter: StartupProbeWaiter = {
      resolve,
      reject,
      ...(abortSignal ? { abortSignal } : {}),
    };
    waiter.onAbort = () => {
      removePendingWaiter(waiter);
      reject(buildStartupProbeAbortError());
    };
    abortSignal?.addEventListener("abort", waiter.onAbort, { once: true });
    pendingStartupProbeWaiters.push(waiter);
  });
}

export async function withTelegramStartupProbeSlot<T>(
  abortSignal: AbortSignal | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const release = await acquireStartupProbeSlot(abortSignal);
  try {
    if (abortSignal?.aborted) {
      throw buildStartupProbeAbortError();
    }
    return await run();
  } finally {
    release();
  }
}

export function resetTelegramStartupProbeLimiterForTests() {
  activeStartupProbes = 0;
  const pending = pendingStartupProbeWaiters.splice(0);
  for (const waiter of pending) {
    detachAbortHandler(waiter);
    waiter.reject(buildStartupProbeAbortError());
  }
}
