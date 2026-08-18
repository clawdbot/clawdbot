// Main update orchestration for source checkouts and package installs.
import { confirm, isCancel } from "@clack/prompts";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import {
  formatExternalSupervisorUpdateRequired,
  isGatewayExternallySupervised,
} from "../../infra/gateway-supervision.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
  normalizeUpdateChannel,
  resolveEffectiveUpdateChannel,
} from "../../infra/update-channels.js";
import { fetchNpmPackageTargetStatus } from "../../infra/update-check-package-target.js";
import {
  checkUpdateStatus,
  compareSemverStrings,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
} from "../../infra/update-check.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import {
  parseDevUpdateTargetEnv,
  type DevUpdateTarget,
  UPDATE_DEV_TARGET_REF_ENV,
} from "../../infra/update-dev-target.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { updateInstallRootsMatch } from "../../infra/update-install-root.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { resolveCliName } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  normalizeTag,
  parseTimeoutMsOrExit,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { maybeRepairLegacyConfigForUpdateChannel } from "./update-command-config.js";
import { printUpdateDryRun } from "./update-command-dry-run.js";
import { executeMutableUpdate } from "./update-command-execution.js";
import {
  checkTargetDatabaseSchemas,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./update-command-git.js";
import {
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
  reportPreMutationUpdateFailure,
} from "./update-command-post-core.js";
import { finishUpdate } from "./update-command-post-update.js";
import { resumePostCoreUpdate } from "./update-command-resume.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveManagedServiceNodeRunnerOverride,
  resolveManagedServicePackageUpdateRoot,
  resolvePackageRuntimePreflight,
  tryResolveInvocationCwd,
  type ManagedServiceRootRedirect,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";
export { updateFinalizeCommand } from "./update-command-post-core.js";

const CLI_NAME = resolveCliName();
const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

function readDevUpdateTargetOrExit(): { ok: true; target?: DevUpdateTarget } | { ok: false } {
  const parsed = parseDevUpdateTargetEnv(process.env);
  if (parsed.status === "invalid") {
    defaultRuntime.error(
      `Invalid internal ${UPDATE_DEV_TARGET_REF_ENV} contract; expected a plain Git ref or a supported tracked-target encoding.`,
    );
    defaultRuntime.exit(1);
    return { ok: false };
  }
  return parsed.status === "valid" ? { ok: true, target: parsed.target } : { ok: true };
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
  const invocationCwd = tryResolveInvocationCwd();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel !== undefined && !requestedChannel) {
    defaultRuntime.error(
      `--channel must be "stable", "extended-stable", "beta", or "dev" (got "${opts.channel}")`,
    );
    defaultRuntime.exit(1);
    return;
  }
  let devTarget: DevUpdateTarget | undefined;
  if (requestedChannel === "dev") {
    const resolvedDevTarget = readDevUpdateTargetOrExit();
    if (!resolvedDevTarget.ok) {
      return;
    }
    devTarget = resolvedDevTarget.target;
  }

  if (!postCoreUpdateResume && opts.dryRun !== true && isGatewayExternallySupervised()) {
    defaultRuntime.error(formatExternalSupervisorUpdateRequired());
    defaultRuntime.exit(1);
    return;
  }
  if (opts.dryRun !== true) {
    await assertOpenClawStateWriteAllowedAtPath({
      databasePath: resolveOpenClawStateSqlitePath(process.env),
      recoverOrphanedSidecars: false,
    });
  }
  const controlPlaneUpdateSentinelMeta = await readControlPlaneUpdateSentinelMeta();
  const discoveredRoot = await resolveUpdateRoot();
  const handoffRoot = controlPlaneUpdateSentinelMeta?.root;
  if (handoffRoot && !updateInstallRootsMatch(handoffRoot, discoveredRoot)) {
    defaultRuntime.error(
      `Managed update handoff root mismatch: expected ${handoffRoot}, running from ${discoveredRoot}.`,
    );
    defaultRuntime.exit(1);
    return;
  }
  if (opts.dryRun !== true) {
    try {
      assertConfigWriteAllowedInCurrentMode();
    } catch (err) {
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      throw err;
    }

    // Cleanup deletes handoff directories, so previews and rejected invocations must never run it.
    await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
  }
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  let root = discoveredRoot;
  if (postCoreUpdateResume) {
    await resumePostCoreUpdate({
      root,
      channel: postCoreUpdateChannel,
      opts,
      timeoutMs: updateStepTimeoutMs,
    });
    return;
  }

  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

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

  let configSnapshot = await readConfigFileSnapshot({
    skipPluginValidation: true,
    observe: false,
  });
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
    (installKind === "git"
      ? DEFAULT_GIT_CHANNEL
      : resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          installKind,
        }).channel);
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
  const channel =
    requestedChannel ??
    storedChannel ??
    (updateInstallKind === "git"
      ? DEFAULT_GIT_CHANNEL
      : resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          installKind: updateInstallKind,
        }).channel);
  if (channel === "dev" && requestedChannel !== "dev") {
    const resolvedDevTarget = readDevUpdateTargetOrExit();
    if (!resolvedDevTarget.ok) {
      return;
    }
    devTarget = resolvedDevTarget.target;
  }

  const explicitTag = normalizeTag(opts.tag);
  const unsupportedMainTag = updateInstallKind === "package" && explicitTag === "main";
  if ((channel === "extended-stable" && explicitTag) || unsupportedMainTag) {
    await reportPreMutationUpdateFailure({
      root,
      installKind: updateInstallKind,
      reason: unsupportedMainTag
        ? "unsupported-package-target"
        : EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
      message: unsupportedMainTag
        ? "`--tag main` cannot update a package install. Run `openclaw update --channel dev` to switch to the supported Git checkout and build flow."
        : undefined,
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
  let packageTargetSchemaVersions: OpenClawSchemaVersions | undefined;
  let managedServiceRootRedirect: ManagedServiceRootRedirect | null = null;
  // Resolved independently of the root redirect so it covers the common case
  // where the package root is the same but the user's PATH-resolved node
  // differs from the node baked into the managed gateway service unit.
  let managedServiceNodeRunner: string | undefined;
  let packageUpdateNodeRunner: string | undefined;

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
    packageUpdateNodeRunner = managedServiceNodeRunner;
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
      const npmLifecycleGate = resolveNpmLifecyclePolicyGate(packageInstallTarget);
      if (npmLifecycleGate.error) {
        await reportPreMutationUpdateFailure({
          root,
          installKind: updateInstallKind,
          reason: "npm lifecycle policy preflight",
          message: npmLifecycleGate.error,
          opts,
          controlPlaneUpdateSentinelMeta,
        });
        return;
      }
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
    if (targetVersion) {
      const targetMetadata = await fetchNpmPackageTargetStatus({
        target: targetVersion,
        spec: resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag: targetVersion,
          env: packageInstallEnv,
        }),
        command: npmMetadataCommand,
        timeoutMs,
        cwd: packageInstallCwd,
        env: packageInstallEnv,
      });
      if (targetMetadata.error || targetMetadata.version !== targetVersion) {
        defaultRuntime.error(
          `Update refused: could not inspect exact package target openclaw@${targetVersion}: ${targetMetadata.error ?? `registry returned version ${targetMetadata.version ?? "unknown"}`}.`,
        );
        defaultRuntime.exit(1);
        return;
      }
      packageTargetSchemaVersions = targetMetadata.schemaVersions;
      // Always install the exact inspected version: a dist-tag can move between
      // this lookup and the install, and an uninspected version would bypass
      // the schema and runtime decisions made here. Missing schema metadata
      // only means the schema preflight cannot run (legacy target).
      if (updateInstallKind === "package" && canResolveRegistryVersionForPackageTarget(tag)) {
        packageInstallSpec = resolveGlobalInstallSpec({
          packageName: DEFAULT_PACKAGE_NAME,
          tag: targetVersion,
          env: packageInstallEnv,
        });
      }
    }
  }

  const packageSchemaPreflight = checkTargetDatabaseSchemas(packageTargetSchemaVersions);
  if (!opts.dryRun && hasSchemaRefusal(packageSchemaPreflight)) {
    defaultRuntime.error(formatSchemaRefusalLines(packageSchemaPreflight).join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  if (opts.dryRun) {
    await printUpdateDryRun({
      root,
      installKind,
      updateInstallKind,
      switchToGit,
      switchToPackage,
      shouldRestart,
      requestedChannel,
      storedChannel,
      channel,
      tag,
      packageInstallSpec,
      currentVersion,
      targetVersion,
      downgradeRisk,
      packageAlreadyCurrent,
      fallbackToLatest,
      managedServiceRootRedirect,
      explicitTag,
      packageSchemaPreflight,
      timeoutMs: updateStepTimeoutMs,
      opts,
    });
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
    // Changing runners is safe only when this update owns and will rewrite the
    // service; otherwise the unchanged unit could still restart on the stale Node.
    const canRefreshManagedServiceNode =
      shouldRestart &&
      managedServiceNodeRunner !== undefined &&
      (await gatewayServiceCommandUsesRoot({ root })) === true;
    const runtimePreflight = await resolvePackageRuntimePreflight({
      tag,
      spec: packageInstallSpec ?? undefined,
      timeoutMs,
      nodeRunner: managedServiceNodeRunner,
      fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
      command: packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined,
      cwd: packageInstallCwd,
      env: packageInstallEnv,
    });
    if (!runtimePreflight.ok) {
      defaultRuntime.error(runtimePreflight.error);
      defaultRuntime.exit(1);
      return;
    }
    const runtimeSelection = runtimePreflight.value;
    packageUpdateNodeRunner = runtimeSelection.nodeRunner;
    if (runtimeSelection.replacedNodeRunner && !opts.json) {
      defaultRuntime.log(
        theme.warn(
          `Managed gateway service Node (${runtimeSelection.replacedNodeRunner}) cannot run openclaw@${runtimeSelection.targetVersion ?? tag}.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Using current Node (${packageUpdateNodeRunner}) and refreshing the managed service runtime after the update.`,
        ),
      );
    }
  }

  // Startup migrations belong to the freshly installed Doctor. Admit shared-state
  // mutation only after every pre-install refusal has passed.
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();
  const preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords();

  const execution = await executeMutableUpdate({
    root,
    installKind,
    updateInstallKind,
    switchToGit,
    timeoutMs,
    updateStepTimeoutMs,
    startedAt,
    progress,
    stop,
    channel,
    tag,
    showProgress,
    opts,
    shouldRestart,
    devTarget,
    packageInstallSpec,
    packageInstallEnv,
    packageInstallTarget,
    packageTargetSchemaVersions,
    packageUpdateNodeRunner,
    managedServiceNodeRunner,
    managedServiceRootRedirect,
    invocationCwd,
    recoveryState,
  });
  if (!execution) {
    return;
  }
  const { result, preManagedServiceStop, ownedManagedUpdateContext } = execution;
  const finalizationConfigSnapshot = ownedManagedUpdateContext?.configSnapshot ?? configSnapshot;
  const finalizationPluginInstallRecords =
    ownedManagedUpdateContext?.pluginInstallRecords ?? preUpdatePluginInstallRecords;
  stop();
  await finishUpdate({
    result,
    root,
    previousInstallRoot: discoveredRoot,
    installKindChanged: switchToGit || switchToPackage,
    configSnapshot: finalizationConfigSnapshot,
    requestedChannel,
    storedChannel,
    channel,
    downgradeRisk,
    shouldRestart,
    opts,
    showProgress,
    preManagedServiceStop,
    ownedManagedUpdateEnv: ownedManagedUpdateContext?.env,
    controlPlaneUpdateSentinelMeta,
    preUpdatePluginInstallRecords: finalizationPluginInstallRecords,
    startedAt,
    packageUpdateNodeRunner,
    updateStepTimeoutMs,
    invocationCwd,
  });
}
