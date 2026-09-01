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
  compareSemverStrings,
  resolveExtendedStablePackage,
  resolveNpmChannelTag,
  resolveUpdateInstallKind,
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
import {
  POST_CORE_UPDATE_CHANNEL_ENV,
  POST_CORE_UPDATE_ENV,
} from "../../infra/update-post-core-context.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { resolveCliName } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemas,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
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
  tryResolveInvocationCwd,
  type UpdateCommandOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { maybeRepairLegacyConfigForUpdateChannel } from "./update-command-config.js";
import { printUpdateDryRun } from "./update-command-dry-run.js";
import { reportPreMutationUpdateFailure } from "./update-command-result.js";
import { resolveServiceRefreshEnv } from "./update-command-service-env.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveManagedServicePackageUpdatePlan,
  resolvePackageRuntimePreflight,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";

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

async function withUpdateInProgressEnv<T>(
  invocationCwd: string | undefined,
  run: () => Promise<T>,
): Promise<T> {
  const env = resolveServiceRefreshEnv(process.env, invocationCwd);
  env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  const scopedKeys = Object.keys(env).filter(
    (key) => key === "OPENCLAW_UPDATE_IN_PROGRESS" || env[key] !== process.env[key],
  );
  const previousValues = scopedKeys.map((key) => [key, process.env[key]] as const);
  // Package replacement can remove cwd. All phase owners, including native
  // service guards, must share the invocation's already-resolved path selectors.
  for (const key of scopedKeys) {
    process.env[key] = env[key];
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of previousValues) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  const recoveryState: UpdateCommandRecoveryState = {};
  const invocationCwd = tryResolveInvocationCwd();
  return await withUpdateInProgressEnv(invocationCwd, async () => {
    try {
      await updateCommandInternal(opts, recoveryState, invocationCwd);
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
  invocationCwd: string | undefined,
): Promise<void> {
  const startedAt = Date.now();
  suppressDeprecations();
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
  }
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  let root = discoveredRoot;
  if (postCoreUpdateResume) {
    const { resumePostCoreUpdate } = await import("./update-execution.runtime.js");
    await resumePostCoreUpdate({
      root,
      channel: postCoreUpdateChannel,
      opts,
      timeoutMs: updateStepTimeoutMs,
    });
    return;
  }

  if (!opts.json) {
    defaultRuntime.log(theme.muted("Checking for updates..."));
  }
  const installKind = await resolveUpdateInstallKind(root);
  let updateInstallKind = installKind;
  const refuseUpdate = (reason: string, message?: string) =>
    reportPreMutationUpdateFailure({
      root,
      installKind: updateInstallKind,
      reason,
      message,
      opts,
      controlPlaneUpdateSentinelMeta,
    });

  if (requestedChannel === "extended-stable" && installKind === "git") {
    await refuseUpdate("unsupported_git_channel");
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
    await refuseUpdate(
      "invalid-config",
      ["Config is invalid; cannot set update channel.", ...issues].join("\n"),
    );
    return;
  }

  const channel =
    requestedChannel ??
    storedChannel ??
    (installKind === "git"
      ? DEFAULT_GIT_CHANNEL
      : resolveEffectiveUpdateChannel({
          currentVersion: VERSION,
          installKind,
        }).channel);
  if (channel === "extended-stable" && installKind === "git") {
    await refuseUpdate("unsupported_git_channel");
    return;
  }
  // An effective dev channel (stored or explicit) selects the git flow — the
  // documented dev contract is a git checkout. Exception: --tag is a one-run
  // package-target override, so it keeps a stored-dev package install on the
  // package path; only an explicitly requested dev channel outranks it.
  const explicitTag = normalizeTag(opts.tag);
  const switchToGit =
    installKind !== "git" &&
    (requestedChannel === "dev" || (channel === "dev" && explicitTag === null));
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  if (channel === "dev" && requestedChannel !== "dev") {
    const resolvedDevTarget = readDevUpdateTargetOrExit();
    if (!resolvedDevTarget.ok) {
      return;
    }
    devTarget = resolvedDevTarget.target;
  }

  const unsupportedMainTag = updateInstallKind === "package" && explicitTag === "main";
  if ((channel === "extended-stable" && explicitTag) || unsupportedMainTag) {
    await refuseUpdate(
      unsupportedMainTag ? "unsupported-package-target" : EXTENDED_STABLE_TAG_UNSUPPORTED_REASON,
      unsupportedMainTag
        ? "`--tag main` cannot update a package install. Run `openclaw update --channel dev` to switch to the supported Git checkout and build flow."
        : undefined,
    );
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
  let packageRuntimeTarget: { version: string; nodeEngine: string | null } | undefined;
  let managedServiceRootRedirect: ManagedServiceRootRedirect | null = null;
  // The service's Node can differ even when its package root matches the shell.
  let managedServiceNodeRunner: string | undefined;
  let packageUpdateNodeRunner: string | undefined;

  if (updateInstallKind === "package") {
    const servicePlan = await resolveManagedServicePackageUpdatePlan({ root });
    managedServiceRootRedirect = servicePlan.rootRedirect;
    managedServiceNodeRunner = servicePlan.nodeRunner;
    if (managedServiceRootRedirect) {
      root = managedServiceRootRedirect.root;
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
    } else if (managedServiceNodeRunner && !opts.json) {
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
    packageUpdateNodeRunner = managedServiceNodeRunner;
  }

  if (updateInstallKind !== "git") {
    packageInstallEnv = await createGlobalInstallEnv();
    packageInstallCwd = invocationCwd;
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
        await refuseUpdate("npm lifecycle policy preflight", npmLifecycleGate.error);
        return;
      }
    }
    const npmMetadataCommand =
      packageInstallTarget?.manager === "npm" ? packageInstallTarget.command : undefined;
    currentVersion = await readPackageVersion(root);
    if (channel === "extended-stable") {
      const extendedStable = await resolveExtendedStablePackage({
        installKind: updateInstallKind,
        timeoutMs,
        packageName: installedPackageName,
      });
      if (extendedStable.status === "failed") {
        await refuseUpdate(extendedStable.reason);
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
        await refuseUpdate(
          "target-metadata-preflight",
          `Update refused: could not inspect exact package target openclaw@${targetVersion}: ${targetMetadata.error ?? `registry returned version ${targetMetadata.version ?? "unknown"}`}.`,
        );
        return;
      }
      packageTargetSchemaVersions = targetMetadata.schemaVersions;
      // Runtime and schema checks must use the same exact package that will be
      // installed; rereading a mutable dist-tag can inspect a different release.
      packageRuntimeTarget = { version: targetVersion, nodeEngine: targetMetadata.nodeEngine };
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
    await refuseUpdate(
      "database-schema-preflight",
      formatSchemaRefusalLines(packageSchemaPreflight).join("\n"),
    );
    return;
  }

  if (opts.dryRun) {
    printUpdateDryRun({
      root,
      installKind,
      updateInstallKind,
      mode: updateInstallKind === "git" ? "git" : (packageInstallTarget?.manager ?? "unknown"),
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
      target: packageRuntimeTarget,
      timeoutMs,
      nodeRunner: managedServiceNodeRunner,
      fallbackNodeRunner: canRefreshManagedServiceNode ? resolveNodeRunner() : undefined,
    });
    if (!runtimePreflight.ok) {
      await refuseUpdate("node-runtime-preflight", runtimePreflight.error);
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

  // Preload execution and recovery before the package swap can remove these chunks.
  const { executeMutableUpdate, finishUpdate } = await import("./update-execution.runtime.js");

  // Cleanup deletes handoff directories, so previews and rejected invocations must never run it.
  await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);

  // Startup migrations belong to the freshly installed Doctor. Admit shared-state
  // mutation only after every pre-install refusal has passed.
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);

  const showProgress = !opts.json;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
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
