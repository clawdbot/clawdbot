export type BundledRuntimeDepsInstallActivity = {
  id: number;
  installRoot: string;
  missingSpecs: string[];
  installSpecs: string[];
  pluginId?: string;
  startedAtMs: number;
};

type IdleWaiter = () => void;

let nextActivityId = 1;
const activeInstalls = new Map<number, BundledRuntimeDepsInstallActivity>();
const idleWaiters = new Set<IdleWaiter>();

function notifyIdleWaiters(): void {
  if (activeInstalls.size > 0) {
    return;
  }
  const waiters = [...idleWaiters];
  idleWaiters.clear();
  for (const waiter of waiters) {
    waiter();
  }
}

export function beginBundledRuntimeDepsInstall(params: {
  installRoot: string;
  missingSpecs: readonly string[];
  installSpecs?: readonly string[];
  pluginId?: string;
}): () => void {
  const id = nextActivityId++;
  activeInstalls.set(id, {
    id,
    installRoot: params.installRoot,
    missingSpecs: [...params.missingSpecs],
    installSpecs: [...(params.installSpecs ?? params.missingSpecs)],
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    startedAtMs: Date.now(),
  });
  let ended = false;
  return () => {
    if (ended) {
      return;
    }
    ended = true;
    activeInstalls.delete(id);
    notifyIdleWaiters();
  };
}

export function getActiveBundledRuntimeDepsInstallCount(): number {
  return activeInstalls.size;
}

export function listActiveBundledRuntimeDepsInstalls(): BundledRuntimeDepsInstallActivity[] {
  return [...activeInstalls.values()].toSorted((left, right) => left.id - right.id);
}

export async function waitForBundledRuntimeDepsInstallIdle(
  timeoutMs?: number,
): Promise<{ drained: boolean; active: number }> {
  if (activeInstalls.size === 0) {
    return { drained: true, active: 0 };
  }

  return await new Promise((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      idleWaiters.delete(onIdle);
    };
    const settle = (drained: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      resolve({ drained, active: activeInstalls.size });
    };
    const onIdle = () => settle(true);
    idleWaiters.add(onIdle);
    if (typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs >= 0) {
      timer = setTimeout(() => settle(false), Math.floor(timeoutMs));
      timer.unref?.();
    }
  });
}

export const __testing = {
  resetBundledRuntimeDepsInstallActivity(): void {
    activeInstalls.clear();
    notifyIdleWaiters();
    idleWaiters.clear();
    nextActivityId = 1;
  },
};
