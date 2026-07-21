import {
  getWorkboardState,
  stopWorkboardLifecycleRefresh,
  stopWorkboardLiveRefresh,
} from "./runtime.ts";
import type { WorkboardUiState } from "./types.ts";

export type WorkboardCapability = {
  readonly state: WorkboardUiState;
  readonly boardsReady: boolean;
  notify: () => void;
  setBoardsReady: (ready: boolean) => void;
  clearBoards: () => void;
  subscribe: (listener: () => void) => () => void;
  dispose: () => void;
};

export function createWorkboardCapability(): WorkboardCapability {
  const listeners = new Set<() => void>();
  let disposed = false;
  let boardsReady = false;
  const capability: WorkboardCapability = {
    get state() {
      return getWorkboardState(capability);
    },
    get boardsReady() {
      return boardsReady;
    },
    notify() {
      if (disposed) {
        return;
      }
      for (const listener of listeners) {
        listener();
      }
    },
    setBoardsReady(ready) {
      boardsReady = ready;
    },
    clearBoards() {
      const hadBoards = capability.state.boards.length > 0;
      const wasReady = boardsReady;
      boardsReady = false;
      capability.state.boards = [];
      if (hadBoards || wasReady) {
        capability.notify();
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
