// Plugin synchronization and convergence after the core update.
import { PLUGIN_CAPABILITY_CONSENT_REQUIRED } from "../../../packages/gateway-protocol/src/capability-consent-error-details.js";
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { VERSION_BOUND_RUNTIME_PLUGIN_IDS } from "../../commands/doctor/shared/configured-runtime-plugin-installs.js";
import { runPostCorePluginConvergence } from "../../commands/doctor/shared/post-core-plugin-convergence.js";
import { readConfigFileSnapshot } from "../../config/config.js";
import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { resolveRegistryUpdateChannel, type UpdateChannel } from "../../infra/update-channels.js";
import type { PluginCapabilityConsentHandler } from "../../plugins/capability-consent.js";
import { commitPluginInstallRecordsWithConfig } from "../../plugins/install-record-commit.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import type { MissingPluginInstallPayload } from "../../plugins/payload-verification.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { convergePluginReleaseCohort } from "../../plugins/update-cohort.js";
import {
  isClawHubTrustSkippedOutcome,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateOutcome,
} from "../../plugins/update.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { resolvePluginCapabilityConsentCliOptions } from "../plugin-capability-consent.js";
import { listPersistedBundledPluginLocationBridges } from "../plugins-location-bridges.js";
import { readPackageVersion } from "./shared.js";
import {
  buildInvalidConfigPostCoreUpdateResult,
  type PostCorePluginUpdateResult,
} from "./update-command-plugins-internals.js";

export type { PostCorePluginUpdateResult } from "./update-command-plugins-internals.js";

const POST_UPDATE_PLUGIN_REPAIR_GUIDANCE =
  "Run openclaw update repair to retry post-update plugin repair.";

type PostUpdatePluginWarning = NonNullable<PostCorePluginUpdateResult["warnings"]>[number];

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
  configWriteOptions: ConfigWriteOptions;
  configChanged?: boolean;
  restoredAuthoredChannels?: unknown;
  timeoutMs: number;
  pluginInstallRecords?: Record<string, PluginInstallRecord>;
  json?: boolean;
  acceptCapabilities?: boolean;
  onCapabilityConsent?: PluginCapabilityConsentHandler;
  runtime?: RuntimeEnv;
}): Promise<PostCorePluginUpdateResult> {
  const runtime = params.runtime ?? defaultRuntime;
  if (!params.configSnapshot.valid) {
    const invalid = buildInvalidConfigPostCoreUpdateResult();
    if (!params.json) {
      runtime.log(theme.error(invalid.message));
      for (const line of invalid.guidance) {
        runtime.log(theme.muted(`  ${line}`));
      }
    }
    return invalid.result;
  }

  const clawHubTrustNotices = new Set<string>();
  const loggedPluginWarnings = new Set<string>();
  const pluginLogger = {
    ...(params.json ? { terminalLinks: false } : {}),
    info: (msg: string) => {
      if (!params.json) {
        runtime.log(msg);
      }
    },
    warn: (msg: string) => {
      const plain = stripAnsi(msg);
      loggedPluginWarnings.add(plain);
      if (
        plain.includes("ClawHub Security Audit") &&
        (params.json || plain.includes("Outcome: Review"))
      ) {
        clawHubTrustNotices.add(plain);
      }
      if (!params.json) {
        runtime.log(formatPluginUpdateWarning(msg));
      }
    },
    error: (msg: string) => {
      if (!params.json) {
        runtime.log(theme.error(msg));
      }
    },
  };

  if (!params.json) {
    runtime.log("");
    runtime.log(theme.heading("Updating plugins..."));
  }

  const warnings: PostUpdatePluginWarning[] = [];
  const capabilityConsent = params.onCapabilityConsent
    ? { onCapabilityConsent: params.onCapabilityConsent }
    : resolvePluginCapabilityConsentCliOptions({
        acceptCapabilities: params.acceptCapabilities,
        action: "update",
        allowPrompt: !params.json,
        runtime,
      });
  const pluginInstallRecords =
    params.pluginInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const coreVersion = await readPackageVersion(params.root);
  const pluginUpdateChannel = resolveRegistryUpdateChannel({
    configChannel: params.channel,
    currentVersion: coreVersion,
  });
  const integrityDrifts: PostCorePluginUpdateResult["integrityDrifts"] = [];
  const pluginUpdateOutcomes: PluginUpdateOutcome[] = [];
  const collectPluginOutcome = (outcome: PluginUpdateOutcome) => {
    if (outcome.status !== "error" && !isActionableSkippedPostUpdateOutcome(outcome)) {
      pluginUpdateOutcomes.push(outcome);
      return;
    }
    const includeWarningInReason =
      params.json || !outcome.warning || !loggedPluginWarnings.has(stripAnsi(outcome.warning));
    const warning = createPostUpdatePluginWarning({
      ...(outcome.pluginId && outcome.pluginId !== "unknown" ? { pluginId: outcome.pluginId } : {}),
      reason:
        outcome.warning && includeWarningInReason
          ? `${outcome.warning}\n${outcome.message}`
          : outcome.message,
    });
    pluginUpdateOutcomes.push({ ...outcome, message: warning.message });
    warnings.push(warning);
  };
  const collectMissingPayloadOutcome = (entry: MissingPluginInstallPayload) => {
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
    return warning;
  };

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
    if (!params.json) {
      const specLabel = drift.resolvedSpec ?? drift.spec;
      runtime.log(
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

  const cohort = await convergePluginReleaseCohort({
    config: withPluginInstallRecords(params.configSnapshot.sourceConfig, pluginInstallRecords),
    channel: pluginUpdateChannel,
    coreVersion: coreVersion ?? undefined,
    versionBoundPluginIds: VERSION_BOUND_RUNTIME_PLUGIN_IDS,
    timeoutMs: params.timeoutMs,
    workspaceDir: params.root,
    externalizedBundledPluginBridges: await listPersistedBundledPluginLocationBridges({
      workspaceDir: params.root,
    }),
    logger: pluginLogger,
    onIntegrityDrift: onPluginIntegrityDrift,
    ...capabilityConsent,
  });
  for (const error of cohort.sync.summary.errors) {
    collectPluginOutcome({ ...error, status: "error" });
  }
  let pluginConfig = cohort.config;
  let pluginsChanged = cohort.changed || params.configChanged === true;
  for (const entry of cohort.missingPayloads) {
    const warning = collectMissingPayloadOutcome(entry);
    if (!params.json) {
      runtime.log(theme.warn(warning.message));
    }
  }
  pluginUpdateOutcomes.push(...cohort.repairOutcomes);
  for (const rawOutcome of cohort.updateOutcomes) {
    collectPluginOutcome(rawOutcome);
  }

  for (const entry of cohort.remainingMissingPayloads) {
    if (!cohort.repairedMissingPayloadIds.has(entry.pluginId)) {
      collectMissingPayloadOutcome(entry);
    }
  }

  // Convergence checks activation before restart. Seed it from the current
  // sync/npm records so repair cannot overwrite them with an older disk snapshot.
  const convergenceBaselineRecords = pluginConfig.plugins?.installs ?? {};
  const convergence = await runPostCorePluginConvergence({
    cfg: pluginConfig,
    env: process.env,
    compatibilityHostVersion: coreVersion ?? undefined,
    baselineInstallRecords: convergenceBaselineRecords,
    ...capabilityConsent,
  });
  for (const change of convergence.changes) {
    if (!params.json) {
      runtime.log(theme.muted(change));
    }
  }
  const convergenceOutcomes: PluginUpdateOutcome[] = [
    ...(convergence.outcomes ?? []),
    ...convergence.warnings.flatMap((warning): PluginUpdateOutcome[] =>
      warning.pluginId
        ? [{ pluginId: warning.pluginId, status: "error", message: warning.message }]
        : [],
    ),
  ];
  const convergenceErrored = convergence.errored;
  for (const warning of [...convergence.warnings, ...(convergence.notices ?? [])]) {
    warnings.push(warning);
    if (!params.json) {
      runtime.log(theme.warn(warning.message));
      for (const guidance of warning.guidance) {
        runtime.log(theme.muted(`  ${guidance}`));
      }
    }
  }
  pluginUpdateOutcomes.push(...convergenceOutcomes);
  // Repair already persisted this authoritative map; the commit below must not
  // restore the pre-convergence records and discard successful repairs.
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
      writeOptions: {
        ...params.configWriteOptions,
        inputBase: "source",
        skipPluginValidation: true,
      },
    });
    await refreshPluginRegistryAfterConfigMutation({
      configPath: params.configSnapshot.path,
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
      changed: cohort.sync.changed,
      switchedToBundled: cohort.sync.summary.switchedToBundled,
      switchedToNpm: cohort.sync.summary.switchedToNpm,
      warnings: cohort.sync.summary.warnings,
      errors: cohort.sync.summary.errors.map((error) => error.message),
    },
    npm: {
      changed: cohort.npmChanged,
      outcomes: pluginUpdateOutcomes,
    },
    integrityDrifts,
  };

  if (params.json) {
    return result;
  }

  const summarizeList = (list: string[]) => {
    if (list.length <= 6) {
      return list.join(", ");
    }
    return `${list.slice(0, 6).join(", ")} +${list.length - 6} more`;
  };

  if (cohort.sync.summary.switchedToBundled.length > 0) {
    runtime.log(
      theme.muted(
        `Switched to bundled plugins: ${summarizeList(cohort.sync.summary.switchedToBundled)}.`,
      ),
    );
  }
  if (cohort.sync.summary.switchedToNpm.length > 0) {
    runtime.log(
      theme.muted(`Restored npm plugins: ${summarizeList(cohort.sync.summary.switchedToNpm)}.`),
    );
  }
  for (const warning of cohort.sync.summary.warnings) {
    if (!loggedPluginWarnings.has(stripAnsi(warning))) {
      runtime.log(formatPluginUpdateWarning(warning));
    }
  }
  const updated = pluginUpdateOutcomes.filter((entry) => entry.status === "updated").length;
  const unchanged = pluginUpdateOutcomes.filter((entry) => entry.status === "unchanged").length;
  const failed = pluginUpdateOutcomes.filter((entry) => entry.status === "error").length;
  const skipped = pluginUpdateOutcomes.filter((entry) => entry.status === "skipped").length;

  if (pluginUpdateOutcomes.length === 0) {
    runtime.log(theme.muted("No plugin updates needed."));
  } else {
    const parts = [`${updated} updated`, `${unchanged} unchanged`];
    if (failed > 0) {
      parts.push(`${failed} failed`);
    }
    if (skipped > 0) {
      parts.push(`${skipped} skipped`);
    }
    runtime.log(theme.muted(`npm plugins: ${parts.join(", ")}.`));
  }

  for (const message of collectPluginChannelFallbackMessages(pluginUpdateOutcomes)) {
    runtime.log(theme.warn(message));
  }

  for (const outcome of pluginUpdateOutcomes) {
    if (outcome.status !== "error" && !isActionableSkippedPostUpdateOutcome(outcome)) {
      continue;
    }
    runtime.log(theme.warn(outcome.message));
  }

  return result;
}
