import { createDedupeCache } from "../../runtime-api.js";

type ProcessedMessageTracker = {
  claim: (id?: string | null) => { kind: "claimed" } | { kind: "duplicate" };
  commit: (id?: string | null) => void;
  release: (id?: string | null) => void;
  mark: (id?: string | null) => boolean;
  has: (id?: string | null) => boolean;
  size: () => number;
};

export function createProcessedMessageTracker(limit = 2000): ProcessedMessageTracker {
  const dedupe = createDedupeCache({ ttlMs: 0, maxSize: limit });
  const inFlight = new Set<string>();

  const claim = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return { kind: "claimed" } as const;
    }
    if (inFlight.has(trimmed) || dedupe.peek(trimmed)) {
      return { kind: "duplicate" } as const;
    }
    inFlight.add(trimmed);
    return { kind: "claimed" } as const;
  };

  const commit = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return;
    }
    inFlight.delete(trimmed);
    dedupe.check(trimmed);
  };

  const release = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return;
    }
    inFlight.delete(trimmed);
  };

  const mark = (id?: string | null) => {
    const claimed = claim(id);
    if (claimed.kind === "duplicate") {
      return false;
    }
    commit(id);
    return true;
  };

  const has = (id?: string | null) => {
    const trimmed = id?.trim();
    if (!trimmed) {
      return false;
    }
    return dedupe.peek(trimmed);
  };

  return {
    claim,
    commit,
    release,
    mark,
    has,
    size: () => dedupe.size(),
  };
}

export async function runWithProcessedMessageClaim<T>(params: {
  tracker: ProcessedMessageTracker;
  id?: string | null;
  task: () => Promise<T>;
}): Promise<{ kind: "processed"; value: T } | { kind: "duplicate" }> {
  const claim = params.tracker.claim(params.id);
  if (claim.kind === "duplicate") {
    return claim;
  }
  try {
    const value = await params.task();
    params.tracker.commit(params.id);
    return { kind: "processed", value };
  } catch (error) {
    params.tracker.release(params.id);
    throw error;
  }
}
