/** Optional pre-doctor update prompt for source checkouts and package installs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { exitCliAfterOutput } from "../cli/one-shot-exit.js";
import { isTerminalInteractive } from "../cli/terminal-interactivity.js";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import { tryResolveInvocationCwd } from "../cli/update-cli/shared.js";
import { resolveServiceRefreshEnv } from "../cli/update-cli/update-command-service-env.js";
import { resolveUnsafeUpdateRecoveryGuidance } from "../cli/update-cli/update-recovery-guidance.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { ScheduledTaskAutoStartRecoveryError } from "../daemon/schtasks-update-recovery.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { formatErrorMessage } from "../infra/errors.js";
import type { UpdateRecovery } from "../infra/update-recovery.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../infra/update-runner-command.js";
import { runGatewayUpdate } from "../infra/update-runner.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { classifyUpdateOutcome } from "../shared/update-outcome.js";
import type { DoctorOptions } from "./doctor-prompter.js";
import {
  EXTERNAL_SERVICE_REPAIR_NOTE,
  isServiceRepairExternallyManaged,
} from "./doctor-service-repair-policy.js";

async function resolveComparablePath(target: string): Promise<string> {
  return await fs.realpath(target).catch(() => path.resolve(target));
}

async function detectOpenClawGitCheckout(root: string): Promise<"git" | "not-git" | "unknown"> {
  const res = await runCommandWithTimeout(["git", "-C", root, "rev-parse", "--show-toplevel"], {
    timeoutMs: 5000,
  }).catch(() => null);
  if (!res) {
    return "unknown";
  }
  if (res.code !== 0) {
    // Avoid noisy "Update via package manager" notes when git is missing/broken,
    // but do show it when this is clearly not a git checkout.
    if (normalizeLowercaseStringOrEmpty(res.stderr).includes("not a git repository")) {
      return "not-git";
    }
    return "unknown";
  }
  const gitRoot = res.stdout.trim();
  return (await resolveComparablePath(gitRoot)) === (await resolveComparablePath(root))
    ? "git"
    : "not-git";
}

/** Offers to update OpenClaw before doctor when running interactively from an updatable install. */
export async function maybeOfferUpdateBeforeDoctor(params: {
  runtime: RuntimeEnv;
  options: DoctorOptions;
  root: string | null;
  confirm: (p: { message: string; initialValue: boolean }) => Promise<boolean>;
  outro: (message: string) => void;
}) {
  const updateInProgress = isTruthyEnvValue(process.env.OPENCLAW_UPDATE_IN_PROGRESS);
  const canOfferUpdate =
    !updateInProgress &&
    params.options.nonInteractive !== true &&
    params.options.yes !== true &&
    params.options.repair !== true &&
    process.stdin.isTTY;
  if (!canOfferUpdate || !params.root) {
    return { updated: false };
  }

  const git = await detectOpenClawGitCheckout(params.root);
  if (git === "git") {
    const shouldUpdate = await params.confirm({
      message: "Update OpenClaw from git before running doctor?",
      initialValue: true,
    });
    if (!shouldUpdate) {
      return { updated: false };
    }
    const updateRoot = params.root;
    const invocationCwd = tryResolveInvocationCwd();
    const operatorEnv = resolveServiceRefreshEnv(process.env, invocationCwd);
    const { prepareUpdateFailureTriage } = await import("../infra/update-triage.js");
    const runTriage = await prepareUpdateFailureTriage({
      runtime: params.runtime,
      mode: isTerminalInteractive() ? "interactive" : "non-interactive",
      invocationCwd,
    });
    const completeFailedUpdate = async (
      result: UpdateRunResult,
      serviceEnv?: NodeJS.ProcessEnv,
    ) => {
      await runTriage({
        failure: { result },
        target: { root: updateRoot, env: serviceEnv ?? operatorEnv },
      });
      exitCliAfterOutput(params.runtime, 1);
    };
    const externallyManaged = isServiceRepairExternallyManaged();
    const serviceLifecycle =
      isDefaultInstallIdentity(process.env) && !externallyManaged
        ? await import("../cli/update-cli/managed-gateway-update.runtime.js")
        : undefined;
    let inspection = await serviceLifecycle?.maybeStopManagedServiceBeforeMutableUpdate({
      updateInstallKind: "git",
      root: updateRoot,
      shouldRestart: true,
      jsonMode: false,
      phase: "inspect",
    });
    if (inspection?.blockMessage) {
      note(inspection.blockMessage, "Update");
      return { updated: false };
    }
    if (inspection?.serviceMutationSkipMessage) {
      note(inspection.serviceMutationSkipMessage, "Update");
    }
    let gitMutationAuthorized = false;
    let restartSafe = false;
    let recoveryEnv: NodeJS.ProcessEnv | undefined;
    note("Running update…", "Update");
    const { progress, stop } = createUpdateProgress(process.stdout.isTTY);
    const startedAt = Date.now();
    let result: UpdateRunResult | undefined;
    const failedUpdate = (error: unknown, reason: string): UpdateRunResult => {
      const message = formatErrorMessage(error);
      const durationMs = Date.now() - startedAt;
      params.runtime.error(message);
      return {
        ...result,
        status: "error",
        mode: "git",
        root: updateRoot,
        reason,
        recovery:
          result?.recovery?.serviceRestartSafe === false
            ? result.recovery
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
        steps: [
          ...(result?.steps ?? []),
          {
            name: reason,
            command: "openclaw update",
            cwd: updateRoot,
            durationMs,
            exitCode: 1,
            stderrTail: message,
          },
        ],
        durationMs,
      };
    };
    try {
      result = await runGatewayUpdate({
        cwd: updateRoot,
        argv1: process.argv[1],
        progress,
        allowGatewayServiceRepair:
          inspection?.serviceUpdateVerdict?.kind === "owned" &&
          inspection.serviceUpdateVerdict.refreshDefinition,
        allowGatewayActivation: Boolean(
          inspection?.running && inspection.serviceUpdateVerdict?.kind === "owned",
        ),
        beforeGitMutation: async () => {
          if (serviceLifecycle) {
            const previousSkip = inspection?.serviceMutationSkipMessage;
            inspection = await serviceLifecycle.maybeStopManagedServiceBeforeMutableUpdate({
              updateInstallKind: "git",
              root: updateRoot,
              shouldRestart: true,
              jsonMode: false,
              phase: "prepare",
              expectedService:
                inspection?.serviceUpdateVerdict?.kind === "owned" ? inspection : undefined,
            });
            if (inspection.blockMessage) {
              throw new Error(inspection.blockMessage);
            }
            if (
              inspection.serviceMutationSkipMessage !== previousSkip &&
              inspection.serviceMutationSkipMessage
            ) {
              note(inspection.serviceMutationSkipMessage, "Update");
            }
            inspection.windowsTaskAutoStartRecovery?.beginMutation();
          }
          gitMutationAuthorized = true;
          return serviceLifecycle && inspection
            ? serviceLifecycle.resolvePreparedGatewayUpdatePolicy(inspection, true)
            : undefined;
        },
      });
      restartSafe = result.recovery?.serviceRestartSafe ?? result.status === "ok";
      if (restartSafe) {
        await inspection?.windowsTaskAutoStartRecovery?.restore(true);
      }
    } catch (err) {
      if (err instanceof ScheduledTaskAutoStartRecoveryError) {
        // Native preparation may fail after disabling autostart, before it can
        // return an inspection. Carry its recorded failure and target to triage.
        recoveryEnv = err.serviceEnv;
      } else if (!gitMutationAuthorized) {
        throw err;
      }
      const reason =
        err instanceof ScheduledTaskAutoStartRecoveryError
          ? "gateway-service-recovery-failed"
          : result
            ? "windows-task-autostart-restore-failed"
            : "update-failed";
      result = failedUpdate(err, reason);
      restartSafe = false;
      if (reason === "update-failed") {
        note("The source checkout may be partially mutated.", "Update");
      }
    } finally {
      // Release native recovery before triage can start another update.
      inspection?.windowsTaskAutoStartRecovery?.complete(restartSafe);
      stop();
    }
    const ownedServiceEnv =
      recoveryEnv ??
      (inspection?.serviceUpdateVerdict?.kind === "owned" ? inspection.serviceEnv : undefined);
    const resultDetails = [
      `Status: ${result.status}`,
      `Mode: ${result.mode}`,
      result.root && `Root: ${result.root}`,
      result.reason && `Reason: ${result.reason}`,
    ].filter(Boolean);
    note(resultDetails.join("\n"), "Update result");
    if (result.status !== "ok" || !restartSafe) {
      if (
        result.recovery?.serviceRestartSafe === false ||
        (result.status === "error" && result.recovery?.serviceRestartSafe !== true)
      ) {
        const recovery: UpdateRecovery =
          result.recovery?.serviceRestartSafe === false
            ? result.recovery
            : { serviceRestartSafe: false, reason: "runtime-verification-failed" };
        result = { ...result, status: "error", recovery };
        const managedGatewayStopped = inspection?.stopped === true;
        const summary = managedGatewayStopped
          ? `Managed gateway remains stopped because update recovery could not prove a runnable installation (${recovery.reason}).`
          : `Update recovery could not prove a runnable installation (${recovery.reason}).`;
        const keepStopped = managedGatewayStopped
          ? "\nKeep the gateway stopped until the update succeeds."
          : "";
        note(
          `${summary}\n${resolveUnsafeUpdateRecoveryGuidance(recovery.reason)}${keepStopped}`,
          "Update",
        );
      } else if (result.recovery?.serviceRestartSafe === true) {
        const recovered = await serviceLifecycle?.maybeRestartServiceAfterFailedMutableUpdate({
          recovery: result.recovery,
          preManagedServiceStop: inspection,
          jsonMode: false,
          timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
          invocationCwd,
        });
        if (recovered) {
          result = {
            ...result,
            status: recovered === "failed" ? "error" : result.status,
            recovery: { ...result.recovery, service: recovered },
          };
        }
      }
      if (classifyUpdateOutcome(result) === "failed") {
        await completeFailedUpdate(result, ownedServiceEnv);
        return { updated: true, handled: true };
      }
      return { updated: true, handled: false };
    }
    if (externallyManaged) {
      note(EXTERNAL_SERVICE_REPAIR_NOTE, "Update");
    } else if (inspection?.stopped && inspection.serviceEnv && serviceLifecycle) {
      try {
        const service = resolveGatewayService();
        const serviceState = await readGatewayServiceState(service, {
          env: inspection.serviceEnv,
          requireEffective: true,
        });
        const verdict = await serviceLifecycle.revalidateManagedGatewayServiceAfterUpdate({
          state: serviceState,
          root: updateRoot,
          preManagedServiceStop: inspection,
        });
        // Doctor already ran during the update; reuse activation/health without another repair.
        const activated = await serviceLifecycle.maybeRestartService({
          shouldRestart: true,
          result,
          channel: "dev",
          opts: {},
          refreshServiceEnv: false,
          serviceUpdateVerdict:
            verdict.kind === "owned" ? { ...verdict, refreshDefinition: false } : verdict,
          serviceEnv: serviceState.env,
          gatewayPort: await serviceLifecycle.resolveUpdatedGatewayRestartPort({
            serviceEnv: serviceState.env,
            serviceCommand: serviceState.command,
          }),
          requireRunningServiceAfterRestart: true,
          timeoutMs: UPDATE_RUNNER_TIMEOUT_MS,
        });
        if (!activated) {
          throw new Error(
            "Gateway restart was not verified; run `openclaw gateway status --deep` before restarting manually.",
          );
        }
        note("Restarted the running gateway service after updating OpenClaw.", "Update");
      } catch (err) {
        const message = "Update completed, but gateway service restart failed";
        result = failedUpdate(
          new Error(`${message}: ${formatErrorMessage(err)}`),
          "gateway-restart-failed",
        );
        params.outro(`${message}.`);
        await completeFailedUpdate(result, ownedServiceEnv);
        return { updated: true, handled: true };
      }
    }
    params.outro("Update completed (doctor already ran as part of the update).");
    return { updated: true, handled: true };
  }

  if (git === "not-git") {
    note(
      [
        "This install is not a git checkout.",
        `Run \`${formatCliCommand("openclaw update")}\` to update via your package manager (npm/pnpm), then rerun doctor.`,
      ].join("\n"),
      "Update",
    );
  }

  return { updated: false };
}
