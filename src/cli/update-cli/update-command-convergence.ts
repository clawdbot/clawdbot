import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { UpdateChannel } from "../../infra/update-channels.js";
import { compareSemverStrings } from "../../infra/update-check.js";
import { recordUpdateRunPhase, recordUpdateRunStep } from "../../infra/update-run-ledger.js";
import type { UpdateRunResult } from "../../infra/update-runner.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { defaultRuntime } from "../../runtime.js";
import { VERSION } from "../../version.js";
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import {
  persistRequestedUpdateChannel,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import { completePostCorePluginUpdate } from "./update-command-fresh-doctor.js";
import { withOwnedManagedUpdateEnv } from "./update-command-managed-context.js";
import { updatePluginsAfterCoreUpdate } from "./update-command-plugins.js";
import {
  continuePostCoreUpdateInFreshProcess,
  shouldResumePostCoreUpdateInFreshProcess,
} from "./update-command-post-core.js";

export async function convergeUpdatePlugins(params: {
  result: UpdateRunResult;
  root: string;
  installKindChanged: boolean;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: UpdateChannel | null;
  storedChannel: UpdateChannel | null;
  channel: UpdateChannel;
  downgradeRisk: boolean;
  opts: UpdateCommandOptions;
  ownedManagedUpdateEnv?: NodeJS.ProcessEnv;
  preUpdatePluginInstallRecords: Awaited<ReturnType<typeof loadInstalledPluginIndexInstallRecords>>;
  startedAt: number;
  packageUpdateNodeRunner?: string;
  updateStepTimeoutMs: number;
  beforeDoctor?: () => Promise<void>;
}): Promise<{
  resultWithPostUpdate: UpdateRunResult;
  postUpdateConfigSnapshot?: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  detail?: string;
}> {
  const postUpdateRoot = params.result.root ?? params.root;
  const preUpdateConfig = params.configSnapshot.valid
    ? {
        sourceConfig: params.configSnapshot.sourceConfig,
        authoredConfig: isRecord(params.configSnapshot.parsed)
          ? (params.configSnapshot.parsed as OpenClawConfig) // SAFETY: valid snapshot validated this authored record.
          : params.configSnapshot.sourceConfig,
      }
    : undefined;

  const shouldResumePostCoreInFreshProcess = shouldResumePostCoreUpdateInFreshProcess({
    result: params.result,
    downgradeRisk: params.downgradeRisk,
    installKindChanged: params.installKindChanged,
  });

  let postUpdateConfigSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>> | undefined;
  if (
    params.requestedChannel &&
    params.configSnapshot.valid &&
    params.requestedChannel !== params.storedChannel &&
    !params.opts.json
  ) {
    const verb = shouldResumePostCoreInFreshProcess ? "will be set" : "set";
    defaultRuntime.log(theme.muted(`Update channel ${verb} to ${params.requestedChannel}.`));
  }

  if (params.opts.run) {
    // Plugin mutations require the installed root; keep them outside the
    // service outage and verify their fresh runtime after convergence.
    recordUpdateRunPhase(
      params.opts.run.runId,
      "verifying",
      {
        step: {
          step: "post-update verification",
          status: "in_progress",
          startedAtMs: Date.now(),
        },
      },
      { env: params.opts.run.env },
    );
  }

  return await withOwnedManagedUpdateEnv(params.ownedManagedUpdateEnv, async () => {
    const previousCompatibilityHostVersion = process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
    const postUpdateInstalledVersion = await readPackageVersion(postUpdateRoot);
    const versionComparison =
      postUpdateInstalledVersion && VERSION
        ? compareSemverStrings(VERSION, postUpdateInstalledVersion)
        : null;
    const compatibilityDowngradeTarget =
      versionComparison != null && versionComparison > 0 ? postUpdateInstalledVersion : null;
    if (compatibilityDowngradeTarget) {
      // The parent still reports its pre-update VERSION. Convergence and fresh
      // completion must both use the installed target's compatibility contract.
      process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = compatibilityDowngradeTarget;
    }
    try {
      let postCorePluginUpdate;
      let pluginsUpdatedInFreshProcess = false;
      if (shouldResumePostCoreInFreshProcess) {
        const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
          root: postUpdateRoot,
          channel: params.channel,
          requestedChannel: params.requestedChannel,
          opts: params.opts,
          pluginInstallRecords: params.preUpdatePluginInstallRecords,
          updateStartedAtMs: params.startedAt,
          timeoutMs: params.updateStepTimeoutMs,
          nodeRunner: params.packageUpdateNodeRunner,
          preUpdateConfig,
        });
        if (freshProcessResult.exitCode !== undefined) {
          return {
            resultWithPostUpdate: {
              ...params.result,
              status: "error" as const,
              reason: "post-core-update-failed",
            },
            detail: freshProcessResult.error,
          };
        }
        pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
        postCorePluginUpdate = freshProcessResult.pluginUpdate;
      }

      if (!pluginsUpdatedInFreshProcess) {
        postCorePluginUpdate = await withPluginLifecycleLease({}, async () => {
          postUpdateConfigSnapshot = await readConfigFileSnapshot({
            skipPluginValidation: true,
            suppressFutureVersionWarning: shouldResumePostCoreInFreshProcess,
          });
          postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
            configSnapshot: postUpdateConfigSnapshot,
            requestedChannel: params.requestedChannel,
          });
          const restoredConfig = restoreDroppedPreUpdateChannels(
            postUpdateConfigSnapshot,
            preUpdateConfig,
          );
          postUpdateConfigSnapshot = restoredConfig.snapshot;
          const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
          return await updatePluginsAfterCoreUpdate({
            root: postUpdateRoot,
            channel: params.channel,
            configSnapshot: postUpdateConfigSnapshot,
            configChanged: restoredConfig.changed,
            restoredAuthoredChannels: restoredConfig.authoredChannels,
            json: params.opts.json,
            acceptCapabilities: params.opts.acceptCapabilities,
            timeoutMs: params.updateStepTimeoutMs,
            pluginInstallRecords,
          });
        });
      }

      if (postCorePluginUpdate) {
        // Both package paths release the plugin lease before Doctor; the parent
        // owns the service boundary after package and network work has finished.
        const completedPluginUpdate = await completePostCorePluginUpdate({
          root: postUpdateRoot,
          pluginUpdate: postCorePluginUpdate,
          freshDoctorRequired: postCorePluginUpdate.changed,
          yes: params.opts.yes === true,
          json: params.opts.json === true,
          timeoutMs: params.updateStepTimeoutMs,
          beforeDoctor: params.beforeDoctor,
          ...(params.packageUpdateNodeRunner ? { nodeRunner: params.packageUpdateNodeRunner } : {}),
        });
        postCorePluginUpdate = completedPluginUpdate.pluginUpdate;
        postUpdateConfigSnapshot = completedPluginUpdate.configSnapshot;
      }

      const resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
        ? {
            ...params.result,
            status: postCorePluginUpdate.status === "error" ? "error" : params.result.status,
            ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
            postUpdate: {
              ...params.result.postUpdate,
              plugins: postCorePluginUpdate,
            },
          }
        : params.result;
      if (params.opts.run) {
        recordUpdateRunStep(
          params.opts.run.runId,
          {
            step: "post-update verification",
            status: postCorePluginUpdate?.status === "error" ? "failed" : "completed",
            endedAtMs: Date.now(),
          },
          { env: params.opts.run.env },
        );
      }

      return { resultWithPostUpdate, postUpdateConfigSnapshot };
    } finally {
      if (compatibilityDowngradeTarget) {
        if (previousCompatibilityHostVersion === undefined) {
          delete process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION;
        } else {
          process.env.OPENCLAW_COMPATIBILITY_HOST_VERSION = previousCompatibilityHostVersion;
        }
      }
    }
  });
}
