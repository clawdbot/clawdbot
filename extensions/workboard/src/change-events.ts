import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;

export function createWorkboardChangeEventService(store: WorkboardStore): OpenClawPluginService {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  return {
    id: "workboard-change-events",
    start(ctx) {
      const gatewayEvents = ctx.gatewayEvents;
      if (!gatewayEvents) {
        return;
      }
      const emit = (change: WorkboardChange) => {
        gatewayEvents.emit("changed", change, {
          scope: "operator.read",
        });
      };
      unsubscribe = store.subscribeChanges(emit);
      store.announceChangeEpoch();
      timer = setInterval(() => {
        try {
          store.reconcileExternalChanges();
        } catch (error) {
          ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
        }
      }, WORKBOARD_EXTERNAL_CHANGE_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
