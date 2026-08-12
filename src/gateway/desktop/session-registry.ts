import type { RfbAttachment } from "./attachment.js";

const DEFAULT_LINGER_MS = 60_000;
const MAX_OBSERVERS = 8;

export class DesktopSessionStaleOwnerError extends Error {
  constructor() {
    super("Desktop session owner epoch is stale");
    this.name = "DesktopSessionStaleOwnerError";
  }
}

export class DesktopSessionStoppedError extends Error {
  constructor() {
    super("Desktop session stopped before connecting");
    this.name = "DesktopSessionStoppedError";
  }
}

type DesktopSessionObserver = {
  control: boolean;
  /** Epoch the observer token was minted against; a stale token must not reach a newer entry. */
  ownerEpoch: number;
  close(code: number, reason: string): void;
};

type DesktopSessionAcquireResult = {
  attachment: RfbAttachment;
  vncPassword?: string;
};

type DesktopSessionAcquireRequest = {
  sourceKey: string;
  ownerEpoch: number;
  start: (isCurrent: () => boolean) => Promise<DesktopSessionAcquireResult>;
  teardown?: () => Promise<void>;
};

type ObserverEntry = DesktopSessionObserver & { released: boolean };
type DesktopSessionEntry = {
  sourceKey: string;
  ownerEpoch: number;
  initialization?: Promise<void>;
  stopPromise?: Promise<void>;
  ready: Promise<DesktopSessionAcquireResult>;
  resolveReady: (result: DesktopSessionAcquireResult) => void;
  rejectReady: (error: Error) => void;
  readySettled: boolean;
  observers: Set<ObserverEntry>;
  controller?: ObserverEntry;
  lingerTimer?: ReturnType<typeof setTimeout>;
  stopped: boolean;
  start: DesktopSessionAcquireRequest["start"];
  teardown?: DesktopSessionAcquireRequest["teardown"];
};

/** Owns per-source desktop sessions and their connected observer lifetimes. */
export function createDesktopSessionRegistry(
  deps: {
    lingerMs?: number;
  } = {},
) {
  const lingerMs = deps.lingerMs ?? DEFAULT_LINGER_MS;
  const entries = new Map<string, DesktopSessionEntry>();
  const claimedOwnerEpochs = new Map<string, number>();

  const claimOwnerEpoch = (sourceKey: string, ownerEpoch: number): boolean => {
    const claimedEpoch = claimedOwnerEpochs.get(sourceKey);
    if (claimedEpoch !== undefined && ownerEpoch < claimedEpoch) {
      throw new DesktopSessionStaleOwnerError();
    }
    if (claimedEpoch === undefined || ownerEpoch > claimedEpoch) {
      claimedOwnerEpochs.set(sourceKey, ownerEpoch);
      return true;
    }
    return false;
  };

  const isCurrent = (entry: DesktopSessionEntry) =>
    entries.get(entry.sourceKey) === entry && !entry.stopped;

  const closeObserver = (observer: ObserverEntry, code: number, reason: string) => {
    try {
      observer.close(code, reason);
    } catch {
      // Observer cleanup remains authoritative when the transport close callback fails.
    }
  };

  const stopEntry = (entry: DesktopSessionEntry): Promise<void> => {
    if (entry.stopPromise) {
      return entry.stopPromise;
    }
    entry.stopPromise = (async () => {
      entry.stopped = true;
      if (entries.get(entry.sourceKey) === entry) {
        entries.delete(entry.sourceKey);
      }
      clearTimeout(entry.lingerTimer);
      entry.lingerTimer = undefined;
      for (const observer of entry.observers) {
        observer.released = true;
        closeObserver(observer, 1012, "desktop tunnel closed");
      }
      entry.observers.clear();
      entry.controller = undefined;
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(new DesktopSessionStoppedError());
      }
      // Teardown brackets initialization so a source can stop the currently published
      // transport, then dispose anything initialization publishes before it settles.
      await entry.teardown?.().catch(() => undefined);
      await entry.initialization?.catch(() => undefined);
      await entry.teardown?.().catch(() => undefined);
    })();
    return entry.stopPromise;
  };

  async function acquire(
    request: DesktopSessionAcquireRequest,
  ): Promise<DesktopSessionAcquireResult> {
    claimOwnerEpoch(request.sourceKey, request.ownerEpoch);
    const current = entries.get(request.sourceKey);
    if (current) {
      if (request.ownerEpoch < current.ownerEpoch) {
        throw new DesktopSessionStaleOwnerError();
      }
      if (request.ownerEpoch === current.ownerEpoch) {
        return await current.ready;
      }
    }

    let resolveReady!: (result: DesktopSessionAcquireResult) => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<DesktopSessionAcquireResult>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    void ready.catch(() => undefined);
    const entry: DesktopSessionEntry = {
      sourceKey: request.sourceKey,
      ownerEpoch: request.ownerEpoch,
      ready,
      resolveReady,
      rejectReady,
      readySettled: false,
      observers: new Set(),
      stopped: false,
      start: request.start,
      ...(request.teardown ? { teardown: request.teardown } : {}),
    };
    entries.set(request.sourceKey, entry);
    entry.initialization = (async () => {
      if (current) {
        await stopEntry(current);
      }
      if (!isCurrent(entry)) {
        return;
      }
      const result = await entry.start(() => isCurrent(entry));
      if (!isCurrent(entry)) {
        return;
      }
      entry.readySettled = true;
      entry.resolveReady(result);
    })();
    void entry.initialization.catch((error: unknown) => {
      if (!entry.readySettled) {
        entry.readySettled = true;
        entry.rejectReady(error instanceof Error ? error : new Error("Desktop session failed"));
      }
      void stopEntry(entry);
    });
    return await ready;
  }

  function attachObserver(sourceKey: string, observer: DesktopSessionObserver) {
    const entry = entries.get(sourceKey);
    if (!entry || !entry.readySettled || entry.stopped || entry.observers.size >= MAX_OBSERVERS) {
      return undefined;
    }
    // A token minted against a replaced entry must not reach this one; otherwise a stale
    // control token would evict the current controller of a desktop it never observed.
    if (observer.ownerEpoch !== entry.ownerEpoch) {
      return undefined;
    }
    clearTimeout(entry.lingerTimer);
    entry.lingerTimer = undefined;
    if (observer.control && entry.controller) {
      const previous = entry.controller;
      previous.released = true;
      entry.observers.delete(previous);
      entry.controller = undefined;
      closeObserver(previous, 4000, "control-taken");
    }
    const attached: ObserverEntry = { ...observer, released: false };
    entry.observers.add(attached);
    if (attached.control) {
      entry.controller = attached;
    }
    return {
      release() {
        if (attached.released) {
          return;
        }
        attached.released = true;
        entry.observers.delete(attached);
        if (entry.controller === attached) {
          entry.controller = undefined;
        }
        if (entry.observers.size === 0 && isCurrent(entry)) {
          entry.lingerTimer = setTimeout(() => void stopEntry(entry), lingerMs);
          entry.lingerTimer.unref?.();
        }
      },
    };
  }

  async function stop(sourceKey: string, ownerEpoch?: number): Promise<void> {
    const entry = entries.get(sourceKey);
    if (entry && (ownerEpoch === undefined || ownerEpoch === entry.ownerEpoch)) {
      await stopEntry(entry);
    }
  }

  /**
   * Retires only owners strictly older than the claimant. An equal epoch shares the
   * session, so fencing must not tear down a peer that claimed the same generation.
   */
  async function stopSuperseded(sourceKey: string, ownerEpoch: number): Promise<void> {
    const entry = entries.get(sourceKey);
    if (entry && entry.ownerEpoch < ownerEpoch) {
      await stopEntry(entry);
    }
  }

  async function stopAll(): Promise<void> {
    await Promise.all([...entries.values()].map(stopEntry));
  }

  return {
    acquire,
    attachObserver,
    claimOwnerEpoch,
    isOwnerEpochCurrent: (sourceKey: string, ownerEpoch: number) =>
      claimedOwnerEpochs.get(sourceKey) === ownerEpoch,
    stop,
    stopSuperseded,
    stopAll,
  };
}

export type DesktopSessionRegistry = ReturnType<typeof createDesktopSessionRegistry>;
