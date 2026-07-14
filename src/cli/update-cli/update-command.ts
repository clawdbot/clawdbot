// Main update orchestration for source checkouts and package installs.
import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV,
  UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV,
  UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV,
  UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV,
} from "../../commands/doctor/shared/update-phase.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { readGatewayServiceState, resolveGatewayService } from "../../daemon/service.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import {
  markPackagePostInstallDoctorAdvisory,
  runGlobalPackageUpdateSteps,
} from "../../infra/package-update-steps.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
  normalizeUpdateChannel,
  type UpdateChannel,
} from "../../infra/update-channels.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  readControlPlaneUpdateSentinelMeta,
} from "../../infra/update-control-plane-sentinel.js";
import {
  consumeUpdatePostInstallDoctorResult,
  createUpdatePostInstallDoctorResultPath,
  UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV,
} from "../../infra/update-doctor-result.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
  resolvePnpmGlobalDirFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import {
  resolveUpdateDoctorExecutionPolicy,
  runGatewayUpdate,
  type UpdateRunResult,
} from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { prepareRestartScript } from "./restart-helper.js";
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
import {
  createUpdateConfigSnapshot,
  maybeRepairLegacyConfigForUpdateChannel,
  persistRequestedUpdateChannel,
  readPostCorePreUpdateSourceConfig,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  markControlPlaneUpdateRestartSentinelFailureBestEffort,
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
  POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV,
  POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV,
  POST_CORE_UPDATE_RESULT_PATH_ENV,
  readPostCorePluginInstallRecordsFile,
  reportPreMutationUpdateFailure,
  resolvePostCoreUpdateStartedAtMs,
  shouldResumePostCoreUpdateInFreshProcess,
  writeControlPlaneUpdateRestartSentinelBestEffort,
  writePostCorePluginUpdateResultFile,
} from "./update-command-post-core.js";
import {
  createAggregateErrorWithCause,
  gatewayServiceCommandUsesRoot,
  maybeRestartService,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveManagedServiceNodeRunnerOverride,
  resolveManagedServicePackageUpdateRoot,
  resolvePackageRuntimePreflightError,
  resolvePostInstallDoctorEnv,
  resolvePostUpdateServiceStateReadEnv,
  resolveUpdatedGatewayRestartPort,
  restoreWindowsTaskAutoStartOrExit,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  shouldPrepareUpdatedInstallRestart,
  tryInstallShellCompletion,
  tryResolveInvocationCwd,
  UpdateCommandAbort,
  type ManagedServiceRootRedirect,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";

export { updateFinalizeCommand } from "./update-command-post-core.js";

const CLI_NAME = resolveCliName();
const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

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

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
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
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  effectiveChannel: UpdateChannel;
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

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  installSpec?: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
  honorPackageRoot?: boolean;
  nodeRunner?: string;
  installEnv?: NodeJS.ProcessEnv;
  installTarget?: ResolvedGlobalInstallTarget;
}): Promise<UpdateRunResult> {
  const installEnv = params.installEnv ?? (await createGlobalInstallEnv());
  const runCommand = createGlobalCommandRunner();
  let installTarget = params.installTarget;
  if (!installTarget) {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: params.timeoutMs,
    });
    installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: params.timeoutMs,
      pkgRoot: params.root,
      honorPackageRoot: params.honorPackageRoot === true,
    });
  }
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec =
    params.installSpec ??
    resolveGlobalInstallSpec({
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
        await createUpdateConfigSnapshot();
        const candidateHostVersion = await readPackageVersion(verifiedPackageRoot);
        const doctorResultPath = createUpdatePostInstallDoctorResultPath();
        const doctorPolicy = resolveUpdateDoctorExecutionPolicy({
          targetVersion: candidateHostVersion,
          allowGatewayServiceRepair: params.allowGatewayServiceRepair,
        });
        const doctorArgv = [
          params.nodeRunner ?? resolveNodeRunner(),
          entryPath,
          "doctor",
          "--non-interactive",
          ...(doctorPolicy.fix ? ["--fix"] : []),
        ];
        const doctorProgressInfo = {
          name: `${CLI_NAME} doctor`,
          command: doctorArgv.join(" "),
          index: 0,
          total: 0,
        };
        params.progress?.onStepStart?.(doctorProgressInfo);
        const doctorStep = await runUpdateStep({
          name: `${CLI_NAME} doctor`,
          argv: doctorArgv,
          cwd: verifiedPackageRoot,
          env: {
            ...resolvePostInstallDoctorEnv({
              serviceEnv: params.managedServiceEnv,
              invocationCwd: params.invocationCwd,
            }),
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
            [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
            [UPDATE_PARENT_SUPPORTS_GATEWAY_RESTART_ENV]: "1",
            [UPDATE_PARENT_ALLOWS_GATEWAY_SERVICE_REPAIR_ENV]: params.allowGatewayServiceRepair
              ? "1"
              : "0",
            [UPDATE_PARENT_ALLOWS_GATEWAY_ACTIVATION_ENV]: params.allowGatewayActivation
              ? "1"
              : "0",
            ...(doctorPolicy.serviceRepairPolicy
              ? { OPENCLAW_SERVICE_REPAIR_POLICY: doctorPolicy.serviceRepairPolicy }
              : {}),
            [UPDATE_POST_INSTALL_DOCTOR_RESULT_PATH_ENV]: doctorResultPath,
            ...(candidateHostVersion === null
              ? {}
              : { OPENCLAW_COMPATIBILITY_HOST_VERSION: candidateHostVersion }),
          },
          timeoutMs: params.timeoutMs,
        });
        const doctorResult = await consumeUpdatePostInstallDoctorResult(doctorResultPath);
        const completedDoctorStep = markPackagePostInstallDoctorAdvisory(doctorStep, doctorResult);
        params.progress?.onStepComplete?.({
          ...doctorProgressInfo,
          durationMs: completedDoctorStep.durationMs,
          exitCode: completedDoctorStep.exitCode,
          stderrTail: completedDoctorStep.stderrTail,
          signal: completedDoctorStep.signal,
          killed: completedDoctorStep.killed,
          termination: completedDoctorStep.termination,
          advisory: completedDoctorStep.advisory,
        });
        return completedDoctorStep;
      }
      return null;
    },
  });

  return {
    status: packageUpdate.failedStep ? "error" : "ok",
    mode: installTarget.manager,
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
  channel: UpdateChannel;
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
  devTargetRef?: string;
  beforeGitMutation?: () => Promise<{
    allowGatewayServiceRepair?: boolean;
    allowGatewayActivation?: boolean;
  } | void>;
  allowGatewayServiceRepair: boolean;
  allowGatewayActivation: boolean;
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
    deferConfiguredPluginInstallRepair: true,
    allowGatewayServiceRepair: params.allowGatewayServiceRepair,
    allowGatewayActivation: params.allowGatewayActivation,
    beforeGitMutation: params.beforeGitMutation,
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
    const installLocation =
      installTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installTarget.globalRoot)
        : null;
    const installStep = await runUpdateStep({
      name: "global install",
      argv: globalInstallArgs(installTarget, updateRoot, undefined, installLocation),
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

async function withUpdateInProgressEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  return run().finally(() => {
    if (previousUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = previousUpdateInProgress;
    }
  });
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  const recoveryState: UpdateCommandRecoveryState = {};
  return await withUpdateInProgressEnv(async () => {
    try {
      await updateCommandInternal(opts, recoveryState);
    } finally {
      try {
        await recoveryState.windowsTaskAutoStartRecovery?.restore();
      } finally {
        recoveryState.windowsTaskAutoStartRecovery?.complete();
      }
    }
  });
}

async function updateCommandInternal(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
): Promise<void> {
  suppressDeprecations();
  await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
  const invocationCwd = tryResolveInvocationCwd();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();
  const postCoreRequestedChannelInput =
    process.env[POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]?.trim() ?? "";
  const postCoreInstallRecordsPath = process.env[POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV];

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }
  if (opts.dryRun !== true) {
    try {
      assertConfigWriteAllowedInCurrentMode();
    } catch (err) {
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      throw err;
    }
  }
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  let root = await resolveUpdateRoot();
  if (postCoreUpdateResume) {
    if (
      postCoreUpdateChannel !== "stable" &&
      postCoreUpdateChannel !== "extended-stable" &&
      postCoreUpdateChannel !== "beta" &&
      postCoreUpdateChannel !== "dev"
    ) {
      defaultRuntime.error("Missing post-core update channel context.");
      defaultRuntime.exit(1);
      return;
    }

    const postCoreRequestedChannel = postCoreRequestedChannelInput
      ? normalizeUpdateChannel(postCoreRequestedChannelInput)
      : null;
    if (postCoreRequestedChannelInput && !postCoreRequestedChannel) {
      defaultRuntime.error("Invalid post-core requested update channel context.");
      defaultRuntime.exit(1);
      return;
    }

    process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = (await readPackageVersion(root)) ?? VERSION;

    let postCoreConfigSnapshot = await readConfigFileSnapshot({
      skipPluginValidation: true,
      suppressFutureVersionWarning: true,
    });
    const preUpdateSourceConfig = await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: postCoreConfigSnapshot,
      updateStartedAtMs: await resolvePostCoreUpdateStartedAtMs(process.env),
    });
    postCoreConfigSnapshot = await persistRequestedUpdateChannel({
      configSnapshot: postCoreConfigSnapshot,
      requestedChannel: postCoreRequestedChannel,
    });
    const restoredPostCoreConfig = restoreDroppedPreUpdateChannels(
      postCoreConfigSnapshot,
      preUpdateSourceConfig,
    );
    const parentPluginInstallRecords = await readPostCorePluginInstallRecordsFile(
      postCoreInstallRecordsPath,
    );
    // The updated doctor may have repaired plugin installs before this fresh process resumed.
    const currentPluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    const pluginInstallRecords =
      Object.keys(currentPluginInstallRecords).length > 0
        ? currentPluginInstallRecords
        : parentPluginInstallRecords;

    const pluginUpdate = await updatePluginsAfterCoreUpdate({
      root,
      channel: postCoreUpdateChannel,
      configSnapshot: restoredPostCoreConfig.snapshot,
      configChanged: restoredPostCoreConfig.changed,
      restoredAuthoredChannels: restoredPostCoreConfig.authoredChannels,
      opts,
      timeoutMs: updateStepTimeoutMs,
      pluginInstallRecords,
    });
    if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
      await writePostCorePluginUpdateResultFile(
        process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
        pluginUpdate,
      );
    }
    if (opts.json) {
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
    defaultRuntime.exit(0);
    return;
  }

  const controlPlaneUpdateSentinelMeta = await readControlPlaneUpdateSentinelMeta();
  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
    defaultRuntime.exit(1);
    return;
  }

  if (requestedChannel === "extended-stable" && updateStatus.installKind === "git") {
    await reportPreMutationUpdateFailure({
      root,
      installKind: updateStatus.installKind,
      reason: "unsupported_git_channel",
      opts,
      controlPlaneUpdateSentinelMeta,
    });
    return;
  }

  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  if (opts.channel && !opts.dryRun && !configSnapshot.valid) {
    configSnapshot = await maybeRepairLegacyConfigForUpdateChannel({
      configSnapshot,
      jsonMode: Boolean(opts.json),
    });
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;

  if (opts.channel && !configSnapshot.valid) {
    const issues = formatConfigIssueLines(configSnapshot.issues, "-");
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  const selectedChannel =
    requestedChannel ??
    storedChannel ??
    (installKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL);
  if (selectedChannel === "extended-stable" && installKind === "git") {
    await reportPreMutationUpdateFailure({
      root,
      installKind,
      reason: "unsupported_git_channel",
      opts,
      controlPlaneUpdateSentinelMeta,
    });
    return;
  }
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
  if (channel === "extended-stable" && explicitTag) {
    await reportPreMutationUpdateFailure({
      root,
      installKind: updateInstallKind,
      reason: EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
      opts,
      controlPlaneUpdateSentinelMeta,
    });
    return;
  }
  let tag = explicitTag ?? channelToNpmTag(channel);
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let fallbackToLatest = false;
  let packageInstallSpec: string | null = null;
  let packageInstallEnv: NodeJS.ProcessEnv | undefined;
  let packageInstallCwd: string | undefined;
  let packageInstallTarget: ResolvedGlobalInstallTarget | undefined;
  let installedPackageName = DEFAULT_PACKAGE_NAME;
  let packageAlreadyCurrent = false;
  let managedServiceRootRedirect: ManagedServiceRootRedirect | null = null;
  // Resolved independently of the root redirect so it covers the common case
  // where the package root is the same but the user's PATH-resolved node
  // differs from the node baked into the managed gateway service unit.
  let managedServiceNodeRunner: string | undefined;

  if (updateInstallKind === "package") {
    managedServiceRootRedirect = await resolveManagedServicePackageUpdateRoot({ root });
    if (managedServiceRootRedirect) {
      root = managedServiceRootRedirect.root;
      managedServiceNodeRunner = managedServiceRootRedirect.nodeRunner;
      if (!opts.json) {
        defaultRuntime.log(
          theme.muted(
            `Targeting managed gateway service package root: ${managedServiceRootRedirect.root}`,
          ),
        );
        defaultRuntime.log(
          theme.warn(
            `Shell OpenClaw root differs from the managed gateway service root: ${managedServiceRootRedirect.previousRoot}`,
          ),
        );
        defaultRuntime.log(
          theme.muted(
            `After the update, make sure \`${CLI_NAME}\` on PATH resolves to the managed service root or reinstall the gateway service from the shell install you want to use.`,
          ),
        );
        if (managedServiceNodeRunner) {
          defaultRuntime.log(
            theme.muted(`Managed gateway service Node: ${managedServiceNodeRunner}`),
          );
        }
      }
    } else {
      // Roots match but the node binary may still differ (e.g. user switched
      // nvm/fnm/brew node after gateway install).
      managedServiceNodeRunner = await resolveManagedServiceNodeRunnerOverride();
      if (managedServiceNodeRunner && !opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Current Node (${resolveNodeRunner()}) differs from the managed gateway service Node (${managedServiceNodeRunner}).`,
          ),
        );
        defaultRuntime.log(
          theme.muted(
            `Using the managed service Node for this update so the gateway can start after the upgrade.`,
          ),
        );
      }
    }
  }

  if (updateInstallKind !== "git") {
    packageInstallEnv = await createGlobalInstallEnv();
    packageInstallCwd = tryResolveInvocationCwd();
    if (updateInstallKind === "package") {
      installedPackageName = (await readPackageName(root)) ?? DEFAULT_PACKAGE_NAME;
      const manager = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: updateStepTimeoutMs,
      });
      packageInstallTarget = await resolveGlobalInstallTarget({
        manager,
        runCommand: createGlobalCommandRunner(),
        timeoutMs: updateStepTimeoutMs,
        pkgRoot: root,
        honorPackageRoot:
          managedServiceRootRedirect !== null || managedServiceNodeRunner !== undefined,
        packageName: installedPackageName,
      });
    }
    const npmMetadataCommand =
      packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined;
    currentVersion = switchToPackage ? null : await readPackageVersion(root);
    if (channel === "extended-stable") {
      const extendedStable = await resolveExtendedStablePackage({
        installKind: updateInstallKind,
        timeoutMs,
        packageName: installedPackageName,
      });
      if (extendedStable.status === "failed") {
        await reportPreMutationUpdateFailure({
          root,
          installKind: updateInstallKind,
          reason: extendedStable.reason,
          opts,
          controlPlaneUpdateSentinelMeta,
        });
        return;
      }
      targetVersion = extendedStable.version;
      tag = extendedStable.version;
      packageInstallSpec = extendedStable.packageSpec;
    } else if (explicitTag) {
      const explicitSpec = resolveGlobalInstallSpec({
        packageName: DEFAULT_PACKAGE_NAME,
        tag,
        env: packageInstallEnv,
      });
      targetVersion = await resolveTargetVersion(tag, timeoutMs, {
        spec: explicitSpec,
        command: npmMetadataCommand,
        cwd: packageInstallCwd,
        env: packageInstallEnv,
      });
    } else {
      targetVersion = await resolveNpmChannelTag({
        channel,
        timeoutMs,
        command: npmMetadataCommand,
        cwd: packageInstallCwd,
        env: packageInstallEnv,
      }).then((resolved) => {
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
      (targetVersion == null ? tag !== "latest" : cmp != null && cmp > 0);
    packageInstallSpec ??= resolveGlobalInstallSpec({
      packageName: DEFAULT_PACKAGE_NAME,
      tag,
      env: packageInstallEnv,
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
    if (managedServiceRootRedirect) {
      notes.push(
        `Package update targets managed service root ${managedServiceRootRedirect.root} instead of invoking root ${managedServiceRootRedirect.previousRoot}.`,
      );
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
      spec: packageInstallSpec ?? undefined,
      timeoutMs,
      nodeRunner: managedServiceNodeRunner,
      command: packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined,
      cwd: packageInstallCwd,
      env: packageInstallEnv,
    });
    if (runtimePreflightError) {
      defaultRuntime.error(runtimePreflightError);
      defaultRuntime.exit(1);
      return;
    }
  }

  await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();
  const preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords();

  let preManagedServiceStop: PreManagedServiceStop | undefined;
  const gitMutationRoots =
    updateInstallKind === "git" ? (switchToGit ? [root, resolveGitInstallDir()] : [root]) : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [root],
  ) => {
    if (updateInstallKind !== "package" && updateInstallKind !== "git") {
      return;
    }
    try {
      const uniqueMutationRoots = Array.from(new Set(mutationRoots));
      for (const mutationRoot of uniqueMutationRoots) {
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind,
          root: mutationRoot,
          shouldRestart,
          jsonMode: Boolean(opts.json),
        });
        if (preManagedServiceStop.windowsTaskAutoStartRecovery) {
          recoveryState.windowsTaskAutoStartRecovery =
            preManagedServiceStop.windowsTaskAutoStartRecovery;
        }
        if (
          preManagedServiceStop.stopped ||
          preManagedServiceStop.blockMessage ||
          shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) ||
          !preManagedServiceStop.inspected ||
          !preManagedServiceStop.running ||
          !shouldRestart
        ) {
          break;
        }
      }
    } catch (err) {
      if (err instanceof UpdateCommandAbort) {
        throw err;
      }
      stop();
      defaultRuntime.error(`Failed to stop managed gateway service before update: ${String(err)}`);
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }

    if (preManagedServiceStop?.blockMessage) {
      stop();
      defaultRuntime.error(preManagedServiceStop.blockMessage);
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      stop();
      const updateLabel = updateInstallKind === "git" ? "Git updates" : "Package updates";
      defaultRuntime.error(
        [
          `${updateLabel} cannot run from inside the gateway service process.`,
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`,
        ].join("\n"),
      );
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }
  };

  if (updateInstallKind === "package") {
    try {
      await stopManagedServiceBeforeMutableUpdate();
    } catch (err) {
      if (err instanceof UpdateCommandAbort) {
        return;
      }
      throw err;
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
            installSpec: packageInstallSpec ?? undefined,
            timeoutMs: updateStepTimeoutMs,
            startedAt,
            progress,
            jsonMode: Boolean(opts.json),
            allowGatewayServiceRepair: preManagedServiceStop?.serviceMatchesMutationRoot === true,
            allowGatewayActivation:
              shouldRestart &&
              preManagedServiceStop?.stopped === true &&
              preManagedServiceStop.serviceMatchesMutationRoot === true,
            managedServiceEnv: preManagedServiceStop?.serviceEnv,
            invocationCwd,
            honorPackageRoot:
              managedServiceRootRedirect !== null || managedServiceNodeRunner !== undefined,
            nodeRunner: managedServiceNodeRunner,
            installEnv: packageInstallEnv,
            installTarget: packageInstallTarget,
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
            beforeGitMutation:
              updateInstallKind === "git"
                ? async () => {
                    await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? [root]);
                    return {
                      // Only a positively owned service may be rewritten. Activation
                      // additionally requires this update to have stopped it.
                      allowGatewayServiceRepair:
                        preManagedServiceStop?.serviceMatchesMutationRoot === true,
                      allowGatewayActivation:
                        shouldRestart &&
                        preManagedServiceStop?.stopped === true &&
                        preManagedServiceStop.serviceMatchesMutationRoot === true,
                    };
                  }
                : undefined,
            allowGatewayServiceRepair: false,
            allowGatewayActivation: false,
          });
  } catch (err) {
    stop();
    if (err instanceof UpdateCommandAbort) {
      return;
    }
    try {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(preManagedServiceStop);
    } catch (resumeErr) {
      recoveryState.windowsTaskAutoStartRecovery?.complete();
      recoveryState.windowsTaskAutoStartRecovery = undefined;
      throw createAggregateErrorWithCause(
        [err, resumeErr],
        `Update failed (${String(err)}) and Windows Scheduled Task autostart could not be restored (${String(resumeErr)})`,
        err,
      );
    }
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop,
      jsonMode: Boolean(opts.json),
    });
    throw err;
  }

  stop();
  if (!opts.json || result.status !== "ok") {
    printResult(result, { ...opts, hideSteps: showProgress });
  }

  if (result.status === "error") {
    if (!(await restoreWindowsTaskAutoStartOrExit(preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(opts.json),
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop,
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    if (!(await restoreWindowsTaskAutoStartOrExit(preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(opts.json),
    });
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop,
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

  const shouldResumePostCoreInFreshProcess = shouldResumePostCoreUpdateInFreshProcess({
    result,
    downgradeRisk,
  });

  let postUpdateConfigSnapshot =
    result.status === "ok" && !opts.dryRun
      ? await readConfigFileSnapshot({
          skipPluginValidation: true,
          suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
        })
      : configSnapshot;
  if (!shouldResumePostCoreInFreshProcess) {
    postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
      configSnapshot: postUpdateConfigSnapshot,
      requestedChannel,
    });
  }
  if (
    requestedChannel &&
    configSnapshot.valid &&
    requestedChannel !== storedChannel &&
    !shouldResumePostCoreInFreshProcess &&
    !opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
  } else if (
    requestedChannel &&
    configSnapshot.valid &&
    requestedChannel !== storedChannel &&
    shouldResumePostCoreInFreshProcess &&
    !opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel will be set to ${requestedChannel}.`));
  }

  const postUpdateRoot = result.root ?? root;

  let postCorePluginUpdate: PostCorePluginUpdateResult | undefined;
  let pluginsUpdatedInFreshProcess = false;
  if (shouldResumePostCoreInFreshProcess) {
    const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
      root: postUpdateRoot,
      channel,
      requestedChannel,
      opts,
      pluginInstallRecords: preUpdatePluginInstallRecords,
      updateStartedAtMs: startedAt,
      nodeRunner: managedServiceNodeRunner,
      preUpdateConfig: configSnapshot.valid
        ? {
            sourceConfig: configSnapshot.sourceConfig,
            authoredConfig: isRecord(configSnapshot.parsed)
              ? (configSnapshot.parsed as OpenClawConfig)
              : configSnapshot.sourceConfig,
          }
        : undefined,
    });
    if (freshProcessResult.exitCode !== undefined) {
      if (!(await restoreWindowsTaskAutoStartOrExit(preManagedServiceStop))) {
        return;
      }
      defaultRuntime.exit(freshProcessResult.exitCode);
      throw new Error(`post-update process exited with code ${freshProcessResult.exitCode}`);
    }
    pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
    postCorePluginUpdate = freshProcessResult.pluginUpdate;
  }

  if (!pluginsUpdatedInFreshProcess) {
    if (shouldResumePostCoreInFreshProcess) {
      postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
        configSnapshot: postUpdateConfigSnapshot,
        requestedChannel,
      });
    }
    const restoredConfig = restoreDroppedPreUpdateChannels(
      postUpdateConfigSnapshot,
      configSnapshot.valid
        ? {
            sourceConfig: configSnapshot.sourceConfig,
            authoredConfig: isRecord(configSnapshot.parsed)
              ? (configSnapshot.parsed as OpenClawConfig)
              : configSnapshot.sourceConfig,
          }
        : undefined,
    );
    postUpdateConfigSnapshot = restoredConfig.snapshot;
    // Current-process post-core convergence still reports the pre-update
    // VERSION. During downgrades, pin compatibility checks to the installed
    // target so incompatible newer plugins are disabled before restart.
    const postUpdateInstalledVersion = await readPackageVersion(postUpdateRoot);
    const versionComparison =
      postUpdateInstalledVersion && VERSION
        ? compareSemverStrings(VERSION, postUpdateInstalledVersion)
        : null;
    const compatibilityDowngradeTarget =
      versionComparison != null && versionComparison > 0 ? postUpdateInstalledVersion : null;
    const previousCompatibilityHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    if (compatibilityDowngradeTarget) {
      process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityDowngradeTarget;
    }
    try {
      postCorePluginUpdate = await updatePluginsAfterCoreUpdate({
        root: postUpdateRoot,
        channel,
        configSnapshot: postUpdateConfigSnapshot,
        configChanged: restoredConfig.changed,
        restoredAuthoredChannels: restoredConfig.authoredChannels,
        opts,
        timeoutMs: updateStepTimeoutMs,
        pluginInstallRecords: preUpdatePluginInstallRecords,
      });
    } finally {
      if (compatibilityDowngradeTarget) {
        if (previousCompatibilityHostVersion === undefined) {
          delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        } else {
          process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
        }
      }
    }
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
    if (!(await restoreWindowsTaskAutoStartOrExit(preManagedServiceStop))) {
      return;
    }
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result: resultWithPostUpdate,
      jsonMode: Boolean(opts.json),
    });
    if (opts.json) {
      defaultRuntime.writeJson(resultWithPostUpdate);
    } else {
      defaultRuntime.error(theme.error("Update failed during plugin post-update sync."));
    }
    defaultRuntime.exit(1);
    return;
  }

  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnvLocal = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  let skipLegacyServiceRestart = false;
  let gatewayPort = resolveUpdatedGatewayRestartPort({
    config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
    processEnv: process.env,
  });
  if (shouldRestart) {
    try {
      const serviceState = await readGatewayServiceState(resolveGatewayService(), {
        env: resolvePostUpdateServiceStateReadEnv({
          updateMode: resultWithPostUpdate.mode,
          processEnv: process.env,
          preManagedServiceEnv: preManagedServiceStop?.serviceEnv,
        }),
      });
      const serviceMatchesUpdateRoot =
        (await gatewayServiceCommandUsesRoot({
          root: postUpdateRoot,
          command: serviceState.command,
        })) ?? undefined;
      const serviceOwnershipConfirmed =
        preManagedServiceStop?.serviceMatchesMutationRoot === true ||
        serviceMatchesUpdateRoot === true;
      const knownForeignService =
        preManagedServiceStop?.serviceMatchesMutationRoot === false &&
        serviceMatchesUpdateRoot !== true;
      skipLegacyServiceRestart =
        knownForeignService ||
        (resultWithPostUpdate.mode === "git" &&
          serviceState.installed &&
          serviceState.loaded &&
          preManagedServiceStop?.stopped !== true &&
          serviceMatchesUpdateRoot === false);
      if (
        !knownForeignService &&
        shouldPrepareUpdatedInstallRestart({
          updateMode: resultWithPostUpdate.mode,
          serviceInstalled: serviceState.installed,
          serviceLoaded: serviceState.loaded,
          serviceStoppedForUpdate: preManagedServiceStop?.stopped,
          serviceMatchesMutationRoot: serviceOwnershipConfirmed
            ? true
            : preManagedServiceStop?.serviceMatchesMutationRoot,
          serviceMatchesUpdateRoot,
        })
      ) {
        gatewayServiceEnv = serviceState.env;
        gatewayPort = resolveUpdatedGatewayRestartPort({
          config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
          processEnv: process.env,
          serviceEnv: gatewayServiceEnv,
        });
        restartScriptPath = await prepareRestartScript(serviceState.env, gatewayPort);
        // An ambiguous wrapper may be stopped and restored, but only proven
        // ownership authorizes rewriting the service definition.
        refreshGatewayServiceEnvLocal = serviceOwnershipConfirmed;
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

  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: controlPlaneUpdateSentinelMeta,
    result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
    jsonMode: Boolean(opts.json),
  });

  if (!(await restoreWindowsTaskAutoStartOrExit(preManagedServiceStop))) {
    return;
  }
  const restartOk = await maybeRestartService({
    shouldRestart,
    result: resultWithPostUpdate,
    opts,
    refreshServiceEnv: refreshGatewayServiceEnvLocal,
    serviceEnv: gatewayServiceEnv,
    gatewayPort,
    restartScriptPath,
    invocationCwd,
    nodeRunner: managedServiceNodeRunner,
    skipLegacyServiceRestart,
    requireRunningServiceAfterRestart:
      resultWithPostUpdate.mode === "git" && preManagedServiceStop?.stopped === true,
  });
  if (!restartOk) {
    await markControlPlaneUpdateRestartSentinelFailureBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      reason: "restart-unhealthy",
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: controlPlaneUpdateSentinelMeta,
    result: resultWithPostUpdate,
    jsonMode: Boolean(opts.json),
  });

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  } else {
    defaultRuntime.writeJson(resultWithPostUpdate);
  }
}
