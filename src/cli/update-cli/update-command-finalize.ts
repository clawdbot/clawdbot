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
import { defaultRuntime } from "../../runtime.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { assertOpenClawStateWriteAllowedAtPath } from "../../state/openclaw-state-ownership.js";
import {
  parseTimeoutMsOrExit,
  resolveUpdateRoot,
  tryWriteCompletionCache,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";
import {
  createUpdateConfigSnapshot,
  persistRequestedUpdateChannel,
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
import { reportPreMutationUpdateFailure } from "./update-command-result.js";

const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;

type UpdateFinalizePhase =
  | "configSnapshot"
  | "doctor"
  | "plugins"
  | "targetConfigValidation"
  | "targetConfigConvergence"
  | "completionCache";

type UpdateFinalizePhaseOutcome = "completed" | "failed" | "warning" | "skipped" | "deferred";

type UpdateFinalizePhaseTiming = {
  phase: UpdateFinalizePhase;
  startedOffsetMs: number;
  durationMs: number;
  outcome: UpdateFinalizePhaseOutcome;
};

async function runTimedFinalizePhase<T>(params: {
  finalizationStartedAt: number;
  phaseTimings: UpdateFinalizePhaseTiming[];
  phase: UpdateFinalizePhase;
  run: () => Promise<T>;
  outcome?: (result: T) => UpdateFinalizePhaseOutcome;
}): Promise<T> {
  const startedAt = performance.now();
  try {
    const result = await params.run();
    params.phaseTimings.push({
      phase: params.phase,
      startedOffsetMs: Math.max(0, Math.round(startedAt - params.finalizationStartedAt)),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome: params.outcome?.(result) ?? "completed",
    });
    return result;
  } catch (err) {
    params.phaseTimings.push({
      phase: params.phase,
      startedOffsetMs: Math.max(0, Math.round(startedAt - params.finalizationStartedAt)),
      durationMs: Math.max(0, Math.round(performance.now() - startedAt)),
      outcome: "failed",
    });
    throw err;
  }
}

type UpdateFinalizeResult = {
  status: "ok" | "warning" | "error";
  mode: "finalize";
  root: string;
  channel: UpdateChannel;
  restart: false;
  phaseTimings: UpdateFinalizePhaseTiming[];
  postUpdate: {
    doctor: {
      status: "ok";
    };
    plugins: PostCorePluginUpdateResult;
  };
};

export async function updateFinalizeCommand(opts: UpdateFinalizeOptions): Promise<void> {
  suppressDeprecations();
  const finalizationStartedAt = performance.now();
  const phaseTimings: UpdateFinalizePhaseTiming[] = [];
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

  assertConfigWriteAllowedInCurrentMode();
  await assertOpenClawStateWriteAllowedAtPath({
    databasePath: resolveOpenClawStateSqlitePath(process.env),
  });

  const root = await resolveUpdateRoot();
  let configSnapshot = await runTimedFinalizePhase({
    finalizationStartedAt,
    phaseTimings,
    phase: "targetConfigValidation",
    run: async () => await readConfigFileSnapshot({ skipPluginValidation: true }),
  });
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
      return;
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
      configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
      return await persistRequestedUpdateChannel({
        configSnapshot,
        requestedChannel,
      });
    });
  }

  const initialPluginUpdate = await withPrePluginUpdateDoctorEnv(async () => {
    await runTimedFinalizePhase({
      finalizationStartedAt,
      phaseTimings,
      phase: "configSnapshot",
      run: createUpdateConfigSnapshot,
    });
    await runTimedFinalizePhase({
      finalizationStartedAt,
      phaseTimings,
      phase: "doctor",
      run: async () => {
        await runUpdateFinalizationDoctorInFreshProcess({
          phase: "pre-plugin",
          root,
          yes: opts.yes === true,
          json: opts.json === true,
          workspaceSuggestions: true,
          timeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
        });
      },
    });
    return await withPluginLifecycleLease({}, async () => {
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
      return await runTimedFinalizePhase({
        finalizationStartedAt,
        phaseTimings,
        phase: "plugins",
        run: async () =>
          await updatePluginsAfterCoreUpdate({
            root,
            channel: postDoctorChannel,
            configSnapshot,
            configChanged: restoredConfig.changed,
            restoredAuthoredChannels: restoredConfig.authoredChannels,
            opts: {
              json: opts.json,
              timeout: opts.timeout,
              yes: opts.yes,
              acceptCapabilities: opts.acceptCapabilities,
              restart: false,
            },
            timeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
            pluginInstallRecords,
          }),
        outcome: (result) =>
          result.status === "error"
            ? "failed"
            : result.status === "warning"
              ? "warning"
              : "completed",
      });
    });
  });
  // Fresh doctor acquires this same cross-process lease; completion must run after release.
  const completedPluginUpdate = await runTimedFinalizePhase({
    finalizationStartedAt,
    phaseTimings,
    phase: "targetConfigConvergence",
    run: async () =>
      await completePostCorePluginUpdate({
        root,
        pluginUpdate: initialPluginUpdate,
        freshDoctorRequired: initialPluginUpdate.changed,
        yes: opts.yes === true,
        json: opts.json === true,
        timeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      }),
    outcome: (result) =>
      result.pluginUpdate.status === "error"
        ? "failed"
        : result.pluginUpdate.status === "warning"
          ? "warning"
          : "completed",
  });
  const pluginUpdate = completedPluginUpdate.pluginUpdate;
  configSnapshot = completedPluginUpdate.configSnapshot;

  if (opts.deferCompletionCache) {
    phaseTimings.push({
      phase: "completionCache",
      startedOffsetMs: Math.max(0, Math.round(performance.now() - finalizationStartedAt)),
      durationMs: 0,
      outcome: "deferred",
    });
  } else {
    await runTimedFinalizePhase({
      finalizationStartedAt,
      phaseTimings,
      phase: "completionCache",
      run: async () => await tryWriteCompletionCache(root, Boolean(opts.json)),
      outcome: (result) => result,
    });
  }

  const result: UpdateFinalizeResult = {
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
    phaseTimings,
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
  }
  if (result.status === "error") {
    defaultRuntime.exit(1);
  }
}
