import { formatErrorMessage } from "../infra/errors.js";
import { findActiveUpdateRun, getUpdateRun } from "../infra/update-run-ledger.js";
import type { UpdateRunPhase } from "../infra/update-run-record.js";
import { AsyncWorkScope } from "../shared/async-work-scope.js";
import { GATEWAY_EVENT_UPDATE_RUN_CHANGED } from "./events.js";
import type { GatewayBroadcastFn } from "./server-broadcast-types.js";

const UPDATE_RUN_POLL_MS = 2_000;
let wakeCurrentWatcher: (() => void) | undefined;

/** Wake the Gateway-owned watcher when this process admits an update. */
export function wakeUpdateRunWatcher(): void {
  wakeCurrentWatcher?.();
}

/** The update-check lifecycle joins notices and their transport tails before Gateway teardown. */
export function startUpdateRunWatcher(params: {
  broadcast: GatewayBroadcastFn;
  log: { warn: (message: string) => void };
}): { stop: () => Promise<void> } {
  const work = new AsyncWorkScope();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let watched: { runId: string; revision?: number; phase?: UpdateRunPhase } | undefined;
  let notices = Promise.resolve();

  const poll = () => {
    if (work.isClosing) {
      return;
    }
    timer = undefined;
    try {
      const run = watched ? getUpdateRun(watched.runId) : findActiveUpdateRun();
      if (!run) {
        watched = undefined;
        return;
      }
      watched ??= { runId: run.runId };
      const terminal = run.status !== "running";
      if (watched.revision !== run.updatedAtMs || terminal) {
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
          notices = work.track(() =>
            notices
              .then(async () => {
                if (work.isClosing) {
                  return;
                }
                const { notifyUpdateRunPhase } = await import("./update-run-notice.runtime.js");
                if (!work.isClosing) {
                  await notifyUpdateRunPhase(run);
                }
              })
              .catch((error: unknown) => {
                params.log.warn(`update run notice failed: ${formatErrorMessage(error)}`);
              }),
          );
        }
      }
      if (terminal) {
        watched = undefined;
        poll();
        return;
      }
      // Named freshness-poll exception: the detached orchestrator writes the
      // shared ledger. Observe one active run until terminal or teardown so a
      // late repair still clears the clients' update-in-progress state.
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
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (wakeCurrentWatcher === wake) {
        wakeCurrentWatcher = undefined;
      }
      return work.drain();
    },
  };
}
