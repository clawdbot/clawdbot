import fs from "node:fs/promises";
import path from "node:path";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import {
  createGlobalInstallEnv,
  verifyPackageUpdateRecovery,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
} from "../../infra/update-global.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import { OPENCLAW_DATABASE_SCHEMA_DOCS_URL } from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemas,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  createGlobalCommandRunner,
  DEFAULT_PACKAGE_NAME,
  ensureGitCheckout,
  readPackageName,
  resolveGitInstallDir,
  resolveGlobalManager,
  runUpdateStep,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  resolvePreparedGatewayUpdatePolicy,
  type PreManagedServiceStop,
} from "./update-command-service.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

export async function retireStandaloneGitWrapper(params: {
  previousRoot: string;
  platform?: NodeJS.Platform;
  searchDirs?: readonly string[];
}): Promise<{ error?: string }> {
  const platform = params.platform ?? process.platform;
  const wrapperName = platform === "win32" ? "openclaw.cmd" : "openclaw";
  const searchDirs = params.searchDirs ?? (process.env.PATH ?? "").split(path.delimiter);
  const expectedEntry =
    platform === "win32"
      ? path.win32.join(params.previousRoot, "dist", "entry.js")
      : path.join(params.previousRoot, "dist", "entry.js");
  const seen = new Set<string>();

  for (const directory of searchDirs) {
    if (!directory) {
      continue;
    }
    const wrapperPath = path.resolve(directory, wrapperName);
    if (seen.has(wrapperPath)) {
      continue;
    }
    seen.add(wrapperPath);

    let stat;
    try {
      stat = await fs.lstat(wrapperPath);
    } catch (error) {
      if (hasNodeErrorCode(error, "ENOENT")) {
        continue;
      }
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size > 4096 ||
      (platform !== "win32" && (stat.mode & 0o111) === 0)
    ) {
      continue;
    }

    let contents: string;
    try {
      contents = await fs.readFile(wrapperPath, "utf8");
    } catch (error) {
      return { error: `Could not inspect ${wrapperPath}: ${String(error)}` };
    }
    const lines = contents.trimEnd().split(/\r?\n/u);
    const matchesWindows =
      platform === "win32" &&
      lines.length === 2 &&
      lines[0] === "@echo off" &&
      lines[1] === `node "${expectedEntry}" %*`;
    const execArgs =
      platform === "win32" || lines.length !== 3 ? null : splitShellArgs(lines[2] ?? "");
    const matchesPosix =
      platform !== "win32" &&
      lines[0] === "#!/usr/bin/env bash" &&
      lines[1] === "set -euo pipefail" &&
      execArgs?.length === 4 &&
      execArgs[0] === "exec" &&
      execArgs[2] === expectedEntry &&
      execArgs[3] === "$@";
    if (!matchesWindows && !matchesPosix) {
      continue;
    }
    try {
      await fs.unlink(wrapperPath);
    } catch (error) {
      return { error: `Could not retire ${wrapperPath}: ${String(error)}` };
    }
  }
  return {};
}

type BeforeGitMutation = (target: {
  schemaVersions?: OpenClawSchemaVersions;
  metadataUnreadable?: string;
}) => Promise<{
  allowGatewayServiceRepair?: boolean;
  allowGatewayActivation?: boolean;
} | void>;

export function createBeforeGitMutation(params: {
  updateRun?: UpdateCommandOptions["run"];
  roots: readonly string[];
  shouldRestart: boolean;
  stopManagedService: (roots: readonly string[]) => Promise<void>;
  getPreManagedServiceStop: () => PreManagedServiceStop | undefined;
  switchToGit: boolean;
}): BeforeGitMutation {
  return async (target) => {
    if (target?.metadataUnreadable) {
      throw new UpdatePreMutationError(
        "target-metadata-preflight",
        `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
      );
    }
    const preStopSchemas = await checkTargetDatabaseSchemas(target?.schemaVersions);
    if (hasSchemaRefusal(preStopSchemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(preStopSchemas).join("\n"),
      );
    }
    await params.stopManagedService(params.roots);
    const preManagedServiceStop = params.getPreManagedServiceStop();
    const postStopSchemas = await checkTargetDatabaseSchemas(
      target?.schemaVersions,
      preManagedServiceStop?.serviceEnv ?? process.env,
    );
    if (hasSchemaRefusal(postStopSchemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(postStopSchemas).join("\n"),
      );
    }
    // Git's deferred prepare phase owns the task suspension. Once mutation
    // starts, only a verified recovery may re-enable persistent autostart.
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    if (params.updateRun) {
      recordUpdateRunPhase(params.updateRun.runId, "activating", undefined, {
        env: params.updateRun.env,
      });
    }
    // A candidate checkout cannot own the service until its global exposure
    // succeeds. Finalization refreshes and activates the verified installation.
    return params.switchToGit
      ? { allowGatewayServiceRepair: false, allowGatewayActivation: false }
      : resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart);
  };
}

export async function updateGitInstall(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: UpdateChannel;
  tag: string;
  devTarget?: DevUpdateTarget;
  beforeGitMutation?: BeforeGitMutation;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
}): Promise<UpdateRunResult> {
  let updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const installEnv = await createGlobalInstallEnv();
  const runCommand = createGlobalCommandRunner();
  const installTarget = params.switchToGit
    ? await resolveGlobalInstallTarget({
        manager: await resolveGlobalManager({
          root: params.root,
          installKind: params.installKind,
          timeoutMs: effectiveTimeout,
        }),
        runCommand,
        timeoutMs: effectiveTimeout,
        pkgRoot: params.root,
      })
    : null;
  const npmLifecycleGate = installTarget
    ? resolveNpmLifecyclePolicyGate(installTarget)
    : { policy: null, error: null };

  // Package-to-Git updates must settle package-manager policy before cloning or
  // updating the checkout; carry this exact decision into the later install.
  if (npmLifecycleGate.error) {
    defaultRuntime.error(npmLifecycleGate.error);
    return {
      status: "error",
      mode: "git",
      root: params.root,
      reason: "npm lifecycle policy preflight",
      recovery: await (params.installKind === "git"
        ? readCurrentGitUpdateRecovery(params.root)
        : verifyPackageUpdateRecovery(params.root)),
      steps: [],
      durationMs: Date.now() - params.startedAt,
    };
  }

  const checkout = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        env: installEnv,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;
  const cloneStep = checkout?.step ?? null;
  updateRoot = checkout?.checkoutDir ?? updateRoot;

  if (cloneStep && cloneStep.exitCode !== 0) {
    return {
      status: "error",
      mode: "git",
      root: params.root,
      reason: cloneStep.name,
      recovery: await (params.installKind === "git"
        ? readCurrentGitUpdateRecovery(params.root)
        : verifyPackageUpdateRecovery(params.root)),
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
    devTarget: params.devTarget,
    deferConfiguredPluginInstallRepair: true,
    allowGatewayServiceRepair: params.allowGatewayServiceRepair,
    allowGatewayActivation: params.allowGatewayActivation,
    beforeGitMutation: params.beforeGitMutation,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    if (!installTarget) {
      throw new Error("global install target missing after package-to-Git preflight");
    }
    const packageName =
      (await readPackageName(installTarget.packageRoot ?? params.root)) ?? DEFAULT_PACKAGE_NAME;
    const packageUpdate = await runGlobalPackageUpdateSteps({
      installTarget,
      installSpec: updateRoot,
      packageName,
      packageRoot: installTarget.packageRoot,
      runCommand,
      runStep: (stepParams) => runUpdateStep({ ...stepParams, progress: params.progress }),
      timeoutMs: effectiveTimeout,
      env: installEnv,
      installCwd: updateRoot,
      // ensureGitCheckout already resolved the root; only the successful Git
      // build/doctor flow can authorize exposing that exact checkout globally.
      expectedGitCheckout: { root: updateRoot, sha: updateResult.after?.sha ?? null },
    });
    steps.push(...packageUpdate.steps);

    return {
      ...updateResult,
      status: packageUpdate.failedStep ? "error" : "ok",
      reason: packageUpdate.failedStep?.name,
      recovery: packageUpdate.recovery,
      steps,
      durationMs: Date.now() - params.startedAt,
    };
  }

  return {
    ...updateResult,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}
