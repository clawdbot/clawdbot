/** Optional pre-doctor update prompt for source checkouts and package installs. */
import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { note } from "../../packages/terminal-core/src/note.js";
import { formatCliCommand } from "../cli/command-format.js";
import { createUpdateProgress } from "../cli/update-cli/progress.js";
import { summarizeGatewayServiceLayout } from "../daemon/service-layout.js";
import { readGatewayServiceState, resolveGatewayService } from "../daemon/service.js";
import { isTruthyEnvValue } from "../infra/env.js";
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

type GatewayServiceUpdatePolicy = {
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
};

type GatewayServiceUpdateInspection = GatewayServiceUpdatePolicy & {
  service?: ReturnType<typeof resolveGatewayService>;
  state?: Awaited<ReturnType<typeof readGatewayServiceState>>;
};

const NO_GATEWAY_SERVICE_UPDATE: GatewayServiceUpdatePolicy = {
  allowGatewayServiceRepair: false,
  allowGatewayActivation: false,
};

async function inspectGatewayServiceForUpdate(
  root: string,
): Promise<GatewayServiceUpdateInspection> {
  if (isServiceRepairExternallyManaged()) {
    return NO_GATEWAY_SERVICE_UPDATE;
  }
  try {
    const service = resolveGatewayService();
    const state = await readGatewayServiceState(service, { env: process.env });
    if (!state.installed) {
      return NO_GATEWAY_SERVICE_UPDATE;
    }
    const layout = await summarizeGatewayServiceLayout(state.command);
    const serviceRoot = layout?.packageRootReal ?? layout?.packageRoot;
    const serviceEntrypoint = layout?.entrypoint;
    if (
      !serviceRoot ||
      !serviceEntrypoint ||
      (!path.isAbsolute(serviceEntrypoint) && !path.win32.isAbsolute(serviceEntrypoint))
    ) {
      return NO_GATEWAY_SERVICE_UPDATE;
    }
    const [serviceRootReal, updateRootReal] = await Promise.all([
      resolveComparablePath(serviceRoot),
      resolveComparablePath(root),
    ]);
    if (serviceRootReal !== updateRootReal) {
      return NO_GATEWAY_SERVICE_UPDATE;
    }
    return {
      allowGatewayServiceRepair: true,
      allowGatewayActivation: state.running,
      service,
      state,
    };
  } catch {
    // Repair or activation can disrupt a different checkout, so unknown ownership fails closed.
    return NO_GATEWAY_SERVICE_UPDATE;
  }
}

async function restartRunningGatewayServiceAfterUpdate(
  runtime: RuntimeEnv,
  root: string,
  wasOwnedAndRunning: boolean,
): Promise<boolean> {
  if (isServiceRepairExternallyManaged()) {
    note(EXTERNAL_SERVICE_REPAIR_NOTE, "Update");
    return true;
  }
  if (!wasOwnedAndRunning) {
    return true;
  }
  const inspection = await inspectGatewayServiceForUpdate(root);
  // Revalidate ownership after checkout replacement, but restart even when the
  // previously running service stopped during the update.
  if (!inspection.allowGatewayServiceRepair || !inspection.service || !inspection.state) {
    return true;
  }
  try {
    await inspection.service.restart({
      env: inspection.state.env,
      stdout: process.stdout,
    });
    note("Restarted the running gateway service after updating OpenClaw.", "Update");
    return true;
  } catch (err) {
    runtime.error(`Update completed, but gateway service restart failed: ${String(err)}`);
    return false;
  }
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
    note("Running update…", "Update");
    const serviceInspection = await inspectGatewayServiceForUpdate(params.root);
    const serviceUpdatePolicy: GatewayServiceUpdatePolicy = {
      allowGatewayServiceRepair: serviceInspection.allowGatewayServiceRepair,
      allowGatewayActivation: serviceInspection.allowGatewayActivation,
    };
    const { progress, stop } = createUpdateProgress(process.stdout.isTTY);
    let result: UpdateRunResult;
    try {
      result = await runGatewayUpdate({
        cwd: params.root,
        argv1: process.argv[1],
        progress,
        ...serviceUpdatePolicy,
      });
    } finally {
      stop();
    }
    note(
      [
        `Status: ${result.status}`,
        `Mode: ${result.mode}`,
        result.root ? `Root: ${result.root}` : null,
        result.reason ? `Reason: ${result.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      "Update result",
    );
    if (result.status === "ok") {
      const restarted = await restartRunningGatewayServiceAfterUpdate(
        params.runtime,
        params.root,
        serviceUpdatePolicy.allowGatewayActivation,
      );
      if (!restarted) {
        params.outro("Update completed, but gateway service restart failed.");
        params.runtime.exit(1);
        return { updated: true, handled: true };
      }
      params.outro("Update completed (doctor already ran as part of the update).");
      return { updated: true, handled: true };
    }
    return { updated: true, handled: false };
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
