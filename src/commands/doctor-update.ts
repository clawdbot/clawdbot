/** Optional pre-doctor update prompt for source checkouts and package installs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import { isDefaultInstallIdentity } from "../config/paths.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { UPDATE_RUNNER_TIMEOUT_MS } from "../infra/update-runner-command.js";
import { runGatewayUpdate } from "../infra/update-runner.js";
import type { UpdateRunResult } from "../infra/update-runner.js";
import { runCommandWithTimeout } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
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
    note("Running update…", "Update");
    const { progress, stop } = createUpdateProgress(process.stdout.isTTY);
    let result: UpdateRunResult;
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
        beforeGitMutation: serviceLifecycle
          ? async () => {
              const previousSkip = inspection?.serviceMutationSkipMessage;
              inspection = await serviceLifecycle.maybeStopManagedServiceBeforeMutableUpdate({
                updateInstallKind: "git",
                root: updateRoot,
                shouldRestart: true,
                jsonMode: false,
                phase: "prepare",
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
              gitMutationAuthorized = true;
              return serviceLifecycle.resolvePreparedGatewayUpdatePolicy(inspection, true);
            }
          : undefined,
      });
    } catch (err) {
      if (inspection?.stopped && gitMutationAuthorized) {
        note(
          "The gateway service remains stopped because the source checkout may be partially mutated. " +
            `Inspect and repair the checkout, then restart the gateway manually with \`${formatCliCommand("openclaw gateway restart")}\`.`,
          "Update",
        );
      } else if (inspection?.stopped) {
        await serviceLifecycle?.maybeRestartServiceAfterFailedMutableUpdate({
          preManagedServiceStop: inspection,
          jsonMode: false,
        });
      }
      throw err;
    } finally {
      stop();
    }
    const resultDetails = [
      `Status: ${result.status}`,
      `Mode: ${result.mode}`,
      result.root && `Root: ${result.root}`,
      result.reason && `Reason: ${result.reason}`,
    ].filter(Boolean);
    note(resultDetails.join("\n"), "Update result");
    if (result.status !== "ok") {
      if (result.recovery?.serviceRestartSafe !== false) {
        await serviceLifecycle?.maybeRestartServiceAfterFailedMutableUpdate({
          root: result.root,
          preManagedServiceStop: inspection,
          jsonMode: false,
        });
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
        params.runtime.error(`${message}: ${String(err)}`);
        params.outro(`${message}.`);
        params.runtime.exit(1);
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
