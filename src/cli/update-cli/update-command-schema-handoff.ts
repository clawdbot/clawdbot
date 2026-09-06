import { safeParseJsonRecord } from "@openclaw/normalization-core/json-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { getOneMessage, sendMessage } from "execa";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveManagedServiceUpdateFailureExitCode } from "../../infra/update-control-plane-sentinel.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { POST_CORE_UPDATE_ENV } from "../../infra/update-post-core-context.js";
import { spawnCommand } from "../../process/exec-spawn.js";
import { createCommandTerminationController } from "../../process/exec-termination.js";
import { registerSignalExitBarrier } from "../signal-exit-barrier.js";
import { resolveNodeRunner, resolveUpdateRoot } from "./shared.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { runUpdateFinalizationDoctorInFreshProcess } from "./update-command-fresh-doctor.js";
import type { FinishUpdateParams } from "./update-command-post-update.js";
import { UpdateCommandFailure } from "./update-command-result.js";
import { createUpdateRunProgress } from "./update-command-run.js";
import {
  stripGatewayServiceMarkerEnv,
  disableUpdatedPackageCompileCacheEnv,
  withUpdateInProgressEnv,
} from "./update-command-service-env.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

type FinalizationContext = Omit<FinishUpdateParams, "preManagedServiceStop" | "failure"> & {
  preManagedServiceStop?: Omit<
    NonNullable<FinishUpdateParams["preManagedServiceStop"]>,
    "windowsTaskAutoStartRecovery"
  >;
  nativeRecovery: boolean;
};

/** The old runtime can supervise native compensation, but cannot reopen migrated state. */
export async function continueUpdateFinalizationInFreshProcess(
  params: FinishUpdateParams,
): Promise<void> {
  const root = params.result.root ?? params.root;
  const entrypoint = await resolveGatewayInstallEntrypoint(root);
  if (!entrypoint) {
    throw new Error(
      "Updated OpenClaw entrypoint is missing; keep the Gateway stopped and rebuild the target.",
    );
  }
  const nativeRecovery = params.preManagedServiceStop?.windowsTaskAutoStartRecovery;
  let stopState: FinalizationContext["preManagedServiceStop"];
  if (params.preManagedServiceStop) {
    const { windowsTaskAutoStartRecovery: _nativeRecovery, ...state } =
      params.preManagedServiceStop;
    stopState = state;
  }
  const { failure: _failure, preManagedServiceStop: _stopState, ...rest } = params;
  const context: FinalizationContext = {
    ...rest,
    root,
    opts: {
      ...params.opts,
      run: params.opts.run ? { ...params.opts.run, transferred: false } : undefined,
    },
    preManagedServiceStop: stopState,
    nativeRecovery: Boolean(nativeRecovery),
  };
  const serializedContext = JSON.stringify(context);
  // No state migration has run yet. Publishing ownership before spawn also disarms
  // the parent's progress timer and its failure/disposal readers.
  if (params.opts.run) {
    createUpdateRunProgress(params.opts.run, {}).onStepStart?.({
      name: "openclaw doctor",
      command: "openclaw doctor --repair --non-interactive",
      index: 0,
      total: 1,
    });
    params.opts.run.transferred = true;
  }
  const cancelController = new AbortController();
  const child = spawnCommand(
    [
      params.packageUpdateNodeRunner ?? resolveNodeRunner(),
      entrypoint,
      "update",
      ...(params.opts.json ? ["--json"] : []),
    ],
    {
      cwd: root,
      baseEnv: stripGatewayServiceMarkerEnv(
        disableUpdatedPackageCompileCacheEnv(params.ownedManagedUpdateEnv ?? process.env),
      ),
      env: {
        [POST_CORE_UPDATE_ENV]: "finalize",
        OPENCLAW_UPDATE_IN_PROGRESS: "1",
        OPENCLAW_NO_RESPAWN: "1",
      },
      ipc: true,
      ipcInput: { kind: "update-finalization", context: serializedContext },
      cancelSignal: cancelController.signal,
      detached: process.platform !== "win32",
      buffer: false,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      reject: false,
    },
  );
  let settled = false;
  const termination = createCommandTerminationController({
    child: child.nodeChildProcess,
    cancelController,
    processTree: { mode: "graceful" },
    killGraceMs: 300,
    isChildExited: () =>
      child.nodeChildProcess.exitCode !== null || child.nodeChildProcess.signalCode !== null,
    isCommandSettled: () => settled,
  });
  let interruptedExitCode: number | undefined;
  const cancel = () => {
    if (!termination.terminate()) {
      cancelController.abort();
    }
  };
  const onSigint = () => {
    interruptedExitCode = 130;
    cancel();
  };
  const onSigterm = () => {
    interruptedExitCode = 143;
    cancel();
  };
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  const unregisterBarrier = registerSignalExitBarrier(async () => {
    cancel();
    await child;
    await termination.settle();
  });
  let completed = false;
  const messages = (async () => {
    for await (const message of child.getEachMessage()) {
      if (!isRecord(message)) {
        continue;
      }
      if (message.kind === "update-finalization-complete") {
        completed = true;
      } else if (message.kind === "update-autostart-restore") {
        try {
          if (interruptedExitCode || !nativeRecovery || nativeRecovery.interrupted()) {
            throw new Error("The native update owner is no longer available.");
          }
          await nativeRecovery.restore(message.restartSafe === true);
          await child.sendMessage({ kind: "update-autostart-restored" });
        } catch (error) {
          await child.sendMessage({
            kind: "update-autostart-restored",
            error: formatErrorMessage(error),
          });
        }
      } else if (message.kind === "update-autostart-complete") {
        nativeRecovery?.complete(message.restartSafe === true);
      }
    }
  })();
  try {
    const [result] = await Promise.all([child, messages]);
    if (!completed || result.exitCode !== 0) {
      const failure = {
        ...params.result,
        status: "error" as const,
        reason: "target-finalization-failed",
        recovery: {
          serviceRestartSafe: false as const,
          reason: "state-migration-started" as const,
        },
      };
      throw new UpdateCommandFailure(
        failure,
        interruptedExitCode ?? resolveManagedServiceUpdateFailureExitCode(failure),
        "Updated OpenClaw finalization failed; keep the updated build installed and inspect the update diagnostics.",
      );
    }
  } catch (error) {
    termination.terminate();
    await child;
    throw error;
  } finally {
    settled = true;
    await termination.settle();
    unregisterBarrier();
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    nativeRecovery?.complete(false);
  }
}

/** Receive the private parent-owned continuation; service authority is rechecked by finishUpdate. */
export async function resumeUpdateFinalization(): Promise<void> {
  const { finishUpdate } = await import("./update-command-post-update.js");
  delete process.env[POST_CORE_UPDATE_ENV];
  if (!process.send) {
    throw new Error("Update finalization requires its parent IPC channel.");
  }
  const message = await getOneMessage();
  if (
    !isRecord(message) ||
    message.kind !== "update-finalization" ||
    typeof message.context !== "string"
  ) {
    throw new Error("Missing update finalization context.");
  }
  const payload = safeParseJsonRecord(message.context);
  if (
    !payload ||
    !isRecord(payload.result) ||
    payload.result.status !== "ok" ||
    payload.result.deferredDoctor !== true ||
    !isRecord(payload.opts) ||
    typeof payload.nativeRecovery !== "boolean"
  ) {
    throw new Error("Invalid update finalization continuation.");
  }
  // The envelope and deferred-success transition are checked above; native
  // recovery functions are reconstructed over IPC below.
  // SAFETY: this connected child receives the serializable DTO only from the typed parent above.
  const context = payload as FinalizationContext;
  const root = await resolveUpdateRoot();
  if (
    !context ||
    typeof context.root !== "string" ||
    !updateInstallRootsMatch(root, context.root)
  ) {
    throw new Error("Update finalization executable does not match the installed target.");
  }
  const params: FinishUpdateParams = { ...context };
  const nativeCompletions: Promise<void>[] = [];
  const nativeCompletionErrors: unknown[] = [];
  if (context.nativeRecovery && params.preManagedServiceStop) {
    params.preManagedServiceStop.windowsTaskAutoStartRecovery = {
      beginMutation: () => {
        throw new Error("Core mutation cannot resume during finalization.");
      },
      interrupted: () => !process.connected,
      restore: async (restartSafe) => {
        await sendMessage({ kind: "update-autostart-restore", restartSafe });
        const reply = await getOneMessage();
        if (!isRecord(reply) || reply.kind !== "update-autostart-restored" || reply.error) {
          throw new Error(
            isRecord(reply) && typeof reply.error === "string"
              ? reply.error
              : "Native update owner did not confirm autostart restoration.",
          );
        }
      },
      complete: (restartSafe = true) => {
        nativeCompletions.push(
          sendMessage({ kind: "update-autostart-complete", restartSafe }).catch(
            (error: unknown) => {
              nativeCompletionErrors.push(error);
            },
          ),
        );
      },
    };
  }
  const { deferredDoctor: _deferredDoctor, ...result } = params.result;
  params.result = result;
  const target = { root, env: process.env };
  try {
    await withUpdateFailureTriage(
      { ...params.opts, invocationCwd: params.invocationCwd },
      target,
      async () => {
        await withUpdateInProgressEnv(params.invocationCwd, async () => {
          const progress = params.opts.run
            ? createUpdateRunProgress(params.opts.run, {})
            : undefined;
          const step = {
            name: "openclaw doctor",
            command: "openclaw doctor --repair --non-interactive",
            index: 0,
            total: 1,
          };
          const startedAt = Date.now();
          try {
            await createUpdateConfigSnapshot();
            await runUpdateFinalizationDoctorInFreshProcess({
              phase: "pre-plugin",
              root,
              yes: params.opts.yes === true,
              json: params.opts.json === true,
              timeoutMs: params.updateStepTimeoutMs,
              nodeRunner: params.packageUpdateNodeRunner,
            });
          } catch (cause) {
            params.result = {
              ...result,
              status: "error",
              reason: "doctor-failed",
              recovery: { serviceRestartSafe: false, reason: "state-migration-started" },
            };
            params.failure = { cause, detail: formatErrorMessage(cause) };
          }
          const doctorStep = {
            ...step,
            cwd: root,
            durationMs: Date.now() - startedAt,
            exitCode: params.failure ? 1 : 0,
            ...(params.failure ? { stderrTail: params.failure.detail } : {}),
          };
          params.result.steps.push(doctorStep);
          try {
            progress?.onStepComplete?.(doctorStep);
            await finishUpdate(params);
          } catch (error) {
            if (!params.failure || error instanceof UpdateCommandFailure) {
              throw error;
            }
            throw new UpdateCommandFailure(
              params.result,
              resolveManagedServiceUpdateFailureExitCode(params.result),
              `${params.failure.detail}\nUpdate failure reporting also failed: ${formatErrorMessage(error)}`,
            );
          }
          await Promise.all(nativeCompletions);
          if (nativeCompletionErrors.length > 0) {
            throw nativeCompletionErrors[0];
          }
          await sendMessage({ kind: "update-finalization-complete" });
        });
      },
    );
  } finally {
    // Drain failed deliveries without replacing the original finalization error.
    // The parent retains native compensation ownership if IPC has disconnected.
    await Promise.all(nativeCompletions);
  }
}
