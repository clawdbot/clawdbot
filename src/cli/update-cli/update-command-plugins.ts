// Plugin synchronization and convergence after the core update.
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import { commitPluginInstallRecordsWithConfig } from "../../plugins/install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import {
  isClawHubTrustSkippedOutcome,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateOutcome,
} from "../../plugins/update.js";
import { defaultRuntime } from "../../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "../plugin-capability-consent.js";
import { listPersistedBundledPluginLocationBridges } from "../plugins-location-bridges.js";
import {
  convergenceWarningsToOutcomes,
  runPostCorePluginConvergence,
} from "./post-core-plugin-convergence.js";
import { readPackageVersion, type UpdateCommandOptions } from "./shared.js";
import {
  buildInvalidConfigPostCoreUpdateResult,
  collectMissingPluginInstallPayloads,
  resolvePostSyncPluginUpdateSkipIds,
  type MissingPluginInstallPayload,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";

export type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

const POST_UPDATE_PLUGIN_REPAIR_GUIDANCE =
  "Run openclaw update repair to retry post-update plugin repair.";

type PostUpdatePluginWarning = NonNullable<PostCorePluginUpdateResult["warnings"]>[number];

function isClawHubTrustNotice(message: string): boolean {
  return stripAnsi(message).includes("ClawHub Security Audit");
}

function isNonBlockingClawHubTrustNotice(message: string): boolean {
  const audit = stripAnsi(message);
  return audit.includes("ClawHub Security Audit") && audit.includes("Outcome: Review");
}

function formatPluginUpdateWarning(message: string): string {
  return message.includes("╭─") ? message : theme.warn(message);
}

function formatMissingPluginPayloadReason(entry: MissingPluginInstallPayload): string {
  if (entry.reason === "missing-install-path") {
    return "installPath is missing";
  }
  if (entry.reason === "missing-package-json") {
    return `package.json is missing under ${entry.installPath}`;
  }
  return `package directory is missing: ${entry.installPath}`;
}

function formatPostUpdatePluginInspectGuidance(pluginId: string): string {
  return `Run openclaw plugins inspect ${pluginId} --runtime --json for details.`;
}

function createPostUpdatePluginWarning(params: {
  pluginId?: string;
  reason: string;
}): PostUpdatePluginWarning {
  const reason = params.reason.trim() || "unknown plugin post-update failure";
  const guidance = [
    POST_UPDATE_PLUGIN_REPAIR_GUIDANCE,
    ...(params.pluginId ? [formatPostUpdatePluginInspectGuidance(params.pluginId)] : []),
  ];
  return {
    ...(params.pluginId ? { pluginId: params.pluginId } : {}),
    reason,
    message: params.pluginId
      ? `Plugin "${params.pluginId}" could not be processed after the core update: ${reason} ${guidance.join(" ")}`
      : `Plugin post-update processing could not complete after the core update: ${reason} ${guidance.join(" ")}`,
    guidance,
  };
}

function createGuidedPostUpdatePluginOutcome(
  outcome: PluginUpdateOutcome,
  options: { includeWarningInReason?: boolean } = {},
): {
  outcome: PluginUpdateOutcome;
  warning?: PostUpdatePluginWarning;
} {
  if (outcome.status !== "error" && !isActionableSkippedPostUpdateOutcome(outcome)) {
    return { outcome };
  }
  const includeWarningInReason = options.includeWarningInReason ?? true;
  const warningReason =
    outcome.warning && includeWarningInReason
      ? `${outcome.warning}\n${outcome.message}`
      : outcome.message;
  const warning = createPostUpdatePluginWarning({
    ...(outcome.pluginId && outcome.pluginId !== "unknown" ? { pluginId: outcome.pluginId } : {}),
    reason: warningReason,
  });
  return {
    outcome: {
      ...outcome,
      message: warning.message,
    },
    warning,
  };
}

function collectPluginChannelFallbackMessages(outcomes: readonly PluginUpdateOutcome[]): string[] {
  const seen = new Set<string>();
  const messages: string[] = [];
  for (const outcome of outcomes) {
    const message = outcome.channelFallback?.message;
    if (!message || seen.has(message)) {
      continue;
    }
    seen.add(message);
    messages.push(message);
  }
  return messages;
}

function isDisabledAfterFailureOutcome(outcome: PluginUpdateOutcome): boolean {
  return outcome.status === "skipped" && outcome.message.includes("after plugin update failure");
}

function isActionableSkippedPostUpdateOutcome(outcome: PluginUpdateOutcome): boolean {
  return isDisabledAfterFailureOutcome(outcome) || isClawHubTrustSkippedOutcome(outcome);
}

export async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: UpdateChannel;
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  configChanged?: boolean;
  restoredAuthoredChannels?: unknown;
  opts: UpdateCommandOptions;
  timeoutMs: number;
  pluginInstallRecords?: Record<string, PluginInstallRecord>;
}): Promise<PostCorePluginUpdateResult> {
  if (!params.configSnapshot.valid) {
    const invalid = buildInvalidConfigPostCoreUpdateResult();
    if (!params.opts.json) {
      defaultRuntime.log(theme.error(invalid.message));
      for (const line of invalid.guidance) {
        defaultRuntime.log(theme.muted(`  ${line}`));
      }
    }
    return invalid.result;
  }

  const clawHubTrustNotices = new Set<string>();
  const loggedPluginWarnings = new Set<string>();
  const hasLoggedPluginWarning = (message: string): boolean =>
    loggedPluginWarnings.has(stripAnsi(message));
  const recordLoggedPluginWarning = (message: string): void => {
    loggedPluginWarnings.add(stripAnsi(message));
  };
  const recordClawHubTrustNotice = (message: string): void => {
    const shouldRecord = params.opts.json
      ? isClawHubTrustNotice(message)
      : isNonBlockingClawHubTrustNotice(message);
    if (shouldRecord) {
      clawHubTrustNotices.add(stripAnsi(message));
    }
  };
  const pluginLogger = {
    ...(params.opts.json ? { terminalLinks: false } : {}),
    info: (msg: string) => {
      if (!params.opts.json) {
        defaultRuntime.log(msg);
      }
    },
    warn: (msg: string) => {
      recordLoggedPluginWarning(msg);
      recordClawHubTrustNotice(msg);
      if (!params.opts.json) {
        defaultRuntime.log(formatPluginUpdateWarning(msg));
      }
    },
    error: (msg: string) => {
      if (!params.opts.json) {
        defaultRuntime.log(theme.error(msg));
      }
    },
  };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const warnings: PostUpdatePluginWarning[] = [];
  const capabilityConsent = resolvePluginCapabilityConsentCliOptions({
    acceptCapabilities: params.opts.acceptCapabilities,
    action: "update",
    allowPrompt: !params.opts.json,
  });
  const pluginInstallRecords =
    params.pluginInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const coreVersion = await readPackageVersion(params.root);
  const pluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: params.channel,
    currentVersion: coreVersion,
  });
  const syncConfig = withPluginInstallRecords(
    params.configSnapshot.sourceConfig,
    pluginInstallRecords,
  );
  const syncResult = await syncPluginsForUpdateChannel({
    config: syncConfig,
    channel: pluginUpdateChannel,
    coreVersion: coreVersion ?? undefined,
    workspaceDir: params.root,
    externalizedBundledPluginBridges: await listPersistedBundledPluginLocationBridges({
      workspaceDir: params.root,
    }),
    logger: pluginLogger,
    ...capabilityConsent,
  });
  for (const error of syncResult.summary.errors) {
    warnings.push(createPostUpdatePluginWarning({ reason: error }));
  }
  let pluginConfig = syncResult.config;
  const integrityDrifts: PostCorePluginUpdateResult["integrityDrifts"] = [];
  const pluginUpdateOutcomes: PluginUpdateOutcome[] = [];
  let pluginsChanged = syncResult.changed || params.configChanged === true;
  let npmPluginsChanged = false;

  const onPluginIntegrityDrift = async (drift: PluginUpdateIntegrityDriftParams) => {
    integrityDrifts.push({
      pluginId: drift.pluginId,
      spec: drift.spec,
      expectedIntegrity: drift.expectedIntegrity,
      actualIntegrity: drift.actualIntegrity,
      ...(drift.resolvedSpec ? { resolvedSpec: drift.resolvedSpec } : {}),
      ...(drift.resolvedVersion ? { resolvedVersion: drift.resolvedVersion } : {}),
      action: "aborted",
    });
    if (!params.opts.json) {
      const specLabel = drift.resolvedSpec ?? drift.spec;
      defaultRuntime.log(
        theme.warn(
          `Integrity drift detected for "${drift.pluginId}" (${specLabel})` +
            `\nExpected: ${drift.expectedIntegrity}` +
            `\nActual:   ${drift.actualIntegrity}` +
            "\nPlugin update aborted. Reinstall the plugin only if you trust the new artifact.",
        ),
      );
    }
    return false;
  };

  const collectMissingPayloadWarnings = async (
    records: Record<string, PluginInstallRecord>,
  ): Promise<readonly string[]> => {
    const missing = await collectMissingPluginInstallPayloads({
      records,
      config: pluginConfig,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
    });
    if (missing.length === 0) {
      return [];
    }
    const missingIds = missing.map((entry) => entry.pluginId);
    for (const entry of missing) {
      const warning = createPostUpdatePluginWarning({
        pluginId: entry.pluginId,
        reason: `Plugin install payload missing after update: ${formatMissingPluginPayloadReason(entry)}.`,
      });
      warnings.push(warning);
      pluginUpdateOutcomes.push({
        pluginId: entry.pluginId,
        status: "error",
        message: warning.message,
      });
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(warning.message));
      }
    }
    const repairResult = await updateNpmInstalledPlugins({
      config: pluginConfig,
      pluginIds: missingIds,
      timeoutMs: params.timeoutMs,
      updateChannel: pluginUpdateChannel,
      coreVersion: coreVersion ?? undefined,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      disableOnFailure: true,
      logger: pluginLogger,
      onIntegrityDrift: onPluginIntegrityDrift,
      ...capabilityConsent,
    });
    pluginConfig = repairResult.config;
    pluginsChanged ||= repairResult.changed;
    npmPluginsChanged ||= repairResult.changed;
    pluginUpdateOutcomes.push(...repairResult.outcomes);
    return missingIds;
  };

  const missingPayloadIdSet = new Set(await collectMissingPayloadWarnings(pluginInstallRecords));

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    timeoutMs: params.timeoutMs,
    updateChannel: pluginUpdateChannel,
    coreVersion: coreVersion ?? undefined,
    skipIds: resolvePostSyncPluginUpdateSkipIds({
      switchedToClawHub: syncResult.summary.switchedToClawHub,
      switchedToNpm: syncResult.summary.switchedToNpm,
      repairedMissingPayloadIds: missingPayloadIdSet,
    }),
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
    disableOnFailure: true,
    logger: pluginLogger,
    onIntegrityDrift: onPluginIntegrityDrift,
    ...capabilityConsent,
  });
  pluginConfig = npmResult.config;
  pluginsChanged ||= npmResult.changed;
  npmPluginsChanged ||= npmResult.changed;
  for (const rawOutcome of npmResult.outcomes) {
    const includeWarningInReason =
      params.opts.json || !rawOutcome.warning || !hasLoggedPluginWarning(rawOutcome.warning);
    const guided = createGuidedPostUpdatePluginOutcome(rawOutcome, { includeWarningInReason });
    pluginUpdateOutcomes.push(guided.outcome);
    if (guided.warning) {
      warnings.push(guided.warning);
    }
  }

  const remainingMissingPayloads = await collectMissingPluginInstallPayloads({
    records: pluginConfig.plugins?.installs ?? {},
    config: pluginConfig,
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
  });
  pluginUpdateOutcomes.push(
    ...remainingMissingPayloads
      .filter((entry) => !missingPayloadIdSet.has(entry.pluginId))
      .map((entry): PluginUpdateOutcome => {
        const warning = createPostUpdatePluginWarning({
          pluginId: entry.pluginId,
          reason: `Plugin install payload missing after update: ${formatMissingPluginPayloadReason(entry)}.`,
        });
        warnings.push(warning);
        return {
          pluginId: entry.pluginId,
          status: "error",
          message: warning.message,
        };
      }),
  );

  // Mandatory post-core convergence: repair any configured plugin install
  // records that are still missing payloads on disk and run a static smoke
  // check that the repaired payloads are at least loadable. Failures here
  // escalate `status` to `"error"`, which the caller maps to exit 1 BEFORE
  // restarting the gateway. See `post-core-plugin-convergence.ts`.
  //
  // We pass `baselineInstallRecords: pluginConfig.plugins?.installs ?? {}`
  // so that convergence layers its mutations on top of the latest
  // *in-memory* sync/npm record state — not on the stale pre-update disk
  // snapshot. The merged map convergence returns is the single source of
  // truth for the subsequent commit block.
  const convergenceBaselineRecords = pluginConfig.plugins?.installs ?? {};
  const convergence = await runPostCorePluginConvergence({
    cfg: pluginConfig,
    env: process.env,
    compatibilityHostVersion: coreVersion ?? undefined,
    baselineInstallRecords: convergenceBaselineRecords,
    ...capabilityConsent,
  });
  for (const change of convergence.changes) {
    if (!params.opts.json) {
      defaultRuntime.log(theme.muted(change));
    }
  }
  const convergenceFolded = convergenceWarningsToOutcomes(convergence);
  for (const warning of convergenceFolded.warnings) {
    warnings.push(warning);
    if (!params.opts.json) {
      defaultRuntime.log(theme.warn(warning.message));
      for (const guidance of warning.guidance) {
        defaultRuntime.log(theme.muted(`  ${guidance}`));
      }
    }
  }
  pluginUpdateOutcomes.push(...convergenceFolded.outcomes);
  const convergenceErrored = convergenceFolded.errored;
  // Reseed `pluginConfig` from convergence's authoritative post-merge
  // record map. This is unconditional because convergence is what
  // reconciled the baseline (sync/npm in-memory state) with disk and any
  // new repairs, and convergence already persisted that exact map. If
  // we did not adopt it here, the commit block below would overwrite the
  // disk with `convergenceBaselineRecords` (no repairs included).
  pluginConfig = withPluginInstallRecords(pluginConfig, convergence.installRecords);
  if (convergence.changes.length > 0) {
    pluginsChanged = true;
  }

  if (pluginsChanged) {
    const nextInstallRecords = pluginConfig.plugins?.installs ?? {};
    let nextConfig = withoutPluginInstallRecords(pluginConfig);
    if (params.restoredAuthoredChannels !== undefined) {
      nextConfig = {
        ...nextConfig,
        channels: structuredClone(params.restoredAuthoredChannels) as OpenClawConfig["channels"],
      };
    }
    // Installed plugin metadata can own migrations that this process has not loaded yet.
    // Finalization runs fresh doctor plus strict validation before the update can complete.
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: pluginInstallRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: params.configSnapshot.hash,
      writeOptions: { skipPluginValidation: true },
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      workspaceDir: params.root,
      installRecords: nextInstallRecords,
      invalidateRuntimeCache: false,
      logger: pluginLogger,
    });
  }

  for (const notice of clawHubTrustNotices) {
    if (warnings.some((warning) => warning.reason.includes(notice))) {
      continue;
    }
    warnings.push({
      reason: notice,
      message: notice,
      guidance: [],
    });
  }

  const status =
    convergenceErrored ||
    pluginUpdateOutcomes.some(
      (outcome) =>
        outcome.status === "error" && outcome.code === PLUGIN_CAPABILITY_CONSENT_REQUIRED,
    )
      ? "error"
      : warnings.length > 0
        ? "warning"
        : "ok";
  const result: PostCorePluginUpdateResult = {
    status,
    changed: pluginsChanged,
    warnings,
    sync: {
      changed: syncResult.changed,
      switchedToBundled: syncResult.summary.switchedToBundled,
      switchedToNpm: syncResult.summary.switchedToNpm,
      warnings: syncResult.summary.warnings,
      errors: syncResult.summary.errors,
    },
    npm: {
      changed: npmPluginsChanged,
      outcomes: pluginUpdateOutcomes,
    },
    integrityDrifts,
  };

  if (params.opts.json) {
    return result;
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (syncResult.summary.switchedToBundled.length > 0) {
    defaultRuntime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(syncResult.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (syncResult.summary.switchedToNpm.length > 0) {
    defaultRuntime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(syncResult.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of syncResult.summary.warnings) {
    if (!hasLoggedPluginWarning(warning)) {
      defaultRuntime.log(formatPluginUpdateWarning(warning));
    }
  }
  for (const error of syncResult.summary.errors) {
    defaultRuntime.log(theme.warn(createPostUpdatePluginWarning({ reason: error }).message));
  }

  const updated = pluginUpdateOutcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = pluginUpdateOutcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = pluginUpdateOutcomes.filter((entry) => entry.status === "error").length;
  const skipped = pluginUpdateOutcomes.filter((entry) => entry.status === "skipped").length;

  if (pluginUpdateOutcomes.length === 0) {
    defaultRuntime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    defaultRuntime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const message of collectPluginChannelFallbackMessages(pluginUpdateOutcomes)) {
    defaultRuntime.log(theme.warn(message));
  }

  for (const outcome of pluginUpdateOutcomes) {
    if (outcome.status !== "error" && !isActionableSkippedPostUpdateOutcome(outcome)) {
      continue;
    }
    defaultRuntime.log(theme.warn(outcome.message));
  }

  return result;
}
