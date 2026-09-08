import path from "node:path";
import { readConfigFileSnapshot } from "../../config/config.js";
import { resolveStateDir } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { resolveGatewayService } from "../../daemon/service.js";
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { tryReadJson } from "../../infra/json-files.js";
import type { PackageUpdateTransaction } from "../../infra/package-update-steps.js";
import { validateUpdateCandidateCanary } from "../../infra/update-candidate-canary.js";
import type { UpdateCandidateRehearsal } from "../../infra/update-candidate-rehearsal.js";
import { readUpdateStateSchemaVersions } from "../../infra/update-candidate-state.js";
import { readControlPlaneUpdateSentinelMeta } from "../../infra/update-control-plane-sentinel.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import { readBuiltGatewayBuildId } from "../../infra/update-git-runtime.js";
import {
  canResolveRegistryVersionForPackageTarget,
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { activateManagedServiceUpdateHandoff } from "../../infra/update-managed-service-handoff.js";
import { recordUpdateRunPhase, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import {
  parsePackageOpenClawSchemaVersions,
  type OpenClawSchemaVersions,
} from "../../state/openclaw-schema-versions.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import {
  inspectGatewayRestart,
  waitForGatewayHttpReadiness,
} from "../daemon-cli/restart-health.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemasForContexts,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  normalizeTag,
  readPackageVersion,
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import type { UpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import { inspectUpdateDatabaseContexts } from "./update-command-database-context.js";
import { createBeforeGitMutation, updateGitInstall } from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdateContext,
  revalidateUpdateDatabaseContext,
  withOwnedManagedUpdateEnv,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import {
  runPackageInstallUpdate,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";
import { runUpdateCommandRepair } from "./update-command-repair.js";
import {
  GatewayServiceUpdateOwnershipError,
  gatewayServiceCommandUsesRoot,
  type ManagedServiceRootRedirect,
} from "./update-command-service-plan.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolveUpdatedGatewayRestartPort,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";

const CLI_NAME = resolveCliName();

type MutableUpdateExecutionResult = {
  mutationStarted: boolean;
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  recoveryEnv: NodeJS.ProcessEnv | undefined;
  packageTransaction?: PackageUpdateTransaction;
  schemaVersions?: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>>;
  candidateSchemaVersions?: OpenClawSchemaVersions;
  previousSchemaVersions?: OpenClawSchemaVersions;
  previousVerified?: boolean;
  activationConfig?: UpdateConfigSnapshot;
};

export async function executeMutableUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  timeoutMs: number | undefined;
  updateStepTimeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  stop: () => void;
  channel: "stable" | "extended-stable" | "beta" | "dev";
  tag: string;
  opts: UpdateCommandOptions;
  shouldRestart: boolean;
  devTarget?: DevUpdateTarget;
  packageInstallSpec: string | null;
  packageInstallEnv?: NodeJS.ProcessEnv;
  packageInstallTarget?: ResolvedGlobalInstallTarget;
  packageTargetVersion?: string;
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageUpdateNodeRunner?: string;
  managedServiceNodeRunner?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  invocationCwd?: string;
  recoveryState: UpdateCommandRecoveryState;
  prepareMutableUpdate: (env?: NodeJS.ProcessEnv) => Promise<void>;
  onActivation?: () => void;
}): Promise<MutableUpdateExecutionResult | null> {
  const stagedPluginAdmission =
    params.updateInstallKind === "package" &&
    !canResolveRegistryVersionForPackageTarget(params.packageInstallSpec ?? params.tag);
  let preManagedServiceStop: PreManagedServiceStop | undefined;
  let ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  let admission: Awaited<ReturnType<typeof inspectUpdateDatabaseContexts>> | undefined;
  let gitContextPrepared = false;
  let admittedTargetSchemaVersions = params.packageTargetSchemaVersions;
  const recheckSchemas = async (versions: OpenClawSchemaVersions | undefined) => {
    if (!admission) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        "Database admission was not inspected.",
      );
    }
    await inspectUpdateDatabaseContexts({
      roots: [...admission.services.keys()],
      updateInstallKind: params.updateInstallKind === "git" ? "git" : "package",
      shouldRestart: params.shouldRestart,
      jsonMode: Boolean(params.opts.json),
      timeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
      managedServiceRootRedirect: params.managedServiceRootRedirect,
      expectedServices: admission.services,
    });
    admission.contexts = await Promise.all(admission.contexts.map(revalidateUpdateDatabaseContext));
    const schemas = await checkTargetDatabaseSchemasForContexts(versions, admission.contexts);
    if (hasSchemaRefusal(schemas)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(schemas).join("\n"),
      );
    }
    admittedTargetSchemaVersions = versions;
  };
  const preflightPlugins = async (targetVersion: string | null) => {
    await recheckSchemas(params.packageTargetSchemaVersions);
    const { preflightConfiguredNpmPluginTargets } =
      await import("./update-command-plugin-preflight.js");
    const context = admission!.contexts.at(-1)!;
    await preflightConfiguredNpmPluginTargets({
      config: context.configSnapshot.sourceConfig,
      env: context.env,
      targetVersion,
      channel: params.channel,
      timeoutMs: params.updateStepTimeoutMs,
    });
    await recheckSchemas(params.packageTargetSchemaVersions);
  };
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
  let packageTransaction: PackageUpdateTransaction | undefined;
  let schemaVersions: Awaited<ReturnType<typeof readUpdateStateSchemaVersions>> | undefined;
  let candidateSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousSchemaVersions: OpenClawSchemaVersions | undefined;
  let previousVerified = false;
  let activationConfig: MutableUpdateExecutionResult["activationConfig"];
  const onConfigSnapshot: PackageInstallUpdateParams["onConfigSnapshot"] = (snapshot) => {
    activationConfig = snapshot;
  };
  let candidateFailureReason: string | undefined;
  let validatedConfigSnapshot: { config: OpenClawConfig; hash?: string | null } | undefined;
  const originalRecovery = () =>
    params.installKind === "git"
      ? readCurrentGitUpdateRecovery(params.root)
      : verifyPackageUpdateRecovery(params.root);
  const recoverStoppedService = async () =>
    maybeRestartServiceAfterFailedMutableUpdate({
      recovery: await originalRecovery(),
      preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
      nodeRunner: params.packageUpdateNodeRunner,
      timeoutMs: params.updateStepTimeoutMs,
      invocationCwd: params.invocationCwd,
    });
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [params.root],
    phase: "inspect" | "prepare" = "prepare",
  ) => {
    if (params.updateInstallKind !== "package" && params.updateInstallKind !== "git") {
      return;
    }
    try {
      const uniqueMutationRoots = Array.from(new Set(mutationRoots));
      for (const mutationRoot of uniqueMutationRoots) {
        preManagedServiceStop = await maybeStopManagedServiceBeforeMutableUpdate({
          updateInstallKind: params.updateInstallKind,
          root: mutationRoot,
          shouldRestart: params.shouldRestart,
          jsonMode: Boolean(params.opts.json),
          timeoutMs: params.updateStepTimeoutMs,
          phase,
          expectedService: admission?.services.get(mutationRoot),
          updateRun: params.opts.run,
          onStopped: (state) => {
            preManagedServiceStop = state;
          },
          handoffFromGateway: (state) =>
            handoffUpdateFromGateway({
              state,
              root: mutationRoot,
              opts: params.opts,
              // Pin the inspected package. Extended-stable resolves its protected
              // selector again because its public CLI contract forbids --tag.
              tag:
                params.updateInstallKind === "package" && params.channel !== "extended-stable"
                  ? (normalizeTag(params.packageInstallSpec) ?? undefined)
                  : undefined,
              mode:
                params.updateInstallKind === "git"
                  ? "git"
                  : (params.packageInstallTarget?.manager ?? "unknown"),
              timeoutMs: params.updateStepTimeoutMs,
              devTarget: params.devTarget,
              nodeRunner: params.packageUpdateNodeRunner,
              invocationCwd: params.invocationCwd,
              stopProgress: params.stop,
            }),
        });
        if (preManagedServiceStop.windowsTaskAutoStartRecovery) {
          params.recoveryState.windowsTaskAutoStartRecovery =
            preManagedServiceStop.windowsTaskAutoStartRecovery;
        }
        if (
          preManagedServiceStop.stopped ||
          preManagedServiceStop.serviceUpdateVerdict?.kind === "owned" ||
          preManagedServiceStop.blockMessage ||
          shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop }) ||
          !preManagedServiceStop.inspected ||
          !preManagedServiceStop.running ||
          !params.shouldRestart
        ) {
          break;
        }
      }
    } catch (err) {
      if (err instanceof ScheduledTaskAutoStartRecoveryError) {
        recoveryEnv = err.serviceEnv;
        params.recoveryState.triageTarget.env = err.serviceEnv;
        throw err;
      }
      if (err instanceof UpdateCommandAbort || err instanceof UpdatePreMutationError) {
        throw err;
      }
      if (err instanceof GatewayServiceUpdateOwnershipError) {
        throw new UpdatePreMutationError("managed-service-preflight", err.message);
      }
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-stop-failed",
        `Failed to stop managed gateway service before update: ${String(err)}`,
        { cause: err },
      );
    }

    if (phase === "inspect" && preManagedServiceStop?.serviceUpdateVerdict?.kind === "foreign") {
      preManagedServiceStop = undefined;
    }

    try {
      ownedManagedUpdateContext = await captureOwnedManagedUpdateContext({
        stopState: preManagedServiceStop,
        processEnv: process.env,
        invocationCwd: params.invocationCwd,
      });
      if (ownedManagedUpdateContext) {
        params.recoveryState.triageTarget.env = ownedManagedUpdateContext.env;
      }
    } catch (err) {
      params.stop();
      await recoverStoppedService();
      throw new Error(`Failed to capture managed gateway update state: ${String(err)}`, {
        cause: err,
      });
    }

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        [
          `${updateLabel} cannot run from inside the gateway service process.`,
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a terminal outside the gateway service.`,
        ].join("\n"),
      );
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      throw new UpdatePreMutationError(
        "managed-service-preflight",
        formatUpdateAncestryBlockMessage(preManagedServiceStop.blockMessage),
      );
    }
  };

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  let mutationStarted = false;
  const validateCandidate = async (root: string) => {
    const env = ownedManagedUpdateContext?.env ?? params.opts.run?.env ?? process.env;
    if (params.opts.run) {
      recordUpdateRunPhase(params.opts.run.runId, "validating", undefined, {
        env: params.opts.run.env,
      });
    }
    const validate = async (
      signal?: AbortSignal,
      rehearsal?: UpdateCandidateRehearsal,
      assertCurrent?: () => void,
    ) => {
      signal?.throwIfAborted();
      if (stagedPluginAdmission) {
        // Explicit artifacts acquire their version from the private staged package,
        // before rehearsal or activation can mutate any serving state.
        try {
          await preflightPlugins(await readPackageVersion(root));
          signal?.throwIfAborted();
          assertCurrent?.();
          await params.prepareMutableUpdate(
            ownedManagedUpdateContext?.env ?? admission?.managedEnv,
          );
          signal?.throwIfAborted();
          assertCurrent?.();
        } catch (error) {
          if (error instanceof UpdatePreMutationError) {
            candidateFailureReason = error.reason;
          }
          throw error;
        }
      }
      const snapshot = rehearsal
        ? { config: rehearsal.sourceConfig, hash: rehearsal.sourceConfigHash }
        : (validatedConfigSnapshot ??
          (await withOwnedManagedUpdateEnv(env, () =>
            readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
          )));
      const validation = await validateUpdateCandidateCanary({
        root,
        config: snapshot.config,
        stateDir: resolveStateDir(env),
        env,
        signal,
        rehearsal,
        assertCurrent,
        nodeRunner: params.packageUpdateNodeRunner,
        timeoutMs: Math.min(params.updateStepTimeoutMs, 5 * 60_000),
        onStep: (step) => {
          params.progress?.onStepComplete?.({ ...step, index: 0, total: 0 });
        },
      });
      if (validation.status === "ok") {
        validatedConfigSnapshot = snapshot;
        candidateSchemaVersions = validation.candidateSchemaVersions;
      }
      return validation;
    };
    let validation = await validate();
    if (validation.status === "error") {
      candidateFailureReason = validation.reason;
      const repair = await runUpdateCommandRepair({
        root: params.root,
        candidateRoot: root,
        env,
        run: params.opts.run,
        phase: "validating",
        nodeRunner: params.packageUpdateNodeRunner,
        result: {
          status: "error",
          mode:
            params.updateInstallKind === "git"
              ? "git"
              : (params.packageInstallTarget?.manager ?? "unknown"),
          root,
          reason: validation.reason,
          before: { version: await readPackageVersion(params.root) },
          after: { version: await readPackageVersion(root) },
          steps: validation.steps,
          durationMs: validation.durationMs,
        },
        validate: async (signal, assertCurrent, rehearsal) => {
          const repairValidation = await validate(signal, rehearsal, assertCurrent);
          return {
            ok: repairValidation.status === "ok",
            score: repairValidation.steps.filter((step) => step.exitCode === 0).length,
            summary:
              repairValidation.status === "ok"
                ? "Candidate validation passed."
                : repairValidation.logTail.join("\n"),
          };
        },
      });
      if (repair.status !== "repaired") {
        if (
          repair.reason === "repair-requires-config-change" ||
          repair.reason === "requester-revoked"
        ) {
          candidateFailureReason = repair.reason;
        }
        return validation.steps;
      }
      candidateFailureReason = undefined;
      // Repair's disposable state is gone; only surviving candidate changes may authorize activation.
      validation = await validate();
      if (validation.status === "error") {
        candidateFailureReason = validation.reason;
      }
    }
    return validation.steps;
  };
  const beforeActivate = async (roots: readonly string[] = [params.root]) => {
    const env = ownedManagedUpdateContext?.env ?? params.opts.run?.env ?? process.env;
    const snapshot = await withOwnedManagedUpdateEnv(env, () =>
      readConfigFileSnapshot({ skipPluginValidation: true, observe: false }),
    );
    if (
      validatedConfigSnapshot?.hash !== undefined &&
      snapshot.hash !== validatedConfigSnapshot.hash
    ) {
      throw new UpdatePreMutationError(
        "invalid-config",
        "Config changed during candidate validation; rerun the update before activating.",
      );
    }
    const config = snapshot.config;
    await recheckSchemas(admittedTargetSchemaVersions);
    previousSchemaVersions = parsePackageOpenClawSchemaVersions(
      await tryReadJson<unknown>(path.join(params.root, "package.json")),
    );
    schemaVersions = candidateSchemaVersions
      ? await readUpdateStateSchemaVersions({
          stateDir: resolveStateDir(env),
          config,
          env,
        })
      : undefined;
    if (
      preManagedServiceStop?.running &&
      preManagedServiceStop.serviceUpdateVerdict?.kind === "owned"
    ) {
      const port = await resolveUpdatedGatewayRestartPort({ config, serviceEnv: env });
      const [expectedVersion, expectedBuildId] = await Promise.all([
        readPackageVersion(params.root),
        readBuiltGatewayBuildId(params.root),
      ]);
      const [health, readiness, servesPreviousPackage] = await Promise.all([
        inspectGatewayRestart({
          service: resolveGatewayService(),
          env,
          port,
          expectedVersion,
          expectedBuildId: expectedBuildId ?? undefined,
        }),
        waitForGatewayHttpReadiness({
          config,
          port,
          deadlineAt: Date.now() + 3_000,
          attempts: 1,
          delayMs: 0,
        }),
        gatewayServiceCommandUsesRoot({ root: params.root, env }),
      ]);
      previousVerified = Boolean(
        expectedVersion &&
        servesPreviousPackage === true &&
        health.healthy &&
        health.runtime.status === "running" &&
        readiness.readyz === 200,
      );
      if (params.opts.run) {
        recordUpdateRunStep(
          params.opts.run.runId,
          {
            step: "previous gateway verification",
            status: "completed",
            detail: previousVerified
              ? "Previous package is running and ready."
              : "Previous gateway was not verified; automatic rollback cannot restart it.",
            endedAtMs: Date.now(),
          },
          { env: params.opts.run.env },
        );
      }
    }
    // Health and candidate work can outlive the inspected service/config generation.
    await recheckSchemas(admittedTargetSchemaVersions);
    if (params.opts.run) {
      recordUpdateRunPhase(params.opts.run.runId, "activating", undefined, {
        env: params.opts.run.env,
      });
    }
    if (params.shouldRestart && (await activateManagedServiceUpdateHandoff())) {
      if (!preManagedServiceStop) {
        throw new UpdatePreMutationError(
          "managed-service-preflight",
          "Managed update lost its service inspection before activation.",
        );
      }
      preManagedServiceStop.stopped = true;
      preManagedServiceStop.stoppedAtMs =
        (await readControlPlaneUpdateSentinelMeta())?.serviceStoppedAtMs ?? Date.now();
    } else {
      await stopManagedServiceBeforeMutableUpdate(roots);
    }
    await recheckSchemas(admittedTargetSchemaVersions);
    // Git owns this fence after its post-stop schema check completes.
    if (params.updateInstallKind === "package") {
      preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    }
    mutationStarted = true;
    params.onActivation?.();
  };
  try {
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      admission = await inspectUpdateDatabaseContexts({
        roots: gitMutationRoots ?? [params.root],
        updateInstallKind: params.updateInstallKind,
        shouldRestart: params.shouldRestart,
        jsonMode: Boolean(params.opts.json),
        timeoutMs: params.updateStepTimeoutMs,
        invocationCwd: params.invocationCwd,
        managedServiceRootRedirect: params.managedServiceRootRedirect,
      });
    }
    if (params.updateInstallKind === "package") {
      if (!stagedPluginAdmission) {
        await preflightPlugins(params.packageTargetVersion ?? null);
        await params.prepareMutableUpdate(admission?.managedEnv);
      }
      await stopManagedServiceBeforeMutableUpdate(undefined, "inspect");
      const packageUpdate: PackageInstallUpdateParams = {
        root: params.root,
        installKind: params.installKind,
        tag: params.tag,
        installSpec: params.packageInstallSpec ?? undefined,
        timeoutMs: params.updateStepTimeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        jsonMode: Boolean(params.opts.json),
        invocationCwd: params.invocationCwd,
        honorPackageRoot:
          params.managedServiceRootRedirect !== null ||
          params.managedServiceNodeRunner !== undefined,
        nodeRunner: params.packageUpdateNodeRunner,
        installEnv: params.packageInstallEnv,
        installTarget: params.packageInstallTarget,
        validateCandidate,
        beforeActivate,
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        onConfigSnapshot,
      };
      await recheckSchemas(params.packageTargetSchemaVersions);
      result = await runPackageInstallUpdate({
        ...packageUpdate,
        managedServiceEnv: preManagedServiceStop?.serviceEnv,
      });
    } else {
      result = await updateGitInstall({
        root: params.root,
        switchToGit: params.switchToGit,
        installKind: params.installKind,
        timeoutMs: params.timeoutMs,
        startedAt: params.startedAt,
        progress: params.progress,
        channel: params.channel,
        tag: params.tag,
        devTarget: params.devTarget,
        inspectGitTarget: async (target) => {
          if (target.metadataUnreadable) {
            throw new UpdatePreMutationError(
              "target-metadata-preflight",
              `Update refused: could not inspect the target's schema support (${target.metadataUnreadable}).`,
            );
          }
          await recheckSchemas(target.schemaVersions);
          if (!gitContextPrepared) {
            await params.prepareMutableUpdate(admission?.managedEnv);
            await stopManagedServiceBeforeMutableUpdate(gitMutationRoots ?? undefined, "inspect");
            // Later target reads revalidate admission, but must retain the stop
            // and recovery state owned by activation and finalization.
            gitContextPrepared = true;
          }
        },
        onTransaction: (transaction) => {
          packageTransaction = transaction;
        },
        onConfigSnapshot,
        // Foreign inspection metadata cannot authorize backup or Doctor writes.
        getManagedServiceEnv: () => ownedManagedUpdateContext?.env,
        invocationCwd: params.invocationCwd,
        nodeRunner: params.packageUpdateNodeRunner,
        validateCandidate: async (candidateRoot) => {
          const steps = await validateCandidate(candidateRoot);
          const failed = steps.find((step) => step.exitCode !== 0 && !step.advisory);
          if (failed) {
            throw new UpdatePreMutationError(
              failed.name,
              failed.stderrTail ?? "Candidate validation failed.",
            );
          }
        },
        beforeGitMutation:
          params.updateInstallKind === "git"
            ? createBeforeGitMutation({
                updateRun: params.opts.run,
                roots: gitMutationRoots ?? [params.root],
                shouldRestart: params.shouldRestart,
                stopManagedService: beforeActivate,
                getPreManagedServiceStop: () => preManagedServiceStop,
                checkTargetSchemas: recheckSchemas,
                prepareMutableUpdate: () =>
                  params.prepareMutableUpdate(
                    ownedManagedUpdateContext?.env ?? admission?.managedEnv,
                  ),
                switchToGit: params.switchToGit,
              })
            : undefined,
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      });
    }
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort) {
      return null;
    }
    const preMutationFailure = err instanceof UpdatePreMutationError;
    const message = formatErrorMessage(err);
    failure = { cause: err, detail: message };
    defaultRuntime.error(message);
    const durationMs = Date.now() - params.startedAt;
    // Only an explicit pre-mutation refusal can recover the original runtime.
    // An exception after entering mutable work carries an unsafe observed outcome
    // through the same cleanup, report, and triage path as a failed update step.
    result = {
      status: "error",
      mode:
        params.updateInstallKind === "git"
          ? "git"
          : (params.packageInstallTarget?.manager ?? "unknown"),
      root: params.root,
      reason: preMutationFailure ? err.reason : "update-failed",
      recovery: preMutationFailure
        ? await originalRecovery()
        : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        {
          name: preMutationFailure ? err.reason : "update",
          command: "openclaw update",
          cwd: params.root,
          durationMs,
          exitCode: 1,
          ...(isAbortError(err) ? { termination: "signal" as const } : {}),
          stderrTail: message,
        },
      ],
      durationMs,
    };
  }

  if (candidateFailureReason && result.status === "error") {
    result.reason = candidateFailureReason;
  }
  return {
    result,
    failure,
    mutationStarted,
    preManagedServiceStop,
    ownedManagedUpdateContext,
    recoveryEnv,
    packageTransaction,
    schemaVersions,
    candidateSchemaVersions,
    previousSchemaVersions,
    previousVerified,
    activationConfig,
  };
}
