import { formatErrorMessage } from "../infra/errors.js";
import { findActiveUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRunPhase } from "../infra/update-run-record.js";
import { GATEWAY_EVENT_UPDATE_RUN_CHANGED } from "./events.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

const UPDATE_RUN_POLL_MS = 2_000;
const UPDATE_RUN_WATCH_LIMIT_MS = 45 * 60_000;
let wakeCurrentWatcher: (() => void) | undefined;

/** Wake the Gateway-owned watcher when this process admits an update. */
export function wakeUpdateRunWatcher(): void {
  wakeCurrentWatcher?.();
}

/** The update-check lifecycle owns polling and fences it before Gateway teardown. */
export function startUpdateRunWatcher(params: {
  broadcast: GatewayBroadcastFn;
  log: { warn: (message: string) => void };
}): { stop: () => void } {
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watched:
    | { runId: string; startedAtMs: number; revision?: number; phase?: UpdateRunPhase }
    | undefined;
  let notices = Promise.resolve();

  const poll = () => {
    if (stopped) {
      return;
    }
    timer = undefined;
    try {
      const run = watched ? getUpdateRun(watched.runId) : findActiveUpdateRun();
      if (!run) {
        watched = undefined;
        return;
      }
      watched ??= { runId: run.runId, startedAtMs: Date.now() };
      const expired = Date.now() - watched.startedAtMs >= UPDATE_RUN_WATCH_LIMIT_MS;
      const terminal = run.status !== "running";
      if (watched.revision !== run.updatedAtMs || terminal || expired) {
        params.broadcast(GATEWAY_EVENT_UPDATE_RUN_CHANGED, {
          runId: run.runId,
          phase: run.phase,
          status: run.status,
          updatedAtMs: run.updatedAtMs,
        });
        watched.revision = run.updatedAtMs;
      }
      if (watched.phase !== run.phase) {
        watched.phase = run.phase;
        // The command owns refusals before acknowledgement. Only an admitted
        // conversation with durable ack custody receives an automatic final notice.
        const acknowledged = run.steps.some(
          (step) => step.step === "notice:ack" && step.status === "completed",
        );
        if (run.phase === "activating" || (terminal && acknowledged)) {
          notices = notices
            .then(async () => {
              if (stopped) {
                return;
              }
              const { notifyUpdateRunPhase } = await import("./update-run-notice.runtime.js");
              if (!stopped) {
                await notifyUpdateRunPhase(run);
              }
            })
            .catch((error: unknown) => {
              params.log.warn(`update run notice failed: ${formatErrorMessage(error)}`);
            });
        }
      }
      if (terminal || expired) {
        watched = undefined;
        if (terminal) {
          poll();
        }
        return;
      }
      // Named freshness-poll exception: the detached orchestrator writes the
      // shared update ledger. Only active runs are polled, for at most 45 minutes.
      timer = setTimeout(poll, UPDATE_RUN_POLL_MS);
      timer.unref?.();
    } catch (error) {
      watched = undefined;
      params.log.warn(`update run watcher stopped: ${formatErrorMessage(error)}`);
    }
  };
  const wake = () => {
    if (!timer && !watched) {
      poll();
    }
  };
  wakeCurrentWatcher = wake;
  wake();
  return {
    stop: () => {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (wakeCurrentWatcher === wake) {
        wakeCurrentWatcher = undefined;
      }
    },
  };
}
