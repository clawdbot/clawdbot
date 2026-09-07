import type { WorkboardChange } from "@openclaw/workboard-contract";
import type { OpenClawPluginService } from "../api.js";
import type { WorkboardStore } from "./store.js";

const WORKBOARD_EXTERNAL_CHANGE_CHECK_MS = 1000;
const WORKBOARD_RETENTION_RETRY_MS = 60_000;

export function createWorkboardChangeEventService(
  store: WorkboardStore,
): OpenClawPluginService & { stop: () => void } {
  let unsubscribe: (() => void) | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let starting: symbol | undefined;
  let retentionRunning = false;

  return {
    id: "workboard-change-events",
    async start(ctx) {
      if (timer || starting) {
        return;
      }
      const generation = Symbol("workboard-change-events-start");
      starting = generation;
      try {
        await store.reconcileArtifactRetention();
      } catch (error) {
        if (starting === generation) {
          starting = undefined;
        }
        throw error;
      }
      // stop() revokes pending startup before the owning SQLite store is closed.
      if (starting !== generation) {
        return;
      }
      starting = undefined;
      const gatewayEvents = ctx.gatewayEvents;
      if (gatewayEvents) {
        const emit = (change: WorkboardChange) => {
          gatewayEvents.emit("changed", change, { scope: "operator.read" });
        };
        unsubscribe = store.subscribeChanges(emit);
        store.announceChangeEpoch();
      }
      let nextRetentionAt = Date.now() + WORKBOARD_RETENTION_RETRY_MS;
      timer = setInterval(() => {
        try {
          store.reconcileExternalChanges();
        } catch (error) {
          ctx.logger.warn(`workboard external change check failed: ${String(error)}`);
        }
        if (!retentionRunning && Date.now() >= nextRetentionAt) {
          nextRetentionAt = Date.now() + WORKBOARD_RETENTION_RETRY_MS;
          retentionRunning = true;
          void store
            .reconcileArtifactRetention()
            .catch((error: unknown) => {
              ctx.logger.warn(`workboard artifact retention retry failed: ${String(error)}`);
            })
            .finally(() => {
              retentionRunning = false;
            });
        }
      }, WORKBOARD_EXTERNAL_CHANGE_CHECK_MS);
      timer.unref?.();
    },
    stop() {
      starting = undefined;
      unsubscribe?.();
      unsubscribe = undefined;
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
    },
  };
}
