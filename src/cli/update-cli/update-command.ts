// Main update orchestration for source checkouts and package installs.
import { confirm, isCancel } from "@clack/prompts";
import { stylePromptMessage } from "../../../packages/terminal-core/src/prompt-style.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { formatErrorMessage } from "../../infra/errors.js";
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
} from "../../infra/update-check.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  resolveGlobalInstallSpec,
  resolveGlobalInstallTarget,
  resolveNpmLifecyclePolicyGate,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import { finishUpdateRun, recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { VERSION } from "../../version.js";
import { resolveCliName } from "../cli-name.js";
import { createUpdateProgress } from "./progress.js";
import {
  DEFAULT_PACKAGE_NAME,
  normalizeTag,
  readPackageName,
  readPackageVersion,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  tryResolveInvocationCwd,
  type UpdateCommandOptions,
} from "./shared.js";
import { maybeRepairLegacyConfigForUpdateChannel } from "./update-command-config.js";
import { printUpdateDryRun } from "./update-command-dry-run.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import {
  mergeWindowsTaskRecoveryFailure,
  reportPreMutationUpdateFailure,
  UpdateCommandFailure,
} from "./update-command-result.js";
import {
  admitUpdateCommandRun,
  completeUpdateCommandRun,
  createUpdateRunProgress,
  failUpdateCommandRun,
  prepareUpdateCommand,
  readDevUpdateTarget,
} from "./update-command-run.js";
import { preflightUpdateCommandSchemas } from "./update-command-schema.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import {
  gatewayServiceCommandUsesRoot,
  resolveManagedServicePackageUpdatePlan,
  resolvePackageRuntimePreflight,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import type { UpdateCommandRecoveryState } from "./update-command-service.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";

const CLI_NAME = resolveCliName();
const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

export async function updateCommand(inputOpts: UpdateCommandOptions): Promise<void> {
  const invocationCwd = tryResolveInvocationCwd();
  const recoveryState: UpdateCommandRecoveryState = {
    triageTarget: { env: resolveServiceRefreshEnv(process.env, invocationCwd) },
  };
  // Rejected arguments and handoffs must not open or recover persistent state.
  const prepared = await withUpdateInProgressEnv(invocationCwd, () =>
    prepareUpdateCommand(inputOpts),
  );
  // Post-core children report phase results; the outer updater owns the run ledger.
  if (prepared.postCoreUpdateResume) {
    return await withUpdateInProgressEnv(invocationCwd, async () => {
      const { resumePostCoreUpdate } = await import("./update-execution.runtime.js");
      await resumePostCoreUpdate({
        root: prepared.discoveredRoot,
        channel: prepared.postCoreUpdateChannel,
        opts: inputOpts,
        timeoutMs: prepared.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      });
    });
  }
  const run = await admitUpdateCommandRun({
    opts: inputOpts,
    root: prepared.servicePlan?.rootRedirect?.root ?? prepared.discoveredRoot,
    invocationCwd,
  });
  const opts = { ...inputOpts, run };
  prepared.controlPlaneUpdateSentinelMeta = {
    ...prepared.controlPlaneUpdateSentinelMeta,
    runId: run.runId,
  };
  recoveryState.triageTarget.root = prepared.discoveredRoot;
  const presentation = createUpdateProgress(!opts.json, run);
  try {
    await withUpdateFailureTriage(
      { ...opts, invocationCwd },
      recoveryState.triageTarget,
      async () => {
        await withUpdateInProgressEnv(invocationCwd, async () => {
          let failure: { error: unknown } | undefined;
          try {
            await updateCommandInternal(opts, recoveryState, invocationCwd, prepared, presentation);
          } catch (error) {
            failure = { error };
          }
          try {
            await recoveryState.windowsTaskAutoStartRecovery?.restore();
            await recoveryState.windowsTaskAutoStartRecovery?.complete();
          } catch (restoreError) {
            let error = restoreError;
            try {
              await recoveryState.windowsTaskAutoStartRecovery?.complete(false);
            } catch (compensationError) {
              error = new AggregateError(
                [error, compensationError],
                `Windows task autostart recovery failed: ${formatErrorMessage(error)}; ${formatErrorMessage(compensationError)}`,
                { cause: error },
              );
            }
            failure = mergeWindowsTaskRecoveryFailure(failure, error);
          }
          if (failure) {
            if (!recoveryState.ledgerHandoffOwned) {
              if (failure.error instanceof UpdateCommandFailure) {
                completeUpdateCommandRun(failure.error.result, run);
              } else {
                failUpdateCommandRun(failure.error, run);
              }
            }
            throw failure.error;
          }
        });
      },
    );
  } finally {
    presentation.dispose();
  }
}

async function updateCommandInternal(
  opts: UpdateCommandOptions,
  recoveryState: UpdateCommandRecoveryState,
  invocationCwd: string | undefined,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateCommand>>>,
  presentation: ReturnType<typeof createUpdateProgress>,
): Promise<void> {
  const {
    startedAt,
    timeoutMs,
    shouldRestart,
    requestedChannel,
    controlPlaneUpdateSentinelMeta,
    discoveredRoot,
    installKind,
  } = prepared;
  let { devTarget } = prepared;
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  let root = discoveredRoot;
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
    try {
      devTarget = readDevUpdateTarget();
    } catch (error) {
      failUpdateCommandRun(error, opts.run!);
      defaultRuntime.error(formatErrorMessage(error));
      defaultRuntime.exit(1);
      return;
    }
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
    const servicePlan =
      prepared.servicePlan ?? (await resolveManagedServicePackageUpdatePlan({ root }));
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
    recoveryState.triageTarget.root = root;
    recoveryState.triageTarget.nodeRunner = packageUpdateNodeRunner;
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
        runCommand: runCommandWithTimeout,
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
      currentVersion === targetVersion;
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

  const run = opts.run!;
  recordUpdateRunPhase(
    run.runId,
    "staging",
    {
      target: {
        channel,
        tag,
        ...(updateInstallKind !== "unknown" ? { kind: updateInstallKind } : {}),
        ...(targetVersion ? { version: targetVersion } : {}),
      },
      before: { version: currentVersion ?? VERSION },
    },
    { env: run.env },
  );
  const schemaPreflight = await preflightUpdateCommandSchemas({
    root,
    updateInstallKind,
    switchToGit,
    shouldRestart,
    updateStepTimeoutMs,
    invocationCwd,
    managedServiceRootRedirect,
    channel,
    devTarget,
    packageTargetSchemaVersions,
    opts,
    refuseUpdate,
  });
  if (!schemaPreflight) {
    return;
  }
  const { packageSchemaPreflight, preflightNotes } = schemaPreflight;

  if (opts.dryRun) {
    finishUpdateRun(run.runId, { status: "skipped", reason: "dry-run" }, { env: run.env });
    printUpdateDryRun({
      runId: run.runId,
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
      preflightNotes,
      opts,
    });
    return;
  }

  if (packageAlreadyCurrent) {
    const { finishAlreadyCurrentUpdate } = await import("./update-execution.runtime.js");
    await finishAlreadyCurrentUpdate({
      opts,
      result: {
        status: "skipped",
        mode: packageInstallTarget?.manager ?? "unknown",
        root,
        reason: "already-current",
        before: { version: currentVersion },
        after: { version: currentVersion },
        steps: [],
        durationMs: Date.now() - startedAt,
      },
    });
    return;
  }

  if (downgradeRisk && !opts.yes) {
    if (!process.stdin.isTTY || opts.json) {
      finishUpdateRun(
        run.runId,
        { status: "skipped", reason: "downgrade-confirmation-required" },
        { env: run.env },
      );
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
      finishUpdateRun(run.runId, { status: "skipped", reason: "cancelled" }, { env: run.env });
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
    recoveryState.triageTarget.nodeRunner = packageUpdateNodeRunner;
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
  const {
    executeMutableUpdate,
    finishUpdate,
    finishAlreadyCurrentUpdate,
    continueMigratedUpdateInFreshProcess,
    inspectActivatedUpdateState,
  } = await import("./update-execution.runtime.js");

  const { progress: displayProgress, stop } = presentation;
  const progress = createUpdateRunProgress(run, displayProgress);
  let preUpdatePluginInstallRecords: Awaited<
    ReturnType<typeof loadInstalledPluginIndexInstallRecords>
  > = {};
  let mutableUpdatePrepared = false;
  const prepareMutableUpdate = async (env?: NodeJS.ProcessEnv) => {
    if (mutableUpdatePrepared) {
      return;
    }
    // Cleanup, state-write admission and updater autostart belong after complete target admission.
    await withOwnedManagedUpdateEnv(env, async () => {
      await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
      await assertOpenClawStateWriteAllowedAtPath({
        databasePath: resolveOpenClawStateSqlitePath(process.env),
      });
      await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
      preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    });
    mutableUpdatePrepared = true;
  };

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
    prepareMutableUpdate,
    onActivation: () => {
      presentation.suspend();
      progress.deferLedgerWrites();
    },
  });
  if (!execution) {
    return;
  }
  const { result, preManagedServiceStop, ownedManagedUpdateContext, recoveryEnv } = execution;
  result.runId = run.runId;
  if (result.status === "skipped" && result.reason === "already-current") {
    stop();
    await finishAlreadyCurrentUpdate({ opts, result, env: ownedManagedUpdateContext?.env });
    return;
  }
  recoveryState.triageTarget.root = result.root ?? root;
  recoveryState.triageTarget.failureResult = result;
  recoveryState.triageTarget.env =
    recoveryEnv ?? ownedManagedUpdateContext?.env ?? recoveryState.triageTarget.env;
  const finalizationConfigSnapshot = ownedManagedUpdateContext?.configSnapshot ?? configSnapshot;
  stop();
  const finalization = {
    result,
    failure: execution.failure,
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
    preManagedServiceStop,
    ownedManagedUpdateEnv: ownedManagedUpdateContext?.env,
    controlPlaneUpdateSentinelMeta,
    preUpdatePluginInstallRecords:
      ownedManagedUpdateContext?.pluginInstallRecords ?? preUpdatePluginInstallRecords,
    startedAt,
    packageUpdateNodeRunner,
    updateStepTimeoutMs,
    invocationCwd,
    packageTransaction: execution.packageTransaction,
    schemaVersions: execution.schemaVersions,
    previousVerified: execution.previousVerified,
  };
  const rollbackBlockedReason = await inspectActivatedUpdateState({
    result,
    root,
    packageUpdateNodeRunner,
    schemaVersions: execution.schemaVersions,
    candidateSchemaVersions: execution.candidateSchemaVersions,
    config: finalizationConfigSnapshot.config,
    env: ownedManagedUpdateContext?.env ?? run.env,
  });
  if (rollbackBlockedReason) {
    // A migrated database belongs to the candidate runtime. The old process
    // must not reopen it, including during error reporting or outer cleanup.
    recoveryState.ledgerHandoffOwned = true;
    const continued = await continueMigratedUpdateInFreshProcess(
      { ...finalization, rollbackBlockedReason },
      progress.pendingSteps,
    );
    if (continued.exitCode !== 0) {
      throw new UpdateCommandFailure(continued.result, continued.exitCode);
    }
    return;
  }
  progress.flushLedgerWrites();
  presentation.resume();
  await finishUpdate(finalization);
}
