import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import {
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
import { recordUpdateRunPhase } from "../../infra/update-run-ledger.js";
import { readCurrentGitUpdateRecovery } from "../../infra/update-runner-git-recovery.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateProgress } from "./progress.js";
import {
  checkTargetDatabaseSchemas,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
} from "./schema-preflight.js";
import {
  normalizeTag,
  resolveGitInstallDir,
  UpdatePreMutationError,
  type UpdateCommandOptions,
} from "./shared.js";
import { createBeforeGitMutation, updateGitInstall } from "./update-command-git.js";
import {
  formatUpdateAncestryBlockMessage,
  handoffUpdateFromGateway,
} from "./update-command-handoff.js";
import {
  captureOwnedManagedUpdateContext,
  type OwnedManagedUpdateContext,
} from "./update-command-managed-context.js";
import type { ManagedServiceRootRedirect } from "./update-command-service-plan.js";
import {
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  resolvePreparedGatewayUpdatePolicy,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";
import {
  selectPackageExecutor,
  type PackageUpdatePreparation,
  type PreparedPackageUpdate,
} from "./update-package-executor.js";

const CLI_NAME = resolveCliName();

type MutableUpdateExecutionResult = {
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  recoveryEnv: NodeJS.ProcessEnv | undefined;
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
  packageTargetSchemaVersions?: OpenClawSchemaVersions;
  packageUpdateNodeRunner?: string;
  managedServiceNodeRunner?: string;
  managedServiceRootRedirect: ManagedServiceRootRedirect | null;
  invocationCwd?: string;
  recoveryState: UpdateCommandRecoveryState;
}): Promise<MutableUpdateExecutionResult | null> {
  let preManagedServiceStop: PreManagedServiceStop | undefined;
  let ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  let recoveryEnv: NodeJS.ProcessEnv | undefined;
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
          updateRun: params.opts.run,
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
      params.stop();
      throw new Error(`Failed to stop managed gateway service before update: ${String(err)}`, {
        cause: err,
      });
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

  const buildPackagePreparation = (): PackageUpdatePreparation => ({
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
      params.managedServiceRootRedirect !== null || params.managedServiceNodeRunner !== undefined,
    nodeRunner: params.packageUpdateNodeRunner,
    installEnv: params.packageInstallEnv,
    installTarget: params.packageInstallTarget,
  });

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  const packageExecutor =
    params.updateInstallKind === "package" ? selectPackageExecutor() : undefined;
  let preparedPackageUpdate: PreparedPackageUpdate | undefined;
  let packageActivationStarted = false;
  try {
    preparedPackageUpdate = await packageExecutor?.prepare(buildPackagePreparation());
    if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      await stopManagedServiceBeforeMutableUpdate(
        gitMutationRoots ?? undefined,
        params.updateInstallKind === "git" ? "inspect" : "prepare",
      );
    }
    const postStopPackageSchemaPreflight =
      params.updateInstallKind === "package"
        ? await checkTargetDatabaseSchemas(
            params.packageTargetSchemaVersions,
            preManagedServiceStop?.serviceEnv ?? process.env,
          )
        : { incompatible: [], indeterminate: [] };
    if (hasSchemaRefusal(postStopPackageSchemaPreflight)) {
      throw new UpdatePreMutationError(
        "database-schema-preflight",
        formatSchemaRefusalLines(postStopPackageSchemaPreflight).join("\n"),
      );
    }
    preManagedServiceStop?.windowsTaskAutoStartRecovery?.beginMutation();
    if (params.opts.run && params.updateInstallKind === "package") {
      recordUpdateRunPhase(params.opts.run.runId, "activating", undefined, {
        env: params.opts.run.env,
      });
    }
    if (packageExecutor && preparedPackageUpdate) {
      packageActivationStarted = true;
      result = await packageExecutor.activate({
        prepared: preparedPackageUpdate,
        activation: {
          ...resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart),
          managedServiceEnv: preManagedServiceStop?.serviceEnv,
        },
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
        beforeGitMutation:
          params.updateInstallKind === "git"
            ? createBeforeGitMutation({
                updateRun: params.opts.run,
                roots: gitMutationRoots ?? [params.root],
                shouldRestart: params.shouldRestart,
                stopManagedService: stopManagedServiceBeforeMutableUpdate,
                getPreManagedServiceStop: () => preManagedServiceStop,
                switchToGit: params.switchToGit,
              })
            : undefined,
        allowGatewayServiceRepair: false,
        allowGatewayActivation: false,
      });
    }
  } catch (err) {
    if (packageExecutor && preparedPackageUpdate && !packageActivationStarted) {
      await packageExecutor.discard(
        preparedPackageUpdate,
        err instanceof UpdateCommandAbort ? "update-aborted" : "pre-activation-failed",
      );
    }
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
          stderrTail: message,
        },
      ],
      durationMs,
    };
  }

  return { result, failure, preManagedServiceStop, ownedManagedUpdateContext, recoveryEnv };
}
