import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  readConfigFileSnapshot,
} from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
  type UpdateChannel,
  UPDATE_EFFECTIVE_CHANNEL_ENV,
} from "../../infra/update-channels.js";
import { resolveUpdateInstallKind } from "../../infra/update-check.js";
import { POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV } from "../../infra/update-post-core-context.js";
import { loadInstalledPluginIndexInstallRecords } from "../../plugins/installed-plugin-index-records.js";
import { withPluginLifecycleLease } from "../../plugins/plugin-lifecycle-lease.js";
import { withCommandProcessScope } from "../../process/exec-spawn.js";
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import { exitCliAfterOutput } from "../one-shot-exit.js";
import {
  parseTimeoutMsOrExit,
  resolveUpdateRoot,
  tryResolveInvocationCwd,
  tryWriteCompletionCache,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import { createUpdateConfigSnapshot } from "./update-command-config-snapshot.js";
import {
  persistRequestedUpdateChannel,
  persistValidatedDowngradeConfig,
  readPostCorePreUpdateSourceConfig,
  restoreDroppedPreUpdateChannels,
} from "./update-command-config.js";
import {
  completePostCorePluginUpdate,
  runUpdateFinalizationDoctorInFreshProcess,
  withPrePluginUpdateDoctorEnv,
} from "./update-command-fresh-doctor.js";
import {
  updatePluginsAfterCoreUpdate,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins.js";
import { reportPreMutationUpdateFailure, UpdateCommandFailure } from "./update-command-result.js";
import { resolveServiceRefreshEnv, withUpdateInProgressEnv } from "./update-command-service-env.js";
import { withUpdateFailureTriage } from "./update-command-triage.js";
import { UpdateFinalizationLifecycle } from "./update-finalization-lifecycle.js";

export async function updateFinalizeCommand(opts: UpdateFinalizeOptions): Promise<void> {
  const invocationCwd = tryResolveInvocationCwd();
  suppressDeprecations();
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
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

  await withCommandProcessScope(async (stopChildren) => {
    const lifecycle = new UpdateFinalizationLifecycle(Boolean(opts.json), timeoutMs, stopChildren);
    try {
      const prepared = await withUpdateInProgressEnv(invocationCwd, () =>
        lifecycle.run("targetConfigValidation", () =>
          prepareUpdateFinalization(opts, requestedChannel, lifecycle),
        ),
      );
      if (!prepared) {
        return;
      }
      const { root } = prepared;
      const target = { root, env: resolveServiceRefreshEnv(process.env, invocationCwd) };
      await withUpdateFailureTriage({ ...opts, invocationCwd }, target, () =>
        withUpdateInProgressEnv(invocationCwd, () =>
          updateFinalizeCommandInternal(opts, prepared, lifecycle),
        ),
      );
    } catch (error) {
      if (error instanceof UpdateCommandFailure) {
        lifecycle.complete(error.exitCode);
        exitCliAfterOutput(defaultRuntime, error.exitCode);
      }
      if (!lifecycle.completed) {
        lifecycle.fail();
      }
      throw error;
    }
  });
}

async function prepareUpdateFinalization(
  opts: UpdateFinalizeOptions,
  requestedChannel: UpdateChannel | null,
  lifecycle: UpdateFinalizationLifecycle,
) {
  assertConfigWriteAllowedInCurrentMode();
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
    recoverOrphanedSidecars: false,
  });
  lifecycle.attachLedger();
  const root = await resolveUpdateRoot();
  lifecycle.root = root;
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  const preFinalizeConfig =
    (await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: configSnapshot,
    })) ??
    (configSnapshot.valid
      ? {
          sourceConfig: configSnapshot.sourceConfig,
          authoredConfig: isRecord(configSnapshot.parsed)
            ? (configSnapshot.parsed as OpenClawConfig) // SAFETY: snapshot parser validated this config record.
            : configSnapshot.sourceConfig,
        }
      : undefined);
  if (requestedChannel === "extended-stable") {
    const installKind = await resolveUpdateInstallKind(root);
    if (installKind === "git") {
      await reportPreMutationUpdateFailure({
        root,
        installKind,
        reason: "unsupported_git_channel",
        opts,
        controlPlaneUpdateSentinelMeta: null,
      });
      return undefined;
    }
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  // Effective channel the core update actually ran on (e.g. git/dev for an
  // unconfigured source update), passed by the caller via env. Used only as a
  // convergence fallback; it is never persisted (that stays gated on
  // `requestedChannel`), so a default source update does not write update.channel.
  const effectiveChannel = normalizeUpdateChannel(
    process.env[UPDATE_EFFECTIVE_CHANNEL_ENV]?.trim(),
  );
  const channel = requestedChannel ?? storedChannel ?? effectiveChannel ?? DEFAULT_PACKAGE_CHANNEL;
  if (requestedChannel) {
    configSnapshot = await withPluginLifecycleLease({}, async () => {
      const snapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      return await persistRequestedUpdateChannel({ configSnapshot: snapshot, requestedChannel });
    });
  }
  return {
    root,
    configSnapshot,
    preFinalizeConfig,
    requestedChannel,
    storedChannel,
    effectiveChannel,
    channel,
  };
}

async function updateFinalizeCommandInternal(
  opts: UpdateFinalizeOptions,
  prepared: NonNullable<Awaited<ReturnType<typeof prepareUpdateFinalization>>>,
  lifecycle: UpdateFinalizationLifecycle,
): Promise<void> {
  const { root, preFinalizeConfig, requestedChannel, storedChannel, effectiveChannel, channel } =
    prepared;
  let { configSnapshot } = prepared;

  const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
    await lifecycle.run("configSnapshot", createUpdateConfigSnapshot);
    await lifecycle.run("doctor", () =>
      runUpdateFinalizationDoctorInFreshProcess({
        phase: "pre-plugin",
        root,
        yes: opts.yes === true,
        json: opts.json === true,
        workspaceSuggestions: true,
        timeoutMs: lifecycle.budget("doctor"),
      }),
    );
    return await lifecycle.run(
      "plugins",
      () =>
        withPluginLifecycleLease({}, async () => {
          configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
          if (requestedChannel) {
            configSnapshot = await persistRequestedUpdateChannel({
              configSnapshot,
              requestedChannel,
            });
          }
          const restoredConfig = restoreDroppedPreUpdateChannels(configSnapshot, preFinalizeConfig);
          configSnapshot = restoredConfig.snapshot;
          const postDoctorStoredChannel = configSnapshot.valid
            ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
            : null;
          const postDoctorChannel =
            requestedChannel ??
            postDoctorStoredChannel ??
            storedChannel ??
            effectiveChannel ??
            DEFAULT_PACKAGE_CHANNEL;
          const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
          return await updatePluginsAfterCoreUpdate({
            root,
            channel: postDoctorChannel,
            configSnapshot,
            configChanged: restoredConfig.changed,
            restoredAuthoredChannels: restoredConfig.authoredChannels,
            json: opts.json,
            acceptCapabilities: opts.acceptCapabilities,
            timeoutMs: lifecycle.budget("plugins"),
            pluginInstallRecords,
          });
        }),
      pluginOutcome,
    );
  });
  // Fresh Doctor acquires this same lease; convergence must run after release.
  const completedPluginUpdate = await lifecycle.run(
    "targetConfigConvergence",
    async () => {
      const result = await completePostCorePluginUpdate({
        root,
        pluginUpdate: initialPluginUpdate,
        freshDoctorRequired: initialPluginUpdate.changed,
        yes: opts.yes === true,
        json: opts.json === true,
        timeoutMs: lifecycle.budget("targetConfigConvergence"),
      });
      await persistValidatedDowngradeConfig(result.configSnapshot);
      return result;
    },
    (result) => pluginOutcome(result.pluginUpdate),
  );
  const pluginUpdate = completedPluginUpdate.pluginUpdate;
  configSnapshot = completedPluginUpdate.configSnapshot;
  await lifecycle.run(
    "completionCache",
    async () =>
      opts.deferCompletionCache
        ? ("deferred" as const)
        : await tryWriteCompletionCache(root, Boolean(opts.json)),
    (result) => result,
  );

  const result = {
    status:
      pluginUpdate.status === "error"
        ? "error"
        : pluginUpdate.status === "warning"
          ? "warning"
          : "ok",
    mode: "finalize",
    root,
    channel:
      requestedChannel ??
      (configSnapshot.valid
        ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
        : null) ??
      channel,
    restart: false,
    phaseTimings: lifecycle.phaseTimings,
    postUpdate: {
      doctor: {
        status: "ok",
      },
      plugins: pluginUpdate,
    },
  };
  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else if (result.status === "ok") {
    defaultRuntime.log(theme.muted("Update finalization completed."));
  } else if (result.status === "warning") {
    defaultRuntime.log(theme.warn("Update finalization completed with warnings."));
  } else {
    defaultRuntime.log(theme.error("Update finalization failed."));
  }
  lifecycle.complete(result.status === "error" ? 1 : 0);
  if (result.status === "error") {
    throw new UpdateCommandFailure({
      status: "error",
      mode: "unknown",
      root,
      reason: "post-update-plugins",
      postUpdate: { plugins: pluginUpdate },
      steps: [],
      durationMs: Math.round(performance.now() - lifecycle.startedAt),
    });
  }
}

function pluginOutcome(result: PostCorePluginUpdateResult): "failed" | "warning" | "completed" {
  return result.status === "error"
    ? "failed"
    : result.status === "warning"
      ? "warning"
      : "completed";
}
