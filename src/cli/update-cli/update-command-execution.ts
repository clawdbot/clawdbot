import { randomBytes } from "node:crypto";
import { ScheduledTaskAutoStartRecoveryError } from "../../daemon/schtasks-update-recovery.js";
import { formatErrorMessage } from "../../infra/errors.js";
import type { DevUpdateTarget } from "../../infra/update-dev-target.js";
import type { UpdateGenerationConfinedFilesystem } from "../../infra/update-generation-confined-filesystem.js";
import type { UpdateGenerationLedgerHook } from "../../infra/update-generation-ledger-hook.js";
import type { UpdateGenerationRuntime } from "../../infra/update-generation-runtime.js";
import {
  verifyPackageUpdateRecovery,
  type ResolvedGlobalInstallTarget,
} from "../../infra/update-global.js";
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
import {
  runPackageInstallUpdate,
  type PackageInstallUpdateParams,
} from "./update-command-package.js";
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

const CLI_NAME = resolveCliName();

type MutableUpdateExecutionResult = {
  result: UpdateRunResult;
  failure?: { cause: unknown; detail: string };
  preManagedServiceStop: PreManagedServiceStop | undefined;
  ownedManagedUpdateContext: OwnedManagedUpdateContext | undefined;
  recoveryEnv: NodeJS.ProcessEnv | undefined;
};

type ExpectedManagedService = Pick<PreManagedServiceStop, "serviceEnv" | "serviceUpdateVerdict">;

function snapshotExpectedManagedService(
  service: PreManagedServiceStop | undefined,
): ExpectedManagedService | undefined {
  if (!service) {
    return undefined;
  }
  const serviceUpdateVerdict = service.serviceUpdateVerdict;
  return Object.freeze({
    serviceEnv: service.serviceEnv ? Object.freeze({ ...service.serviceEnv }) : undefined,
    serviceUpdateVerdict: serviceUpdateVerdict
      ? Object.freeze({ ...serviceUpdateVerdict })
      : undefined,
  });
}

const PREPARED_ARTIFACT_ISSUER = Symbol("UpdateGenerationPreparedArtifact.issuer");
declare const updateGenerationPreparedArtifactBrand: unique symbol;

export type UpdateGenerationPreparedArtifact = Readonly<{
  formatVersion: 1;
  token: string;
  readonly [updateGenerationPreparedArtifactBrand]: true;
}>;

let isPreparedArtifactOwnedBy: (
  prepared: unknown,
  owner: UpdateGenerationPackageUpdateExecutor,
) => boolean;

class IssuedUpdateGenerationPreparedArtifact implements UpdateGenerationPreparedArtifact {
  readonly formatVersion = 1 as const;
  readonly token: string;
  declare readonly [updateGenerationPreparedArtifactBrand]: true;
  readonly #owner: UpdateGenerationPackageUpdateExecutor;

  constructor(
    issuer: typeof PREPARED_ARTIFACT_ISSUER,
    owner: UpdateGenerationPackageUpdateExecutor,
  ) {
    if (issuer !== PREPARED_ARTIFACT_ISSUER) {
      throw new TypeError("Prepared generation tokens can only be issued by their executor");
    }
    this.token = randomBytes(32).toString("base64url");
    this.#owner = owner;
    Object.freeze(this);
  }

  static {
    isPreparedArtifactOwnedBy = (prepared, owner) =>
      typeof prepared === "object" &&
      prepared !== null &&
      #owner in prepared &&
      prepared.#owner === owner;
  }
}

const issuePreparedArtifact = (
  owner: UpdateGenerationPackageUpdateExecutor,
): UpdateGenerationPreparedArtifact => {
  return new IssuedUpdateGenerationPreparedArtifact(PREPARED_ARTIFACT_ISSUER, owner);
};

export type UpdateGenerationPackagePreparationParams = Omit<
  PackageInstallUpdateParams,
  "allowGatewayActivation" | "allowGatewayServiceRepair"
>;

function assertPreparedArtifactOwner(
  owner: UpdateGenerationPackageUpdateExecutor,
  prepared: unknown,
): void {
  if (!isPreparedArtifactOwnedBy(prepared, owner)) {
    throw new UpdatePreMutationError(
      "generation-activation-preflight",
      "Generation preparation did not return a token owned by the selected package executor.",
    );
  }
}

/**
 * Generation-aware package mutation owner supplied by the protected broker stack.
 * The current package updater remains the compatibility owner until that stack is installed.
 */
export abstract class UpdateGenerationPackageUpdateExecutor {
  readonly #opaqueGenerationPackageUpdateExecutor = true;

  protected constructor(
    readonly filesystem: UpdateGenerationConfinedFilesystem | null,
    readonly ledger: UpdateGenerationLedgerHook | null,
  ) {
    void this.#opaqueGenerationPackageUpdateExecutor;
  }

  abstract prepare(params: {
    update: UpdateGenerationPackagePreparationParams;
    filesystem: UpdateGenerationConfinedFilesystem;
    ledger: UpdateGenerationLedgerHook;
    runtime: UpdateGenerationRuntime;
    issuePreparedArtifact: () => UpdateGenerationPreparedArtifact;
  }): Promise<UpdateGenerationPreparedArtifact>;

  abstract activate(params: {
    prepared: UpdateGenerationPreparedArtifact;
    update: PackageInstallUpdateParams;
    filesystem: UpdateGenerationConfinedFilesystem;
    ledger: UpdateGenerationLedgerHook;
    runtime: UpdateGenerationRuntime;
  }): Promise<UpdateRunResult>;

  abstract discard(
    prepared: UpdateGenerationPreparedArtifact,
    reason: "pre-activation-failed" | "update-aborted",
  ): Promise<void>;
}

type ResolvedPackageUpdateExecutor =
  | Readonly<{
      kind: "generation";
      executor: UpdateGenerationPackageUpdateExecutor;
      filesystem: UpdateGenerationConfinedFilesystem;
      ledger: UpdateGenerationLedgerHook;
      runtime: UpdateGenerationRuntime;
    }>
  | Readonly<{
      kind: "legacy";
      execute: typeof runPackageInstallUpdate;
    }>;

async function resolvePackageUpdateExecutor(
  executor: UpdateGenerationPackageUpdateExecutor | undefined,
): Promise<ResolvedPackageUpdateExecutor> {
  if (!executor) {
    return { kind: "legacy", execute: runPackageInstallUpdate };
  }
  const { UPDATE_GENERATION_RUNTIME: runtime } =
    await import("../../infra/update-generation-runtime.js");
  if (
    !(executor instanceof UpdateGenerationPackageUpdateExecutor) ||
    !(executor.filesystem instanceof runtime.ConfinedFilesystem) ||
    !executor.ledger
  ) {
    throw new UpdatePreMutationError(
      "generation-activation-preflight",
      "Generation-addressed package updates require a confined filesystem provider and authoritative ledger.",
    );
  }
  const filesystem = executor.filesystem;
  const ledger = executor.ledger;
  return { kind: "generation", executor, filesystem, ledger, runtime };
}

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
  generationPackageUpdateExecutor?: UpdateGenerationPackageUpdateExecutor;
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
    expectedService?: ExpectedManagedService,
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
          expectedService,
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

  const buildPackagePreparationParams = (
    managedServiceEnv: NodeJS.ProcessEnv | undefined,
  ): UpdateGenerationPackagePreparationParams => ({
    root: params.root,
    installKind: params.installKind,
    tag: params.tag,
    installSpec: params.packageInstallSpec ?? undefined,
    timeoutMs: params.updateStepTimeoutMs,
    startedAt: params.startedAt,
    progress: params.progress,
    jsonMode: Boolean(params.opts.json),
    managedServiceEnv,
    invocationCwd: params.invocationCwd,
    honorPackageRoot:
      params.managedServiceRootRedirect !== null || params.managedServiceNodeRunner !== undefined,
    nodeRunner: params.packageUpdateNodeRunner,
    installEnv: params.packageInstallEnv,
    installTarget: params.packageInstallTarget,
  });

  const buildPackageActivationParams = (): PackageInstallUpdateParams => ({
    ...buildPackagePreparationParams(preManagedServiceStop?.serviceEnv),
    ...resolvePreparedGatewayUpdatePolicy(preManagedServiceStop, params.shouldRestart),
  });

  let result: UpdateRunResult;
  let failure: MutableUpdateExecutionResult["failure"];
  let packageUpdateExecutor: ResolvedPackageUpdateExecutor | undefined;
  let preparedArtifact: UpdateGenerationPreparedArtifact | undefined;
  let preparedArtifactOwned = false;
  let generationActivationStarted = false;
  try {
    packageUpdateExecutor =
      params.updateInstallKind === "package"
        ? await resolvePackageUpdateExecutor(params.generationPackageUpdateExecutor)
        : undefined;
    if (packageUpdateExecutor?.kind === "generation") {
      await stopManagedServiceBeforeMutableUpdate(undefined, "inspect");
      const { executor, filesystem, ledger, runtime } = packageUpdateExecutor;
      const expectedService = snapshotExpectedManagedService(preManagedServiceStop);
      let issuanceOpen = true;
      let returnedArtifact: UpdateGenerationPreparedArtifact;
      try {
        returnedArtifact = await executor.prepare({
          update: buildPackagePreparationParams(
            expectedService?.serviceEnv ? { ...expectedService.serviceEnv } : undefined,
          ),
          filesystem,
          ledger,
          runtime,
          issuePreparedArtifact: () => {
            if (!issuanceOpen || preparedArtifact) {
              throw new TypeError(
                "Generation preparation may issue exactly one token before returning",
              );
            }
            preparedArtifact = issuePreparedArtifact(executor);
            preparedArtifactOwned = true;
            return preparedArtifact;
          },
        });
      } finally {
        issuanceOpen = false;
      }
      assertPreparedArtifactOwner(executor, returnedArtifact);
      if (returnedArtifact !== preparedArtifact) {
        throw new UpdatePreMutationError(
          "generation-activation-preflight",
          "Generation preparation did not return its current one-shot token.",
        );
      }
      await stopManagedServiceBeforeMutableUpdate(undefined, "prepare", expectedService);
    } else if (params.updateInstallKind === "package" || params.updateInstallKind === "git") {
      await stopManagedServiceBeforeMutableUpdate(
        gitMutationRoots ?? undefined,
        params.updateInstallKind === "git" ? "inspect" : "prepare",
      );
    }
    const postStopPackageSchemaPreflight =
      params.updateInstallKind === "package"
        ? checkTargetDatabaseSchemas(
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
    if (packageUpdateExecutor?.kind === "generation") {
      if (!preparedArtifact) {
        throw new UpdatePreMutationError(
          "generation-activation-preflight",
          "Generation activation requires a prepared package token.",
        );
      }
      const { executor, filesystem, ledger, runtime } = packageUpdateExecutor;
      const activation = {
        prepared: preparedArtifact,
        update: buildPackageActivationParams(),
        filesystem,
        ledger,
        runtime,
      };
      generationActivationStarted = true;
      result = await executor.activate(activation);
    } else if (packageUpdateExecutor?.kind === "legacy") {
      result = await packageUpdateExecutor.execute(buildPackageActivationParams());
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
  } catch (caught) {
    let err = caught;
    if (
      packageUpdateExecutor?.kind === "generation" &&
      preparedArtifact &&
      preparedArtifactOwned &&
      !generationActivationStarted
    ) {
      const discardReason =
        err instanceof UpdateCommandAbort ? "update-aborted" : "pre-activation-failed";
      try {
        await packageUpdateExecutor.executor.discard(preparedArtifact, discardReason);
      } catch (discardError) {
        err = new AggregateError(
          [err, discardError],
          `Generation preparation cleanup failed after ${discardReason}`,
        );
      }
    }
    params.stop();
    const generationPostActivationFailure =
      packageUpdateExecutor?.kind === "generation" && generationActivationStarted;
    if (err instanceof UpdateCommandAbort && !generationPostActivationFailure) {
      return null;
    }
    const preMutationError =
      err instanceof UpdatePreMutationError && !generationPostActivationFailure ? err : undefined;
    const generationRuntimeUnchanged =
      packageUpdateExecutor?.kind === "generation" && !generationActivationStarted;
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
      reason: preMutationError?.reason ?? "update-failed",
      recovery:
        preMutationError || generationRuntimeUnchanged
          ? await originalRecovery()
          : { serviceRestartSafe: false, reason: "runtime-verification-failed" },
      steps: [
        {
          name: preMutationError?.reason ?? "update",
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
