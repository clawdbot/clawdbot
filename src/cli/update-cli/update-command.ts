import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { doctorCommand } from "../../commands/doctor.js";
import {
  readConfigFileSnapshot,
  replaceConfigFile,
  resolveGatewayPort,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
} from "../../infra/update-channels.js";
import {
  compareSemverStrings,
  fetchNpmPackageTargetStatus,
  resolveNpmChannelTag,
  checkUpdateStatus,
} from "../../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
} from "../../infra/update-global.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { syncPluginsForUpdateChannel, updateNpmInstalledPlugins } from "../../plugins/update.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { pathExists } from "../../utils.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
} from "../daemon-cli/restart-health.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins-install-record-commit.js";
import { listPersistedBundledPluginLocationBridges } from "../plugins-location-bridges.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins-registry-refresh.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  ensureGitCheckout,
  normalizeTag,
  parseTimeoutMsOrExit,
  readPackageName,
  readPackageVersion,
  resolveGitInstallDir,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;
const POST_CORE_UPDATE_ENV = "OPENCLAW_UPDATE_POST_CORE";
const POST_CORE_UPDATE_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_CHANNEL";
const POST_CORE_UPDATE_RESULT_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH";
const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

function isPackageManagerUpdateMode(mode: UpdateRunResult["mode"]): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
}): boolean {
  if (isPackageManagerUpdateMode(params.updateMode)) {
    return params.serviceInstalled;
  }
  return params.serviceLoaded;
}

export function shouldUseLegacyProcessRestartAfterUpdate(params: {
  updateMode: UpdateRunResult["mode"];
}): boolean {
  return !isPackageManagerUpdateMode(params.updateMode);
}

type PrePackageServiceStop = {
  stopped: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
};

async function maybeStopManagedServiceBeforePackageUpdate(params: {
  shouldRestart: boolean;
  jsonMode: boolean;
}): Promise<PrePackageServiceStop> {
  let service: ReturnType<typeof resolveGatewayService>;
  let serviceState: Awaited<ReturnType<typeof readGatewayServiceState>>;
  try {
    service = resolveGatewayService();
    serviceState = await readGatewayServiceState(service, { env: process.env });
  } catch {
    return { stopped: false };
  }

  if (!serviceState.installed) {
    return { stopped: false };
  }

  if (!params.shouldRestart) {
    if (!params.jsonMode && serviceState.running) {
      defaultRuntime.log(
        theme.warn(
          "--no-restart is set while the managed gateway service is running; the package update will not stop or restart that process.",
        ),
      );
    }
    return { stopped: false, serviceEnv: serviceState.env };
  }

  if (!serviceState.running) {
    return { stopped: false, serviceEnv: serviceState.env };
  }

  if (!params.jsonMode) {
    defaultRuntime.log(theme.muted("Stopping managed gateway service before package update..."));
  }
  await service.stop({ env: serviceState.env, stdout: process.stdout });
  return { stopped: true, serviceEnv: serviceState.env };
}

async function maybeRestartServiceAfterFailedPackageUpdate(params: {
  prePackageServiceStop: PrePackageServiceStop | undefined;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.prePackageServiceStop?.stopped || !params.prePackageServiceStop.serviceEnv) {
    return;
  }
  try {
    await resolveGatewayService().restart({
      env: params.prePackageServiceStop.serviceEnv,
      stdout: process.stdout,
    });
    if (!params.jsonMode) {
      defaultRuntime.log(theme.muted("Restarted managed gateway service after failed update."));
    }
  } catch (err) {
    const message = `Failed to restart managed gateway service after failed update: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

function isRunningInsideGatewayService(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

async function resolvePackageRuntimePreflightError(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(params.tag)) {
    return null;
  }
  const target = params.tag.trim();
  if (!target) {
    return null;
  }
  const status = await fetchNpmPackageTargetStatus({
    target,
    timeoutMs: params.timeoutMs,
  });
  if (status.error) {
    return null;
  }
  const satisfies = nodeVersionSatisfiesEngine(process.versions.node ?? null, status.nodeEngine);
  if (satisfies !== false) {
    return null;
  }
  const targetLabel = status.version ?? target;
  return [
    `Node ${process.versions.node ?? "unknown"} is too old for openclaw@${targetLabel}.`,
    `The requested package requires ${status.nodeEngine}.`,
    "Upgrade Node to 22.14+ or Node 24, then rerun `openclaw update`.",
    "Bare `npm i -g openclaw` can silently install an older compatible release.",
    "After upgrading Node, use `npm i -g openclaw@latest`.",
  ].join("\n");
}

function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    if (!invocationCwd) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    resolvedEnv[key] = path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

type UpdateDryRunPreview = {
  dryRun: true;
  root: string;
  installKind: "git" | "package" | "unknown";
  mode: UpdateRunResult["mode"];
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  restart: boolean;
  requestedChannel: "stable" | "beta" | "dev" | null;
  storedChannel: "stable" | "beta" | "dev" | null;
  effectiveChannel: "stable" | "beta" | "dev";
  tag: string;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  actions: string[];
  notes: string[];
};

function printDryRunPreview(preview: UpdateDryRunPreview, jsonMode: boolean): void {
  if (jsonMode) {
    defaultRuntime.writeJson(preview);
    return;
  }

  defaultRuntime.log(theme.heading("Update dry-run"));
  defaultRuntime.log(theme.muted("No changes were applied."));
  defaultRuntime.log("");
  defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
  defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
  defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
  defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
  if (preview.currentVersion) {
    defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
  }
  if (preview.targetVersion) {
    defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Planned actions:"));
  for (const action of preview.actions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (preview.notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Notes:"));
    for (const note of preview.notes) {
      defaultRuntime.log(`  - ${theme.muted(note)}`);
    }
  }
}

async function refreshGatewayServiceEnv(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (entrypoint) {
    const res = await runCommandWithTimeout([resolveNodeRunner(), entrypoint, ...args], {
      cwd: params.result.root,
      env: resolveServiceRefreshEnv(params.env ?? process.env, params.invocationCwd),
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  if (isPackageManagerUpdateMode(params.result.mode)) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
}

async function runUpdatedInstallGatewayRestart(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  const args = ["gateway", "restart"];
  if (params.jsonMode) {
    args.push("--json");
  }
  const res = await runCommandWithTimeout([resolveNodeRunner(), entrypoint, ...args], {
    cwd: params.result.root,
    env: resolveServiceRefreshEnv(params.env ?? process.env, params.invocationCwd),
    timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
  });
  if (res.code === 0) {
    return true;
  }
  throw new Error(
    `updated install restart failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
  );
}

async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Shell completion"));

    const shouldInstall = await confirm({
      message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
      initialValue: true,
    });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
      }
      return;
    }

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
}): Promise<UpdateRunResult> {
  const manager = await resolveGlobalManager({
    root: params.root,
    installKind: params.installKind,
    timeoutMs: params.timeoutMs,
  });
  const installEnv = await createGlobalInstallEnv();
  const runCommand = createGlobalCommandRunner();
  const installTarget = await resolveGlobalInstallTarget({
    manager,
    runCommand,
    timeoutMs: params.timeoutMs,
    pkgRoot: params.root,
  });
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec = resolveGlobalInstallSpec({
    packageName,
    tag: params.tag,
    env: installEnv,
  });

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const diskWarning = createLowDiskSpaceWarning({
    targetPath: pkgRoot ? path.dirname(pkgRoot) : params.root,
    purpose: "global package update",
  });
  if (diskWarning) {
    if (params.jsonMode) {
      defaultRuntime.error(`Warning: ${diskWarning}`);
    } else {
      defaultRuntime.log(theme.warn(diskWarning));
    }
  }

  const packageUpdate = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    runCommand,
    timeoutMs: params.timeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: async (verifiedPackageRoot) => {
      const entryPath = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
      if (entryPath) {
        return await runUpdateStep({
          name: `${CLI_NAME} doctor`,
          argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive", "--fix"],
          env: {
            ...process.env,
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
          },
          timeoutMs: params.timeoutMs,
          progress: params.progress,
        });
      }
      return null;
    },
  });

  return {
    status: packageUpdate.failedStep ? "error" : "ok",
    mode: manager,
    root: packageUpdate.verifiedPackageRoot ?? params.root,
    reason: packageUpdate.failedStep ? packageUpdate.failedStep.name : undefined,
    before: { version: beforeVersion },
    after: { version: packageUpdate.afterVersion ?? beforeVersion },
    steps: packageUpdate.steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: "stable" | "beta" | "dev";
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
  devTargetRef?: string;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const installEnv = await createGlobalInstallEnv();

  const cloneStep = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        env: installEnv,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;

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
    devTargetRef: params.devTargetRef,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: effectiveTimeout,
    });
    const runCommand = createGlobalCommandRunner();
    const installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: effectiveTimeout,
      pkgRoot: params.root,
    });
    const installStep = await runUpdateStep({
      name: "global install",
      argv: globalInstallArgs(installTarget, updateRoot),
      cwd: updateRoot,
      env: installEnv,
      timeoutMs: effectiveTimeout,
      progress: params.progress,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    return {
      ...updateResult,
      status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
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

async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  opts: UpdateCommandOptions;
  timeoutMs: number;
}): Promise<PostCorePluginUpdateResult> {
  if (!params.configSnapshot.valid) {
    if (!params.opts.json) {
      defaultRuntime.log(theme.warn("Skipping plugin updates: config is invalid."));
    }
    return {
      status: "skipped",
      reason: "invalid-config",
      changed: false,
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [],
      },
      integrityDrifts: [],
    };
  }

  const pluginLogger = params.opts.json
    ? {}
    : {
        info: (msg: string) => defaultRuntime.log(msg),
        warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
        error: (msg: string) => defaultRuntime.log(theme.error(msg)),
      };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
  const syncResult = await syncPluginsForUpdateChannel({
    config: withPluginInstallRecords(params.configSnapshot.sourceConfig, pluginInstallRecords),
    channel: params.channel,
    workspaceDir: params.root,
    externalizedBundledPluginBridges: await listPersistedBundledPluginLocationBridges({
      workspaceDir: params.root,
    }),
    logger: pluginLogger,
  });
  let pluginConfig = syncResult.config;
  const integrityDrifts: PostCorePluginUpdateResult["integrityDrifts"] = [];

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    timeoutMs: params.timeoutMs,
    skipIds: new Set(syncResult.summary.switchedToNpm),
    logger: pluginLogger,
    onIntegrityDrift: async (drift) => {
      integrityDrifts.push({
        pluginId: drift.pluginId,
        spec: drift.spec,
        expectedIntegrity: drift.expectedIntegrity,
        actualIntegrity: drift.actualIntegrity,
        ...(drift.resolvedSpec ? { resolvedSpec: drift.resolvedSpec } : {}),
        ...(drift.resolvedVersion ? { resolvedVersion: drift.resolvedVersion } : {}),
        action: "aborted",
      });
      if (!params.opts.json) {
        const specLabel = drift.resolvedSpec ?? drift.spec;
        defaultRuntime.log(
          theme.warn(
            `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
              `\nExpected: ${drift.expectedIntegrity}` +
              `\nActual:   ${drift.actualIntegrity}` +
              "\nPlugin update aborted. Reinstall the plugin only if you trust the new artifact.",
          ),
        );
      }
      return false;
    },
  });
  pluginConfig = npmResult.config;

  if (syncResult.changed || npmResult.changed) {
    const nextInstallRecords = pluginConfig.plugins?.installs ?? {};
    const nextConfig = withoutPluginInstallRecords(pluginConfig);
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: pluginInstallRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: params.configSnapshot.hash,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      workspaceDir: params.root,
      installRecords: nextInstallRecords,
      logger: pluginLogger,
    });
  }

  if (params.opts.json) {
    return {
      status:
        syncResult.summary.errors.length > 0 ||
        npmResult.outcomes.some((outcome) => outcome.status === "error")
          ? "error"
          : "ok",
      changed: syncResult.changed || npmResult.changed,
      sync: {
        changed: syncResult.changed,
        switchedToBundled: syncResult.summary.switchedToBundled,
        switchedToNpm: syncResult.summary.switchedToNpm,
        warnings: syncResult.summary.warnings,
        errors: syncResult.summary.errors,
      },
      npm: {
        changed: npmResult.changed,
        outcomes: npmResult.outcomes,
      },
      integrityDrifts,
    };
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (syncResult.summary.switchedToBundled.length > 0) {
    defaultRuntime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (syncResult.summary.switchedToNpm.length > 0) {
    defaultRuntime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of syncResult.summary.warnings) {
    defaultRuntime.log(theme.warn(warning));
  }
  for (const error of syncResult.summary.errors) {
    defaultRuntime.log(theme.error(error));
  }

  const updated = npmResult.outcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = npmResult.outcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = npmResult.outcomes.filter((entry) => entry.status === "error").length;
  const skipped = npmResult.outcomes.filter((entry) => entry.status === "skipped").length;

  if (npmResult.outcomes.length === 0) {
    defaultRuntime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const outcome of npmResult.outcomes) {
    if (outcome.status !== "error") {
      continue;
    }
    defaultRuntime.log(theme.error(outcome.message));
  }

  return {
    status:
      syncResult.summary.errors.length > 0 ||
      npmResult.outcomes.some((outcome) => outcome.status === "error")
        ? "error"
        : "ok",
    changed: syncResult.changed || npmResult.changed,
    sync: {
      changed: syncResult.changed,
      switchedToBundled: syncResult.summary.switchedToBundled,
      switchedToNpm: syncResult.summary.switchedToNpm,
      warnings: syncResult.summary.warnings,
      errors: syncResult.summary.errors,
    },
    npm: {
      changed: npmResult.changed,
      outcomes: npmResult.outcomes,
    },
    integrityDrifts,
  };
}

async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
}): Promise<boolean> {
  const verifyRestartedGateway = async (expectedGatewayVersion: string | undefined) => {
    const restartAfterStaleCleanup = async () => {
      if (params.refreshServiceEnv && isPackageManagerUpdateMode(params.result.mode)) {
        await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
        });
        return;
      }
      if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode })) {
        await runDaemonRestart();
      }
    };
    const service = resolveGatewayService();
    let health = await waitForGatewayHealthyRestart({
      service,
      port: params.gatewayPort,
      expectedVersion: expectedGatewayVersion,
    });
    if (!health.healthy && health.staleGatewayPids.length > 0) {
      if (!params.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
          ),
        );
      }
      await terminateStaleGatewayPids(health.staleGatewayPids);
      await restartAfterStaleCleanup();
      health = await waitForGatewayHealthyRestart({
        service,
        port: params.gatewayPort,
        expectedVersion: expectedGatewayVersion,
      });
    }

    if (health.healthy) {
      return true;
    }

    const diagnosticLines = [
      "Gateway did not become healthy after restart.",
      ...renderRestartDiagnostics(health),
      `Restart log: ${resolveGatewayRestartLogPath(process.env)}`,
      `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
    ];
    if (params.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    if (isPackageManagerUpdateMode(params.result.mode)) {
      return false;
    }

    return !(health.versionMismatch || health.activatedPluginErrors?.length);
  };

  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      const expectedGatewayVersion = isPackageManagerUpdateMode(params.result.mode)
        ? normalizeOptionalString(params.result.after?.version)
        : undefined;
      const isPackageUpdate = isPackageManagerUpdateMode(params.result.mode);
      let restarted = false;
      let restartInitiated = false;
      if (params.refreshServiceEnv) {
        try {
          await refreshGatewayServiceEnv({
            result: params.result,
            jsonMode: Boolean(params.opts.json),
            invocationCwd: params.invocationCwd,
            env: params.serviceEnv,
          });
        } catch (err) {
          // Always log the refresh failure so callers can detect it (issue #56772).
          // Previously this was silently suppressed in --json mode, hiding the root
          // cause and preventing auto-update callers from detecting the failure.
          const message = `Failed to refresh gateway service environment from updated install: ${String(err)}`;
          if (params.opts.json) {
            defaultRuntime.error(message);
          } else {
            defaultRuntime.log(theme.warn(message));
          }
          if (isPackageUpdate) {
            return false;
          }
        }
      }
      if (params.restartScriptPath) {
        await runRestartScript(params.restartScriptPath);
        restartInitiated = true;
      } else if (params.refreshServiceEnv && isPackageUpdate) {
        restarted = await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
        });
      } else if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode })) {
        restarted = await runDaemonRestart();
      } else if (!params.opts.json) {
        defaultRuntime.log(theme.muted("No installed gateway service found; skipped restart."));
      }

      const shouldVerifyRestart =
        restartInitiated || (restarted && expectedGatewayVersion !== undefined);
      if (shouldVerifyRestart) {
        const restartHealthy = await verifyRestartedGateway(expectedGatewayVersion);
        if (!restartHealthy) {
          if (!params.opts.json) {
            defaultRuntime.log("");
          }
          return false;
        }
        if (!params.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!params.opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        try {
          const interactiveDoctor =
            process.stdin.isTTY && !params.opts.json && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
        }
      }
    } catch (err) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Daemon restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
          ),
        );
      }
      if (isPackageManagerUpdateMode(params.result.mode)) {
        return false;
      }
    }
    return true;
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return true;
}

async function runPostCorePluginUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  opts: UpdateCommandOptions;
  timeoutMs: number;
}): Promise<PostCorePluginUpdateResult> {
  return await updatePluginsAfterCoreUpdate({
    root: params.root,
    channel: params.channel,
    configSnapshot: params.configSnapshot,
    opts: params.opts,
    timeoutMs: params.timeoutMs,
  });
}

async function writePostCorePluginUpdateResultFile(
  filePath: string | undefined,
  result: PostCorePluginUpdateResult,
): Promise<void> {
  if (!filePath) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(result)}\n`, "utf-8");
}

async function readPostCorePluginUpdateResultFile(
  filePath: string,
): Promise<PostCorePluginUpdateResult | undefined> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    const parsed = JSON.parse(raw) as PostCorePluginUpdateResult;
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.status === "ok" || parsed.status === "skipped" || parsed.status === "error")
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

async function continuePostCoreUpdateInFreshProcess(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  opts: UpdateCommandOptions;
}): Promise<{ resumed: boolean; pluginUpdate?: PostCorePluginUpdateResult }> {
  const entryPath = path.join(params.root, "dist", "entry.js");
  if (!(await pathExists(entryPath))) {
    return { resumed: false };
  }

  const argv = [entryPath, "update"];
  if (params.opts.json) {
    argv.push("--json");
  }
  if (params.opts.restart === false) {
    argv.push("--no-restart");
  }
  if (params.opts.yes) {
    argv.push("--yes");
  }
  if (params.opts.timeout) {
    argv.push("--timeout", params.opts.timeout);
  }
  const resultDir =
    params.opts.json === true
      ? await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-post-core-"))
      : null;
  const resultPath = resultDir ? path.join(resultDir, "plugins.json") : null;

  try {
    const child = spawn(resolveNodeRunner(), argv, {
      stdio: "inherit",
      env: {
        ...process.env,
        [POST_CORE_UPDATE_ENV]: "1",
        [POST_CORE_UPDATE_CHANNEL_ENV]: params.channel,
        ...(resultPath ? { [POST_CORE_UPDATE_RESULT_PATH_ENV]: resultPath } : {}),
      },
    });

    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        if (signal) {
          reject(new Error(`post-update process terminated by signal ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });

    const pluginUpdate = resultPath
      ? await readPostCorePluginUpdateResultFile(resultPath)
      : undefined;
    if (exitCode !== 0) {
      if (pluginUpdate) {
        return { resumed: true, pluginUpdate };
      }
      defaultRuntime.exit(exitCode);
      throw new Error(`post-update process exited with code ${exitCode}`);
    }
    return { resumed: true, ...(pluginUpdate ? { pluginUpdate } : {}) };
  } finally {
    if (resultDir) {
      await fs.rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

function shouldResumePostCoreUpdateInFreshProcess(params: {
  result: UpdateRunResult;
  downgradeRisk: boolean;
}): boolean {
  return isPackageManagerUpdateMode(params.result.mode) && !params.downgradeRisk;
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  suppressDeprecations();
  const invocationCwd = tryResolveInvocationCwd();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  const root = await resolveUpdateRoot();
  if (postCoreUpdateResume) {
    if (
      postCoreUpdateChannel !== "stable" &&
      postCoreUpdateChannel !== "beta" &&
      postCoreUpdateChannel !== "dev"
    ) {
      defaultRuntime.error("Missing post-core update channel context.");
      defaultRuntime.exit(1);
      return;
    }

    const pluginUpdate = await runPostCorePluginUpdate({
      root,
      channel: postCoreUpdateChannel,
      configSnapshot: await readConfigFileSnapshot(),
      opts,
      timeoutMs: updateStepTimeoutMs,
    });
    if (opts.json) {
      await writePostCorePluginUpdateResultFile(
        process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
        pluginUpdate,
      );
      if (!process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
        const result: UpdateRunResult = {
          status: pluginUpdate.status === "error" ? "error" : "ok",
          mode: "unknown",
          root,
          steps: [],
          durationMs: 0,
          postUpdate: { plugins: pluginUpdate },
        };
        defaultRuntime.writeJson(result);
      }
    }
    if (pluginUpdate.status === "error") {
      defaultRuntime.exit(1);
      return;
    }
    return;
  }

  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const configSnapshot = await readConfigFileSnapshot();
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  if (opts.channel && !configSnapshot.valid) {
    const issues = formatConfigIssueLines(configSnapshot.issues, "-");
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const devTargetRef =
    channel === "dev" ? process.env.OPENCLAW_UPDATE_DEV_TARGET_REF?.trim() || undefined : undefined;

  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let fallbackToLatest = false;
  let packageInstallSpec: string | null = null;
  let packageAlreadyCurrent = false;

  if (updateInstallKind !== "git") {
    currentVersion = switchToPackage ? null : await readPackageVersion(root);
    if (explicitTag) {
      targetVersion = await resolveTargetVersion(tag, timeoutMs);
    } else {
      targetVersion = await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
        tag = resolved.tag;
        fallbackToLatest = channel === "beta" && resolved.tag === "latest";
        return resolved.version;
      });
    }
    const cmp =
      currentVersion && targetVersion ? compareSemverStrings(currentVersion, targetVersion) : null;
    packageAlreadyCurrent =
      updateInstallKind === "package" &&
      !switchToPackage &&
      currentVersion != null &&
      targetVersion != null &&
      currentVersion === targetVersion &&
      (requestedChannel === null || requestedChannel === storedChannel);
    downgradeRisk =
      canResolveRegistryVersionForPackageTarget(tag) &&
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));
    packageInstallSpec = resolveGlobalInstallSpec({
      packageName: DEFAULT_PACKAGE_NAME,
      tag,
      env: process.env,
    });
  }

  if (opts.dryRun) {
    let mode: UpdateRunResult["mode"] = "unknown";
    if (updateInstallKind === "git") {
      mode = "git";
    } else if (updateInstallKind === "package") {
      mode = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: updateStepTimeoutMs,
      });
    }

    const actions: string[] = [];
    if (requestedChannel && requestedChannel !== storedChannel) {
      actions.push(`Persist update.channel=${requestedChannel} in config`);
    }
    if (switchToGit) {
      actions.push("Switch install mode from package to git checkout (dev channel)");
    } else if (switchToPackage) {
      actions.push(`Switch install mode from git to package manager (${mode})`);
    } else if (updateInstallKind === "git") {
      actions.push(`Run git update flow on channel ${channel} (fetch/rebase/build/doctor)`);
    } else if (packageAlreadyCurrent) {
      actions.push(
        `Refresh package install with spec ${packageInstallSpec ?? tag}; current version already matches ${targetVersion}`,
      );
    } else {
      actions.push(`Run global package manager update with spec ${packageInstallSpec ?? tag}`);
    }
    actions.push("Run plugin update sync after core update");
    actions.push("Refresh shell completion cache (if needed)");
    actions.push(
      shouldRestart
        ? "Restart gateway service and run doctor checks"
        : "Skip restart (because --no-restart is set)",
    );

    const notes: string[] = [];
    if (opts.tag && updateInstallKind === "git") {
      notes.push("--tag applies to npm installs only; git updates ignore it.");
    }
    if (fallbackToLatest) {
      notes.push("Beta channel resolves to latest for this run (fallback).");
    }
    if (explicitTag && !canResolveRegistryVersionForPackageTarget(tag)) {
      notes.push("Non-registry package specs skip npm version lookup and downgrade previews.");
    }

    printDryRunPreview(
      {
        dryRun: true,
        root,
        installKind,
        mode,
        updateInstallKind,
        switchToGit,
        switchToPackage,
        restart: shouldRestart,
        requestedChannel,
        storedChannel,
        effectiveChannel: channel,
        tag: packageInstallSpec ?? tag,
        currentVersion,
        targetVersion,
        downgradeRisk,
        actions,
        notes,
      },
      Boolean(opts.json),
    );
    return;
  }

  if (updateInstallKind === "package" && isRunningInsideGatewayService()) {
    defaultRuntime.error(
      [
        "Package updates cannot run from inside the gateway service process.",
        "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
        `Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`,
      ].join("\n"),
    );
    defaultRuntime.exit(1);
    return;
  }

  if (downgradeRisk && !opts.yes) {
    if (!process.stdin.isTTY || opts.json) {
      defaultRuntime.error(
        [
          "Downgrade confirmation required.",
          "Downgrading can break configuration. Re-run in a TTY to confirm.",
        ].join("\n"),
      );
      defaultRuntime.exit(1);
      return;
    }

    const targetLabel = targetVersion ?? `${tag} (unknown)`;
    const message = `Downgrading from ${currentVersion} to ${targetLabel} can break configuration. Continue?`;
    const ok = await confirm({
      message: stylePromptMessage(message),
      initialValue: false,
    });
    if (isCancel(ok) || !ok) {
      if (!opts.json) {
        defaultRuntime.log(theme.muted("Update cancelled."));
      }
      defaultRuntime.exit(0);
      return;
    }
  }

  if (updateInstallKind === "git" && opts.tag && !opts.json) {
    defaultRuntime.log(
      theme.muted("Note: --tag applies to npm installs only; git updates ignore it."),
    );
  }

  if (updateInstallKind === "package") {
    const runtimePreflightError = await resolvePackageRuntimePreflightError({
      tag,
      timeoutMs,
    });
    if (runtimePreflightError) {
      defaultRuntime.error(runtimePreflightError);
      defaultRuntime.exit(1);
      return;
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();

  let prePackageServiceStop: PrePackageServiceStop | undefined;
  if (updateInstallKind === "package") {
    try {
      prePackageServiceStop = await maybeStopManagedServiceBeforePackageUpdate({
        shouldRestart,
        jsonMode: Boolean(opts.json),
      });
    } catch (err) {
      stop();
      defaultRuntime.error(`Failed to stop managed gateway service before update: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }
  }

  let result: UpdateRunResult;
  try {
    result =
      updateInstallKind === "package"
        ? await runPackageInstallUpdate({
            root,
            installKind,
            tag,
            timeoutMs: updateStepTimeoutMs,
            startedAt,
            progress,
            jsonMode: Boolean(opts.json),
          })
        : await runGitUpdate({
            root,
            switchToGit,
            installKind,
            timeoutMs,
            startedAt,
            progress,
            channel,
            tag,
            showProgress,
            opts,
            stop,
            devTargetRef,
          });
  } catch (err) {
    stop();
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    throw err;
  }

  stop();
  if (!opts.json || result.status !== "ok") {
    printResult(result, { ...opts, hideSteps: showProgress });
  }

  if (result.status === "error") {
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    if (result.reason === "dirty") {
      defaultRuntime.error(theme.error("Update blocked: local files are edited in this checkout."));
      defaultRuntime.log(
        theme.warn(
          "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
        ),
      );
      defaultRuntime.log(
        theme.muted("Commit, stash, or discard the local changes, then rerun `openclaw update`."),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  let postUpdateConfigSnapshot = configSnapshot;
  if (requestedChannel && configSnapshot.valid && requestedChannel !== storedChannel) {
    const next = {
      ...configSnapshot.sourceConfig,
      update: {
        ...configSnapshot.sourceConfig.update,
        channel: requestedChannel,
      },
    };
    await replaceConfigFile({
      nextConfig: next,
      baseHash: configSnapshot.hash,
    });
    postUpdateConfigSnapshot = {
      ...configSnapshot,
      hash: undefined,
      parsed: next,
      sourceConfig: asResolvedSourceConfig(next),
      resolved: asResolvedSourceConfig(next),
      runtimeConfig: asRuntimeConfig(next),
      config: asRuntimeConfig(next),
    };
    if (!opts.json) {
      defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
    }
  }

  const postUpdateRoot = result.root ?? root;

  let postCorePluginUpdate: PostCorePluginUpdateResult | undefined;
  let pluginsUpdatedInFreshProcess = false;
  if (
    shouldResumePostCoreUpdateInFreshProcess({
      result,
      downgradeRisk,
    })
  ) {
    const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
      root: postUpdateRoot,
      channel,
      opts,
    });
    pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
    postCorePluginUpdate = freshProcessResult.pluginUpdate;
  }

  if (!pluginsUpdatedInFreshProcess) {
    postCorePluginUpdate = await runPostCorePluginUpdate({
      root: postUpdateRoot,
      channel,
      configSnapshot: postUpdateConfigSnapshot,
      opts,
      timeoutMs: updateStepTimeoutMs,
    });
  }

  const resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
    ? {
        ...result,
        status: postCorePluginUpdate.status === "error" ? "error" : result.status,
        ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
        postUpdate: {
          ...result.postUpdate,
          plugins: postCorePluginUpdate,
        },
      }
    : result;

  if (postCorePluginUpdate?.status === "error") {
    if (opts.json) {
      defaultRuntime.writeJson(resultWithPostUpdate);
    } else {
      defaultRuntime.error(theme.error("Update failed during plugin post-update sync."));
    }
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnv = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  const gatewayPort = resolveGatewayPort(
    postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
    process.env,
  );
  if (shouldRestart) {
    try {
      const serviceState = await readGatewayServiceState(resolveGatewayService(), {
        env: process.env,
      });
      if (
        shouldPrepareUpdatedInstallRestart({
          updateMode: resultWithPostUpdate.mode,
          serviceInstalled: serviceState.installed,
          serviceLoaded: serviceState.loaded,
        })
      ) {
        gatewayServiceEnv = serviceState.env;
        restartScriptPath = await prepareRestartScript(serviceState.env, gatewayPort);
        refreshGatewayServiceEnv = true;
      }
    } catch {
      // Ignore errors during pre-check; fallback to standard restart
    }
  }

  await tryWriteCompletionCache(postUpdateRoot, Boolean(opts.json));
  await tryInstallShellCompletion({
    jsonMode: Boolean(opts.json),
    skipPrompt: Boolean(opts.yes),
  });

  const restartOk = await maybeRestartService({
    shouldRestart,
    result: resultWithPostUpdate,
    opts,
    refreshServiceEnv: refreshGatewayServiceEnv,
    serviceEnv: gatewayServiceEnv,
    gatewayPort,
    restartScriptPath,
    invocationCwd,
  });
  if (!restartOk) {
    defaultRuntime.exit(1);
    return;
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  } else {
    defaultRuntime.writeJson(resultWithPostUpdate);
  }
}
