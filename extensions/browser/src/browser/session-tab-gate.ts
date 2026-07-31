/** Serializes browser access with exclusive session cleanup. */

type BrowserSessionGate = {
  activeAccesses: number;
  cleanupActive: boolean;
  ownerClaimSequence: number;
  latestOwnerClaim?: { ownerId: string; sequence: number };
  accessWaiters: BrowserSessionAccessWaiter[];
  cleanupWaiters: Array<(release: () => void) => void>;
};

type BrowserSessionAccessWaiter = {
  resolve: (release: () => void) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
};

const browserSessionGates = new Map<string, BrowserSessionGate>();

function getBrowserSessionGate(sessionKey: string): BrowserSessionGate {
  const existing = browserSessionGates.get(sessionKey);
  if (existing) {
    return existing;
  }
  const gate: BrowserSessionGate = {
    activeAccesses: 0,
    cleanupActive: false,
    ownerClaimSequence: 0,
    accessWaiters: [],
    cleanupWaiters: [],
  };
  browserSessionGates.set(sessionKey, gate);
  return gate;
}

function pumpBrowserSessionGate(
  sessionKey: string,
  gate: BrowserSessionGate,
  hasTrackedTabs: (sessionKey: string) => boolean,
): void {
  if (gate.cleanupActive || gate.activeAccesses > 0) {
    return;
  }
  const cleanupWaiter = gate.cleanupWaiters.shift();
  if (cleanupWaiter) {
    gate.cleanupActive = true;
    cleanupWaiter(() => {
      if (!gate.cleanupActive) {
        return;
      }
      gate.cleanupActive = false;
      pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
    });
    return;
  }
  while (gate.accessWaiters.length > 0) {
    const waiter = gate.accessWaiters.shift();
    if (!waiter || waiter.signal?.aborted) {
      continue;
    }
    if (waiter.signal && waiter.onAbort) {
      waiter.signal.removeEventListener("abort", waiter.onAbort);
    }
    gate.activeAccesses += 1;
    let released = false;
    waiter.resolve(() => {
      if (released) {
        return;
      }
      released = true;
      gate.activeAccesses = Math.max(0, gate.activeAccesses - 1);
      pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
    });
  }
  if (
    gate.activeAccesses === 0 &&
    !gate.cleanupActive &&
    gate.accessWaiters.length === 0 &&
    gate.cleanupWaiters.length === 0 &&
    !gate.latestOwnerClaim &&
    !hasTrackedTabs(sessionKey)
  ) {
    browserSessionGates.delete(sessionKey);
  }
}

export function claimBrowserSessionOwner(sessionKey: string, ownerId: string): number {
  const gate = getBrowserSessionGate(sessionKey);
  const sequence = ++gate.ownerClaimSequence;
  gate.latestOwnerClaim = { ownerId, sequence };
  return sequence;
}

export function releaseBrowserSessionOwner(sessionKey: string, ownerId?: string): void {
  const gate = browserSessionGates.get(sessionKey);
  if (!gate?.latestOwnerClaim) {
    return;
  }
  if (ownerId !== undefined && gate.latestOwnerClaim.ownerId !== ownerId) {
    return;
  }
  gate.latestOwnerClaim = undefined;
  pumpBrowserSessionGate(sessionKey, gate, () => false);
}

export function isCurrentBrowserSessionOwnerClaim(params: {
  sessionKey: string;
  ownerId?: string;
  ownerClaim?: number;
}): boolean {
  if (params.ownerId === undefined || params.ownerClaim === undefined) {
    return true;
  }
  const latest = browserSessionGates.get(params.sessionKey)?.latestOwnerClaim;
  return (
    latest === undefined ||
    (latest.ownerId === params.ownerId && latest.sequence === params.ownerClaim)
  );
}

export function acquireBrowserSessionAccess(
  sessionKey: string,
  hasTrackedTabs: (sessionKey: string) => boolean,
  signal?: AbortSignal,
): Promise<() => void> {
  signal?.throwIfAborted();
  const gate = getBrowserSessionGate(sessionKey);
  if (!gate.cleanupActive && gate.cleanupWaiters.length === 0) {
    gate.activeAccesses += 1;
    let released = false;
    return Promise.resolve(() => {
      if (released) {
        return;
      }
      released = true;
      gate.activeAccesses = Math.max(0, gate.activeAccesses - 1);
      pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
    });
  }
  return new Promise((resolve, reject) => {
    const waiter: BrowserSessionAccessWaiter = { resolve, reject, signal };
    const onAbort = () => {
      const index = gate.accessWaiters.indexOf(waiter);
      if (index >= 0) {
        gate.accessWaiters.splice(index, 1);
      }
      reject(signal?.reason);
      pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
    };
    waiter.onAbort = onAbort;
    gate.accessWaiters.push(waiter);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
    }
  });
}

export async function acquireBrowserSessionCleanup(
  sessionKeys: string[],
  hasTrackedTabs: (sessionKey: string) => boolean,
): Promise<() => void> {
  const releases: Array<() => void> = [];
  for (const sessionKey of [...new Set(sessionKeys)].toSorted()) {
    const gate = getBrowserSessionGate(sessionKey);
    releases.push(
      await new Promise<() => void>((resolve) => {
        gate.cleanupWaiters.push(resolve);
        pumpBrowserSessionGate(sessionKey, gate, hasTrackedTabs);
      }),
    );
  }
  return () => {
    for (const release of releases.toReversed()) {
      release();
    }
  };
}

export function resetBrowserSessionGatesForTests(): void {
  browserSessionGates.clear();
}
