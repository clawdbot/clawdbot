import type { ResolvedGlobalInstallTarget } from "../../infra/update-global.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { defaultRuntime } from "../../runtime.js";
import type { OpenClawSchemaVersions } from "../../state/openclaw-schema-versions.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { createUpdateProgress } from "./progress.js";
import { resolveGitInstallDir, type UpdateCommandOptions } from "./shared.js";
import {
  checkTargetDatabaseSchemas,
  createBeforeGitMutation,
  formatSchemaRefusalLines,
  hasSchemaRefusal,
  runGitUpdate,
} from "./update-command-git.js";
import { runPackageInstallUpdate } from "./update-command-package.js";
import {
  createAggregateErrorWithCause,
  maybeRestartServiceAfterFailedMutableUpdate,
  maybeResumeWindowsTaskAutoStartAfterPackageUpdate,
  maybeStopManagedServiceBeforeMutableUpdate,
  shouldBlockMutableUpdateFromGatewayServiceEnv,
  UpdateCommandAbort,
  type ManagedServiceRootRedirect,
  type PreManagedServiceStop,
  type UpdateCommandRecoveryState,
} from "./update-command-service.js";

const CLI_NAME = resolveCliName();

type MutableUpdateExecutionResult = {
  result: UpdateRunResult;
  preManagedServiceStop: PreManagedServiceStop | undefined;
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
  showProgress: boolean;
  opts: UpdateCommandOptions;
  shouldRestart: boolean;
  devTargetRef?: string;
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
  let schemaRefusalAfterStop = false;
  const gitMutationRoots =
    params.updateInstallKind === "git"
      ? params.switchToGit
        ? [params.root, resolveGitInstallDir()]
        : [params.root]
      : null;
  const stopManagedServiceBeforeMutableUpdate = async (
    mutationRoots: readonly string[] = [params.root],
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
      if (err instanceof UpdateCommandAbort) {
        throw err;
      }
      params.stop();
      defaultRuntime.error(`Failed to stop managed gateway service before update: ${String(err)}`);
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }

    if (preManagedServiceStop?.blockMessage) {
      params.stop();
      defaultRuntime.error(preManagedServiceStop.blockMessage);
      defaultRuntime.exit(1);
      throw new UpdateCommandAbort();
    }

    if (shouldBlockMutableUpdateFromGatewayServiceEnv({ preManagedServiceStop })) {
      params.stop();
      const updateLabel = params.updateInstallKind === "git" ? "Git updates" : "Package updates";
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

  if (params.updateInstallKind === "package") {
    try {
      await stopManagedServiceBeforeMutableUpdate();
    } catch (err) {
      if (err instanceof UpdateCommandAbort) {
        return null;
      }
      throw err;
    }
  }

  const postStopPackageSchemaPreflight =
    params.updateInstallKind === "package"
      ? checkTargetDatabaseSchemas(
          params.packageTargetSchemaVersions,
          preManagedServiceStop?.serviceEnv ?? process.env,
        )
      : { incompatible: [], indeterminate: [] };
  if (hasSchemaRefusal(postStopPackageSchemaPreflight)) {
    schemaRefusalAfterStop = true;
    defaultRuntime.error(formatSchemaRefusalLines(postStopPackageSchemaPreflight).join("\n"));
  }

  let result: UpdateRunResult;
  try {
    result =
      params.updateInstallKind === "package" && hasSchemaRefusal(postStopPackageSchemaPreflight)
        ? {
            status: "error",
            mode: params.packageInstallTarget?.manager ?? "unknown",
            root: params.root,
            reason: "database-schema-preflight",
            steps: [],
            durationMs: Date.now() - params.startedAt,
          }
        : params.updateInstallKind === "package"
          ? await runPackageInstallUpdate({
              root: params.root,
              installKind: params.installKind,
              tag: params.tag,
              installSpec: params.packageInstallSpec ?? undefined,
              timeoutMs: params.updateStepTimeoutMs,
              startedAt: params.startedAt,
              progress: params.progress,
              jsonMode: Boolean(params.opts.json),
              allowGatewayServiceRepair: preManagedServiceStop?.serviceMatchesMutationRoot === true,
              allowGatewayActivation:
                params.shouldRestart &&
                preManagedServiceStop?.stopped === true &&
                preManagedServiceStop.serviceMatchesMutationRoot === true,
              managedServiceEnv: preManagedServiceStop?.serviceEnv,
              invocationCwd: params.invocationCwd,
              honorPackageRoot:
                params.managedServiceRootRedirect !== null ||
                params.managedServiceNodeRunner !== undefined,
              nodeRunner: params.packageUpdateNodeRunner,
              installEnv: params.packageInstallEnv,
              installTarget: params.packageInstallTarget,
            })
          : await runGitUpdate({
              root: params.root,
              switchToGit: params.switchToGit,
              installKind: params.installKind,
              timeoutMs: params.timeoutMs,
              startedAt: params.startedAt,
              progress: params.progress,
              channel: params.channel,
              tag: params.tag,
              showProgress: params.showProgress,
              opts: params.opts,
              stop: params.stop,
              devTargetRef: params.devTargetRef,
              beforeGitMutation:
                params.updateInstallKind === "git"
                  ? createBeforeGitMutation({
                      roots: gitMutationRoots ?? [params.root],
                      shouldRestart: params.shouldRestart,
                      stopManagedService: stopManagedServiceBeforeMutableUpdate,
                      getPreManagedServiceStop: () => preManagedServiceStop,
                      markSchemaRefusalAfterStop: () => {
                        schemaRefusalAfterStop = true;
                      },
                    })
                  : undefined,
              allowGatewayServiceRepair: false,
              allowGatewayActivation: false,
            });
  } catch (err) {
    params.stop();
    if (err instanceof UpdateCommandAbort) {
      if (schemaRefusalAfterStop) {
        if (preManagedServiceStop?.stopped === true) {
          await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(preManagedServiceStop).catch(
            () => undefined,
          );
          await maybeRestartServiceAfterFailedMutableUpdate({
            preManagedServiceStop,
            jsonMode: Boolean(params.opts.json),
          });
        }
        defaultRuntime.exit(1);
      }
      return null;
    }
    try {
      await maybeResumeWindowsTaskAutoStartAfterPackageUpdate(preManagedServiceStop);
    } catch (resumeErr) {
      params.recoveryState.windowsTaskAutoStartRecovery?.complete();
      params.recoveryState.windowsTaskAutoStartRecovery = undefined;
      throw createAggregateErrorWithCause(
        [err, resumeErr],
        `Update failed (${String(err)}) and Windows Scheduled Task autostart could not be restored (${String(resumeErr)})`,
        err,
      );
    }
    await maybeRestartServiceAfterFailedMutableUpdate({
      preManagedServiceStop,
      jsonMode: Boolean(params.opts.json),
    });
    throw err;
  }

  return { result, preManagedServiceStop };
}
