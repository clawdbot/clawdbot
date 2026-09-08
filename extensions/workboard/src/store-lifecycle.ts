import type { OpenClawPluginApi } from "../api.js";
import type { WorkboardStore } from "./store.js";

export function registerWorkboardStoreLifecycle(
  api: OpenClawPluginApi,
  store: WorkboardStore,
  stopServices?: () => void,
): void {
  const dispose = () => {
    // Stop producers before the store drains admitted work and closes its connection.
    stopServices?.();
    return store.close();
  };
  api.lifecycle.registerRuntimeLifecycle({
    id: "workboard-sqlite-store",
    dispose,
    cleanup: ({ reason, sessionKey, runId }) => {
      // Session cleanup shares this hook, but only registry retirement owns the whole store.
      if (
        sessionKey === undefined &&
        runId === undefined &&
        (reason === "disable" || reason === "restart")
      ) {
        return dispose();
      }
      return undefined;
    },
  });
}
