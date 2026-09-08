import {
  resumeScheduledTaskAutoStartAfterUpdate,
  suspendScheduledTaskAutoStartForUpdate,
} from "../../daemon/schtasks.js";
import { finishUpdateRun } from "../../infra/update-run-ledger.js";
import { defaultRuntime } from "../../runtime.js";
import {
  registerSignalExitBarrier,
  registerSignalExitGate,
  waitForSignalExitBarriers,
} from "../signal-exit-barrier.js";
import type { UpdateCommandOptions } from "./shared.js";

export class UpdateCommandAbort extends Error {
  constructor() {
    super("openclaw-update-abort");
    this.name = "UpdateCommandAbort";
  }
}

export type WindowsTaskAutoStartRecovery = {
  suspended: Promise<boolean>;
  beginMutation: () => void;
  restore: (
    restartSafe?: boolean,
    guard?: () => Promise<void>,
    assertCurrent?: () => void,
  ) => Promise<void>;
  handoff: (guard: () => Promise<void>) => void;
  complete: (restartSafe?: boolean) => Promise<void>;
  interrupted: () => boolean;
};

export function createWindowsTaskAutoStartRecovery(params: {
  serviceEnv: NodeJS.ProcessEnv;
  assertCurrentService?: () => Promise<void>;
  assertCurrent?: () => void;
  alreadySuspended?: true;
  updateRun?: UpdateCommandOptions["run"];
}): WindowsTaskAutoStartRecovery {
  let guard = params.assertCurrentService;
  let restorePromise: Promise<void> | undefined;
  let settlement: Promise<void> | undefined;
  let restoreAllowed = !params.alreadySuspended;
  let restorationAttempted = false;
  let restorationFailed = false;
  let delegated = false;
  let closed = false;
  let interrupted = false;
  let unregisterSignalExitBarrier = () => {};
  let finishUpdate: (() => void) | undefined;
  const updateFinished = new Promise<void>((resolve) => {
    finishUpdate = resolve;
  });
  const unregisterSignalExitGate = registerSignalExitGate(updateFinished);
  const onSignal = (exitCode: number) => {
    interrupted = true;
    void waitForSignalExitBarriers()
      .catch((error: unknown) => {
        defaultRuntime.error(`Failed to complete update shutdown cleanup: ${String(error)}`);
      })
      .finally(() => process.exit(exitCode));
  };
  const onSigint = () => onSignal(130);
  const onSigterm = () => onSignal(143);
  const onSigbreak = () => onSignal(130);
  const removeSignalHandlers = () => {
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("SIGBREAK", onSigbreak);
    unregisterSignalExitBarrier();
  };
  const restore = (
    restartSafe?: boolean,
    currentGuard?: () => Promise<void>,
    assertCurrent?: () => void,
  ) => {
    if (closed || delegated) {
      return Promise.resolve();
    }
    if (restartSafe === true) {
      restoreAllowed = true;
    }
    guard = currentGuard ?? guard;
    restorePromise ??= suspensionPromise
      .then(async (suspended) => {
        if (!suspended || !restoreAllowed || closed) {
          return;
        }
        await resumeScheduledTaskAutoStartAfterUpdate(params.serviceEnv, {
          beforeMutation: async () => {
            params.assertCurrent?.();
            await guard?.();
            params.assertCurrent?.();
            // Repair cancellation fences activation, while compensation retains its service guard.
            assertCurrent?.();
            if (closed || !restoreAllowed) {
              throw new Error("Windows task restoration authority has closed.");
            }
            // A failed /ENABLE may already have committed. Keep compensation until
            // the entire activation and verification outcome is settled.
            restorationAttempted = true;
          },
        });
      })
      .catch((error: unknown) => {
        restorationFailed = true;
        throw error;
      });
    return restorePromise;
  };
  const complete = (restartSafe = true) => {
    if (settlement) {
      // The settling owner reports native failure once; retained cleanup handles
      // still drain it without replacing that already-reported outcome.
      return settlement.catch(() => undefined);
    }
    const recordInterruption = interrupted && (restoreAllowed || restorationFailed);
    closed = true;
    restoreAllowed = false;
    settlement = (async () => {
      await restorePromise?.catch(() => undefined);
      if (!restartSafe && restorationAttempted && (await suspensionPromise.catch(() => false))) {
        await suspendScheduledTaskAutoStartForUpdate(params.serviceEnv, {
          beforeMutation: guard,
          // Failed verification removed the original safety proof. A timed-out
          // /DISABLE must never be compensated by enabling that installation.
          restoreOnFailure: false,
        });
      }
    })().finally(() => {
      try {
        if (finishUpdate && recordInterruption && params.updateRun) {
          const failed = restorationFailed || !restartSafe;
          finishUpdateRun(
            params.updateRun.runId,
            {
              status: failed ? "failed" : "skipped",
              reason: restorationFailed
                ? "windows-task-autostart-restore-failed"
                : failed
                  ? "update-failed"
                  : "cancelled",
            },
            { env: params.updateRun.env },
          );
        }
      } finally {
        removeSignalHandlers();
        finishUpdate?.();
        finishUpdate = undefined;
        unregisterSignalExitGate();
      }
    });
    return settlement;
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("SIGBREAK", onSigbreak);
  unregisterSignalExitBarrier = registerSignalExitBarrier(restore);
  // The parent retains failed-handoff compensation; the fresh worker adopts
  // this observed suspension and enables only at its activation boundary.
  const suspensionPromise = params.alreadySuspended
    ? Promise.resolve(true)
    : suspendScheduledTaskAutoStartForUpdate(params.serviceEnv, {
        beforeMutation: async () => {
          params.assertCurrent?.();
          await guard?.();
          params.assertCurrent?.();
        },
      });
  return {
    suspended: suspensionPromise,
    beginMutation: () => {
      // Async preflight cannot admit mutation after interruption or settlement.
      if (interrupted || closed || delegated) {
        throw new UpdateCommandAbort();
      }
      restoreAllowed = false;
    },
    restore,
    handoff: (guardianGuard) => {
      if (closed || delegated) {
        throw new Error("Windows task recovery cannot transfer after settlement.");
      }
      guard = guardianGuard;
      delegated = true;
      restoreAllowed = false;
      restorationAttempted = true;
    },
    complete,
    interrupted: () => interrupted,
  };
}
