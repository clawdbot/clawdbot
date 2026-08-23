import { resolveGlobalMap } from "../shared/global-singleton.js";

export type ForegroundReplyFenceState = {
  generation: number;
  visibleDeliveryGeneration: number;
  activeDispatches: number;
  activeGenerations: Map<number, number>;
  suspendedGenerations: Set<number>;
  waiters: Set<() => void>;
};

export function notifyForegroundReplyFenceWaiters(state: ForegroundReplyFenceState): void {
  const waiters = [...state.waiters];
  state.waiters.clear();
  for (const resolve of waiters) {
    resolve();
  }
}

export const foregroundReplyFenceByKey = resolveGlobalMap<string, ForegroundReplyFenceState>(
  Symbol.for("openclaw.foregroundReplyFences"),
  (fences) => {
    for (const state of fences.values()) {
      notifyForegroundReplyFenceWaiters(state);
    }
    fences.clear();
  },
  "close-only",
);
