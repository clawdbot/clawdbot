import fs from "node:fs/promises";
import path from "node:path";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import { hasNodeErrorCode } from "../../infra/path-guards.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import {
  createGlobalInstallEnv,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
} from "../../infra/update-global.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
  preflightOpenClawDatabaseSchemas,
  type IncompatibleOpenClawDatabase,
  type IndeterminateOpenClawDatabase,
  type OpenClawDatabaseSchemaPreflight,
} from "../../state/openclaw-database-preflight.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { splitShellArgs } from "../../utils/shell-argv.js";
import { createUpdateProgress, printResult } from "./progress.js";
import {
  createGlobalCommandRunner,
  DEFAULT_PACKAGE_NAME,
  ensureGitCheckout,
  readPackageName,
  resolveGitInstallDir,
  resolveGlobalManager,
  runUpdateStep,
  type UpdateCommandOptions,
} from "./shared.js";
import {
  resolvePreparedGatewayUpdatePolicy,
  UpdateCommandAbort,
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

export function formatSchemaRefusalLines(
  schemas: {
    incompatible: readonly IncompatibleOpenClawDatabase[];
    indeterminate: readonly IndeterminateOpenClawDatabase[];
  },
  dryRun = false,
): string[] {
  const prefix = dryRun ? "Would refuse update" : "Update refused";
  return [
    ...schemas.incompatible.map((database) => {
      const agent = database.agentId ? ` (agent ${database.agentId})` : "";
      return `${prefix}: ${database.kind} database${agent} ${database.path} has schema ${database.foundVersion}; target supports ${database.supportedVersion}; writer build ${database.writerAppVersion ?? "unknown"}.`;
    }),
    ...schemas.indeterminate.map(
      (database) =>
        `${prefix}: could not inspect ${database.kind} database ${database.path}: ${database.reason}; retry once the gateway releases it.`,
    ),
    OPENCLAW_DATABASE_SCHEMA_DOCS_URL,
    "Installing manually via npm bypasses this guard; back up first and verify compatibility.",
  ];
}

export function checkTargetDatabaseSchemas(
  supportedVersions: OpenClawSchemaVersions | undefined,
  env: NodeJS.ProcessEnv = process.env,
): OpenClawDatabaseSchemaPreflight {
  return supportedVersions
    ? preflightOpenClawDatabaseSchemas({ env, supportedVersions })
    : { incompatible: [], indeterminate: [] };
}

export function hasSchemaRefusal(schemas: OpenClawDatabaseSchemaPreflight): boolean {
  return schemas.incompatible.length > 0 || schemas.indeterminate.length > 0;
}

export function createBeforeGitMutation(params: {
  roots: readonly string[];
  shouldRestart: boolean;
  stopManagedService: (roots: readonly string[]) => Promise<void>;
  getPreManagedServiceStop: () => PreManagedServiceStop | undefined;
  markSchemaRefusalAfterStop: () => void;
}): BeforeGitMutation {
  return async (target) => {
    if (target?.metadataUnreadable) {
      defaultRuntime.error(
        `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}). Retry, or see ${OPENCLAW_DATABASE_SCHEMA_DOCS_URL}.`,
      );
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }
    const preStopSchemas = checkTargetDatabaseSchemas(target?.schemaVersions);
    if (hasSchemaRefusal(preStopSchemas)) {
      defaultRuntime.error(formatSchemaRefusalLines(preStopSchemas).join("\n"));
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }
    await params.stopManagedService(params.roots);
    const preManagedServiceStop = params.getPreManagedServiceStop();
    const postStopSchemas = checkTargetDatabaseSchemas(
      target?.schemaVersions,
      preManagedServiceStop?.serviceEnv ?? process.env,
    );
    if (hasSchemaRefusal(postStopSchemas)) {
      params.markSchemaRefusalAfterStop();
      defaultRuntime.error(formatSchemaRefusalLines(postStopSchemas).join("\n"));
      throw new UpdateCommandAbort();
    }
    return resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart);
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
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
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
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: "npm lifecycle policy preflight",
      steps: [],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    defaultRuntime.error(npmLifecycleGate.error);
    defaultRuntime.exit(1);
    return result;
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
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: cloneStep.name,
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
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
    });
    steps.push(...packageUpdate.steps);

    return {
      ...updateResult,
      status: packageUpdate.failedStep ? "error" : "ok",
      reason: packageUpdate.failedStep?.name,
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
