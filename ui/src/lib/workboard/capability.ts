import {
  getWorkboardState,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
} from "./runtime.ts";
import type { WorkboardUiState } from "./types.ts";

export type WorkboardCapability = {
  readonly state: WorkboardUiState;
  notify: () => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export function createWorkboardCapability(): WorkboardCapability {
  const listeners = new Set<() => void>();
  let disposed = false;
  const capability: WorkboardCapability = {
    get state() {
      return getWorkboardState(capability);
    },
    notify() {
      if (disposed) {
        return;
      }
      for (const listener of listeners) {
        listener();
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      stopWorkboardLiveRefresh(capability);
      stopWorkboardLifecycleRefresh(capability);
      listeners.clear();
    },
  };
  return capability;
}
