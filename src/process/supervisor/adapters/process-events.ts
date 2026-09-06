import type { SpawnProcessAdapter } from "../types.js";

type ProcessEvents = Required<
  Pick<SpawnProcessAdapter<NodeJS.Signals | null>, "onExit" | "onError">
>;
type ErrorListener = Parameters<ProcessEvents["onError"]>[0];

/** Preserve terminal facts and startup errors until the transport owner subscribes. */
export function createProcessAdapterEvents() {
  let exit: { code: number | null; signal: NodeJS.Signals | null } | undefined;
  const exitListeners = new Set<Parameters<ProcessEvents["onExit"]>[0]>();
  const errorListeners = new Set<ErrorListener>();
  const pendingErrors = new Map<Parameters<ErrorListener>[1], Error>();
  return {
    onExit: (listener: Parameters<ProcessEvents["onExit"]>[0]) => {
      exitListeners.add(listener);
      if (exit) {
        listener(exit.code, exit.signal);
      }
    },
    onError: (listener: ErrorListener) => {
      errorListeners.add(listener);
      for (const [source, error] of pendingErrors) {
        listener(error, source);
      }
      pendingErrors.clear();
    },
    emitExit: (code: number | null, signal: NodeJS.Signals | null) => {
      exit = { code, signal };
      for (const listener of exitListeners) {
        listener(code, signal);
      }
    },
    emitError: (error: Error, source: Parameters<ErrorListener>[1]) => {
      if (errorListeners.size === 0) {
        if (!pendingErrors.has(source)) {
          pendingErrors.set(source, error);
        }
      } else {
        for (const listener of errorListeners) {
          listener(error, source);
        }
      }
    },
    clear: () => {
      exitListeners.clear();
      errorListeners.clear();
      pendingErrors.clear();
    },
  };
}
