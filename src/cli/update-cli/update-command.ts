import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { confirm, isCancel } from "@clack/prompts";
import {
  checkShellCompletionStatus,
  ensureCompletionCacheExists,
} from "../../commands/doctor-completion.js";
import { doctorCommand } from "../../commands/doctor.js";
import { UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV } from "../../commands/doctor/shared/update-phase.js";
import { createPreUpdateConfigSnapshot } from "../../config/backup-rotation.js";
import {
  assertConfigWriteAllowedInCurrentMode,
  mutateConfigFileWithRetry,
  parseConfigJson5,
  readConfigFileSnapshot,
  resolveGatewayPort,
} from "../../config/config.js";
import { resolveConfigEnvVars } from "../../config/env-substitution.js";
import { resolveConfigIncludes } from "../../config/includes.js";
import { formatConfigIssueLines } from "../../config/issue-format.js";
import { asResolvedSourceConfig, asRuntimeConfig } from "../../config/materialize.js";
import { CONFIG_PATH, resolveIncludeRoots } from "../../config/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { GATEWAY_SERVICE_KIND, GATEWAY_SERVICE_MARKER } from "../../daemon/constants.js";
import { resolveGatewayInstallEntrypoint } from "../../daemon/gateway-entrypoint.js";
import { disableCurrentOpenClawUpdateLaunchdJob } from "../../daemon/launchd.js";
import { resolveGatewayRestartLogPath } from "../../daemon/restart-logs.js";
import {
  readGatewayServiceState,
  resolveGatewayService,
  type GatewayService,
} from "../../daemon/service.js";
import { createLowDiskSpaceWarning } from "../../infra/disk-space.js";
import { pathExists } from "../../infra/fs-safe.js";
import { readJsonIfExists, writeJson } from "../../infra/json-files.js";
import { runGlobalPackageUpdateSteps } from "../../infra/package-update-steps.js";
import { getSelfAndAncestorPidsSync } from "../../infra/restart-stale-pids.js";
import { nodeVersionSatisfiesEngine } from "../../infra/runtime-guard.js";
import {
  channelToNpmTag,
  DEFAULT_GIT_CHANNEL,
  DEFAULT_PACKAGE_CHANNEL,
  normalizeUpdateChannel,
} from "../../infra/update-channels.js";
import {
  compareSemverStrings,
  fetchNpmPackageTargetStatus,
  resolveNpmChannelTag,
  checkUpdateStatus,
} from "../../infra/update-check.js";
import {
  buildControlPlaneUpdateRestartHealthPendingResult,
  markControlPlaneUpdateRestartSentinelFailure,
  readControlPlaneUpdateSentinelMeta,
  writeControlPlaneUpdateRestartSentinel,
  type ControlPlaneUpdateSentinelMetaFile,
} from "../../infra/update-control-plane-sentinel.js";
import {
  canResolveRegistryVersionForPackageTarget,
  createGlobalInstallEnv,
  cleanupGlobalRenameDirs,
  globalInstallArgs,
  resolveGlobalInstallTarget,
  resolveGlobalInstallSpec,
  resolvePnpmGlobalDirFromGlobalRoot,
} from "../../infra/update-global.js";
import { cleanupStaleManagedServiceUpdateHandoffs } from "../../infra/update-managed-service-handoff-cleanup.js";
import { runGatewayUpdate, type UpdateRunResult } from "../../infra/update-runner.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../../plugins/config-state.js";
import {
  loadInstalledPluginIndexInstallRecords,
  withoutPluginInstallRecords,
  withPluginInstallRecords,
} from "../../plugins/installed-plugin-index-records.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
  syncPluginsForUpdateChannel,
  updateNpmInstalledPlugins,
  type PluginUpdateIntegrityDriftParams,
  type PluginUpdateOutcome,
} from "../../plugins/update.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { defaultRuntime } from "../../runtime.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { stylePromptMessage } from "../../terminal/prompt-style.js";
import { theme } from "../../terminal/theme.js";
import { resolveUserPath } from "../../utils.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { formatCliCommand } from "../command-format.js";
import { installCompletion } from "../completion-runtime.js";
import { runDaemonInstall, runDaemonRestart } from "../daemon-cli.js";
import { recoverInstalledLaunchAgent } from "../daemon-cli/launchd-recovery.js";
import {
  renderRestartDiagnostics,
  terminateStaleGatewayPids,
  waitForGatewayHealthyRestart,
  type GatewayRestartSnapshot,
} from "../daemon-cli/restart-health.js";
import { commitPluginInstallRecordsWithConfig } from "../plugins-install-record-commit.js";
import { listPersistedBundledPluginLocationBridges } from "../plugins-location-bridges.js";
import { refreshPluginRegistryAfterConfigMutation } from "../plugins-registry-refresh.js";
import {
  convergenceWarningsToOutcomes,
  runPostCorePluginConvergence,
} from "./post-core-plugin-convergence.js";
import { createUpdateProgress, printResult } from "./progress.js";
import { prepareRestartScript, runRestartScript } from "./restart-helper.js";
import {
  DEFAULT_PACKAGE_NAME,
  createGlobalCommandRunner,
  ensureGitCheckout,
  normalizeTag,
  parseTimeoutMsOrExit,
  readPackageName,
  readPackageVersion,
  resolveGitInstallDir,
  resolveGlobalManager,
  resolveNodeRunner,
  resolveTargetVersion,
  resolveUpdateRoot,
  runUpdateStep,
  tryWriteCompletionCache,
  type UpdateCommandOptions,
  type UpdateFinalizeOptions,
} from "./shared.js";
import { suppressDeprecations } from "./suppress-deprecations.js";

const CLI_NAME = resolveCliName();
const SERVICE_REFRESH_TIMEOUT_MS = 60_000;
const POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS = 10;
const POST_REFRESH_ALREADY_HEALTHY_DELAY_MS = 500;
const DEFAULT_UPDATE_STEP_TIMEOUT_MS = 30 * 60_000;
const POST_CORE_UPDATE_ENV = "OPENCLAW_UPDATE_POST_CORE";
const POST_CORE_UPDATE_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_CHANNEL";
const POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV = "OPENCLAW_UPDATE_POST_CORE_REQUESTED_CHANNEL";
const POST_CORE_UPDATE_RESULT_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_RESULT_PATH";
const POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_INSTALL_RECORDS_PATH";
const POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV = "OPENCLAW_UPDATE_POST_CORE_SOURCE_CONFIG_PATH";
const POST_CORE_UPDATE_STARTED_AT_ENV = "OPENCLAW_UPDATE_POST_CORE_STARTED_AT_MS";
const POST_CORE_UPDATE_RESULT_POLL_MS = 100;
const PRE_UPDATE_CONFIG_SNAPSHOT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV =
  "OPENCLAW_UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE";
const SERVICE_REFRESH_PATH_ENV_KEYS = [
  "OPENCLAW_HOME",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
] as const;
const POST_INSTALL_DOCTOR_SERVICE_ENV_KEYS = [
  ...SERVICE_REFRESH_PATH_ENV_KEYS,
  "OPENCLAW_PROFILE",
] as const;
const POST_UPDATE_PLUGIN_REPAIR_GUIDANCE = "Run openclaw doctor --fix to attempt automatic repair.";

async function createUpdateConfigSnapshot(): Promise<void> {
  await createPreUpdateConfigSnapshot({
    configPath: CONFIG_PATH,
    fs: { writeFile: fs.writeFile, readFile: fs.readFile, existsSync },
  });
}

const UPDATE_QUIPS = [
  "Leveled up! New skills unlocked. You're welcome.",
  "Fresh code, same lobster. Miss me?",
  "Back and better. Did you even notice I was gone?",
  "Update complete. I learned some new tricks while I was out.",
  "Upgraded! Now with 23% more sass.",
  "I've evolved. Try to keep up.",
  "New version, who dis? Oh right, still me but shinier.",
  "Patched, polished, and ready to pinch. Let's go.",
  "The lobster has molted. Harder shell, sharper claws.",
  "Update done! Check the changelog or just trust me, it's good.",
  "Reborn from the boiling waters of npm. Stronger now.",
  "I went away and came back smarter. You should try it sometime.",
  "Update complete. The bugs feared me, so they left.",
  "New version installed. Old version sends its regards.",
  "Firmware fresh. Brain wrinkles: increased.",
  "I've seen things you wouldn't believe. Anyway, I'm updated.",
  "Back online. The changelog is long but our friendship is longer.",
  "Upgraded! Peter fixed stuff. Blame him if it breaks.",
  "Molting complete. Please don't look at my soft shell phase.",
  "Version bump! Same chaos energy, fewer crashes (probably).",
];

type PostCorePluginUpdateResult = NonNullable<
  NonNullable<UpdateRunResult["postUpdate"]>["plugins"]
>;

type PreUpdateConfigRestoreInput = {
  sourceConfig: OpenClawConfig;
  authoredConfig: OpenClawConfig;
};

type MissingPluginInstallPayload = {
  pluginId: string;
  installPath?: string;
  reason: "missing-install-path" | "missing-package-dir" | "missing-package-json";
};

type PostUpdatePluginWarning = NonNullable<PostCorePluginUpdateResult["warnings"]>[number];

function pickUpdateQuip(): string {
  return UPDATE_QUIPS[Math.floor(Math.random() * UPDATE_QUIPS.length)] ?? "Update complete.";
}

function isPackageManagerUpdateMode(mode: UpdateRunResult["mode"]): mode is "npm" | "pnpm" | "bun" {
  return mode === "npm" || mode === "pnpm" || mode === "bun";
}

function isTrackedPackageInstallRecord(record: PluginInstallRecord): boolean {
  return (
    record.source === "npm" ||
    record.source === "clawhub" ||
    record.source === "git" ||
    record.source === "marketplace"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizePluginInstallRecordMap(value: unknown): Record<string, PluginInstallRecord> {
  if (!isRecord(value)) {
    return {};
  }
  const records: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(value).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (isRecord(record) && typeof record.source === "string") {
      records[pluginId] = structuredClone(record) as PluginInstallRecord;
    }
  }
  return records;
}

function normalizeChannelConfigMap(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) {
    return null;
  }
  return value;
}

function normalizeDirectAuthoredChannelConfigMap(value: unknown): Record<string, unknown> | null {
  const channels = normalizeChannelConfigMap(value);
  if (!channels || Object.prototype.hasOwnProperty.call(channels, "$include")) {
    return null;
  }
  return channels;
}

function restorePreUpdateChannelModelOverrides(params: {
  channels: Record<string, unknown>;
  preUpdateChannels: Record<string, unknown>;
  restoredChannelIds: string[];
}): { channels: Record<string, unknown>; changed: boolean } {
  if (params.restoredChannelIds.length === 0) {
    return { channels: params.channels, changed: false };
  }
  const preUpdateModelByChannel = normalizeChannelConfigMap(
    params.preUpdateChannels.modelByChannel,
  );
  if (!preUpdateModelByChannel) {
    return { channels: params.channels, changed: false };
  }
  const currentModelByChannel = normalizeChannelConfigMap(params.channels.modelByChannel) ?? {};
  const restoredModelByChannel = structuredClone(currentModelByChannel);
  let changed = false;
  for (const [providerId, providerOverrides] of Object.entries(preUpdateModelByChannel)) {
    const preUpdateProviderOverrides = normalizeChannelConfigMap(providerOverrides);
    if (!preUpdateProviderOverrides) {
      continue;
    }
    const currentProviderOverrides =
      normalizeChannelConfigMap(restoredModelByChannel[providerId]) ?? {};
    let providerChanged = false;
    for (const channelId of params.restoredChannelIds) {
      if (
        currentProviderOverrides[channelId] !== undefined ||
        preUpdateProviderOverrides[channelId] === undefined
      ) {
        continue;
      }
      currentProviderOverrides[channelId] = structuredClone(preUpdateProviderOverrides[channelId]);
      providerChanged = true;
    }
    if (providerChanged) {
      restoredModelByChannel[providerId] = currentProviderOverrides;
      changed = true;
    }
  }
  return changed
    ? { channels: { ...params.channels, modelByChannel: restoredModelByChannel }, changed: true }
    : { channels: params.channels, changed: false };
}

function restoreDroppedPreUpdateChannels(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  preUpdateConfig: PreUpdateConfigRestoreInput | undefined,
): {
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  changed: boolean;
  authoredChannels?: unknown;
} {
  if (!snapshot.valid || !preUpdateConfig) {
    return { snapshot, changed: false };
  }
  const preUpdateChannels = normalizeChannelConfigMap(preUpdateConfig.sourceConfig.channels);
  if (!preUpdateChannels) {
    return { snapshot, changed: false };
  }

  const postUpdateChannels = normalizeChannelConfigMap(snapshot.sourceConfig.channels) ?? {};
  let restoredChannels = { ...postUpdateChannels };
  const restoredChannelIds: string[] = [];
  let restored = false;
  for (const [channelId, channelConfig] of Object.entries(preUpdateChannels)) {
    if (restoredChannels[channelId] !== undefined) {
      continue;
    }
    restoredChannels[channelId] = structuredClone(channelConfig);
    if (channelId !== "modelByChannel") {
      restoredChannelIds.push(channelId);
    }
    restored = true;
  }
  if (!restored) {
    return { snapshot, changed: false };
  }
  const restoredModelOverrides = restorePreUpdateChannelModelOverrides({
    channels: restoredChannels,
    preUpdateChannels,
    restoredChannelIds,
  });
  restoredChannels = restoredModelOverrides.channels;

  const authoredChannels = resolveRestoredAuthoredChannels({
    currentChannels: snapshot.sourceConfig.channels,
    currentAuthoredChannels: isRecord(snapshot.parsed)
      ? (snapshot.parsed as OpenClawConfig).channels
      : snapshot.sourceConfig.channels,
    preUpdateAuthoredChannels: preUpdateConfig.authoredConfig.channels,
    restoredChannelIds,
  });
  const nextConfig = {
    ...snapshot.sourceConfig,
    channels: restoredChannels,
  } as OpenClawConfig;
  return {
    snapshot: {
      ...createUpdatedConfigSnapshot(snapshot, nextConfig),
      hash: snapshot.hash,
    },
    changed: true,
    ...(authoredChannels !== undefined ? { authoredChannels } : {}),
  };
}

function hasRestorablePreUpdateChannels(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  preUpdateConfig: PreUpdateConfigRestoreInput,
): boolean {
  if (!snapshot.valid) {
    return false;
  }
  const preUpdateChannels = normalizeChannelConfigMap(preUpdateConfig.sourceConfig.channels);
  if (!preUpdateChannels) {
    return false;
  }
  const postUpdateChannels = normalizeChannelConfigMap(snapshot.sourceConfig.channels) ?? {};
  return Object.keys(preUpdateChannels).some(
    (channelId) => postUpdateChannels[channelId] === undefined,
  );
}

function resolveRestoredAuthoredChannels(params: {
  currentChannels: unknown;
  currentAuthoredChannels: unknown;
  preUpdateAuthoredChannels: unknown;
  restoredChannelIds: string[];
}): unknown {
  if (params.preUpdateAuthoredChannels === undefined) {
    return undefined;
  }
  const directAuthoredChannels = normalizeDirectAuthoredChannelConfigMap(
    params.preUpdateAuthoredChannels,
  );
  if (!directAuthoredChannels) {
    const preUpdateAuthoredChannels = normalizeChannelConfigMap(params.preUpdateAuthoredChannels);
    if (!preUpdateAuthoredChannels) {
      return undefined;
    }
    const currentDirectAuthoredChannels = normalizeDirectAuthoredChannelConfigMap(
      params.currentAuthoredChannels,
    );
    if (currentDirectAuthoredChannels) {
      return {
        ...structuredClone(preUpdateAuthoredChannels),
        ...structuredClone(currentDirectAuthoredChannels),
      };
    }
    const currentAuthoredChannels = normalizeChannelConfigMap(params.currentAuthoredChannels);
    return !currentAuthoredChannels || Object.keys(currentAuthoredChannels).length === 0
      ? structuredClone(preUpdateAuthoredChannels)
      : undefined;
  }

  const currentChannels =
    normalizeDirectAuthoredChannelConfigMap(params.currentAuthoredChannels) ??
    normalizeDirectAuthoredChannelConfigMap(params.currentChannels) ??
    {};
  const restoredChannels = { ...currentChannels };
  let changed = false;
  for (const channelId of params.restoredChannelIds) {
    if (
      restoredChannels[channelId] !== undefined ||
      directAuthoredChannels[channelId] === undefined
    ) {
      continue;
    }
    restoredChannels[channelId] = structuredClone(directAuthoredChannels[channelId]);
    changed = true;
  }
  const restoredModelOverrides = restorePreUpdateChannelModelOverrides({
    channels: restoredChannels,
    preUpdateChannels: directAuthoredChannels,
    restoredChannelIds: params.restoredChannelIds,
  });
  if (restoredModelOverrides.changed) {
    return restoredModelOverrides.channels;
  }
  return changed ? restoredChannels : undefined;
}

export async function collectMissingPluginInstallPayloads(params: {
  records: Record<string, PluginInstallRecord>;
  config?: OpenClawConfig;
  skipDisabledPlugins?: boolean;
  syncOfficialPluginInstalls?: boolean;
  env?: NodeJS.ProcessEnv;
}): Promise<MissingPluginInstallPayload[]> {
  const env = params.env ?? process.env;
  const normalizedPluginConfig =
    params.skipDisabledPlugins && params.config
      ? normalizePluginsConfig(params.config.plugins)
      : undefined;
  const missing: MissingPluginInstallPayload[] = [];
  for (const [pluginId, record] of Object.entries(params.records).toSorted(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!isTrackedPackageInstallRecord(record)) {
      continue;
    }
    const officialNpmSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record })
      : undefined;
    const officialClawHubSpec = params.syncOfficialPluginInstalls
      ? resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record })
      : undefined;
    if (normalizedPluginConfig && params.config) {
      const enableState = resolveEffectiveEnableState({
        id: pluginId,
        origin: "global",
        config: normalizedPluginConfig,
        rootConfig: params.config,
      });
      if (!enableState.enabled && !officialNpmSpec && !officialClawHubSpec) {
        continue;
      }
    }
    const rawInstallPath = normalizeOptionalString(record.installPath);
    if (!rawInstallPath) {
      missing.push({ pluginId, reason: "missing-install-path" });
      continue;
    }
    const installPath = resolveUserPath(rawInstallPath, env);
    if (!(await pathExists(installPath))) {
      missing.push({ pluginId, installPath, reason: "missing-package-dir" });
      continue;
    }
    const packageJsonPath = path.join(installPath, "package.json");
    if (!(await pathExists(packageJsonPath))) {
      missing.push({ pluginId, installPath, reason: "missing-package-json" });
    }
  }
  return missing;
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

function createGuidedPostUpdatePluginOutcome(outcome: PluginUpdateOutcome): {
  outcome: PluginUpdateOutcome;
  warning?: PostUpdatePluginWarning;
} {
  if (outcome.status !== "error" && !isDisabledAfterFailureOutcome(outcome)) {
    return { outcome };
  }
  const warning = createPostUpdatePluginWarning({
    ...(outcome.pluginId && outcome.pluginId !== "unknown" ? { pluginId: outcome.pluginId } : {}),
    reason: outcome.message,
  });
  return {
    outcome: {
      ...outcome,
      message: warning.message,
    },
    warning,
  };
}

function isDisabledAfterFailureOutcome(outcome: PluginUpdateOutcome): boolean {
  return outcome.status === "skipped" && outcome.message.includes("after plugin update failure");
}

/**
 * Build the post-core-update result we return when the active config cannot
 * even be parsed. Mandatory post-core convergence requires a parseable
 * config to know which plugins are configured; if one isn't available, we
 * refuse to restart the gateway and surface this as a hard error so the
 * existing `status === "error"` ⇒ `exit 1` pre-restart gate fires.
 *
 * Exported for unit testing without having to drive the entire
 * `updatePluginsAfterCoreUpdate` orchestrator.
 */
export function buildInvalidConfigPostCoreUpdateResult(): {
  message: string;
  guidance: string[];
  result: PostCorePluginUpdateResult;
} {
  const guidance = [
    "Run `openclaw doctor` to inspect the config validation errors.",
    "Once the config parses, rerun `openclaw update`.",
  ];
  const message =
    "Plugin post-update convergence skipped because the config is invalid; refusing to restart the gateway with an unverified plugin set.";
  return {
    message,
    guidance,
    result: {
      status: "error",
      reason: "invalid-config",
      changed: false,
      sync: {
        changed: false,
        switchedToBundled: [],
        switchedToNpm: [],
        warnings: [],
        errors: [],
      },
      npm: {
        changed: false,
        outcomes: [],
      },
      integrityDrifts: [],
      warnings: [{ reason: "invalid-config", message, guidance }],
    },
  };
}

export function shouldPrepareUpdatedInstallRestart(params: {
  updateMode: UpdateRunResult["mode"];
  serviceInstalled: boolean;
  serviceLoaded: boolean;
}): boolean {
  if (isPackageManagerUpdateMode(params.updateMode)) {
    return params.serviceInstalled;
  }
  return params.serviceLoaded;
}

export function shouldUseLegacyProcessRestartAfterUpdate(params: {
  updateMode: UpdateRunResult["mode"];
}): boolean {
  return !isPackageManagerUpdateMode(params.updateMode);
}

type PostUpdateLaunchAgentRecoveryResult =
  | { attempted: false; recovered: false }
  | { attempted: true; recovered: true; message: string }
  | { attempted: true; recovered: false; detail: string };

type PostUpdateLaunchAgentRecoveryDeps = {
  platform?: NodeJS.Platform;
  readState?: typeof readGatewayServiceState;
  recover?: typeof recoverInstalledLaunchAgent;
};

export async function recoverInstalledLaunchAgentAfterUpdate(params: {
  service?: GatewayService;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateLaunchAgentRecoveryDeps;
}): Promise<PostUpdateLaunchAgentRecoveryResult> {
  const platform = params.deps?.platform ?? process.platform;
  if (platform !== "darwin") {
    return { attempted: false, recovered: false };
  }

  const service = params.service ?? resolveGatewayService();
  const readState = params.deps?.readState ?? readGatewayServiceState;
  const recover = params.deps?.recover ?? recoverInstalledLaunchAgent;
  const state = await readState(service, { env: params.env }).catch(() => null);
  if (state?.loaded) {
    return { attempted: false, recovered: false };
  }
  if (state && !state.installed && !state.runtime?.missingSupervision) {
    return { attempted: false, recovered: false };
  }

  const recovered = await recover({ result: "restarted", env: state?.env ?? params.env }).catch(
    () => null,
  );
  if (!recovered) {
    return {
      attempted: true,
      recovered: false,
      detail:
        "LaunchAgent was installed but not loaded; automatic bootstrap/kickstart recovery failed.",
    };
  }

  return {
    attempted: true,
    recovered: true,
    message: recovered.message,
  };
}

type PostUpdateGatewayHealthRecoveryDeps = {
  recoverLaunchAgent?: typeof recoverInstalledLaunchAgentAfterUpdate;
  waitForHealthy?: typeof waitForGatewayHealthyRestart;
};

export async function recoverLaunchAgentAndRecheckGatewayHealth(params: {
  health: GatewayRestartSnapshot;
  service: GatewayService;
  port: number;
  expectedVersion?: string;
  env?: NodeJS.ProcessEnv;
  deps?: PostUpdateGatewayHealthRecoveryDeps;
}): Promise<{
  health: GatewayRestartSnapshot;
  launchAgentRecovery: PostUpdateLaunchAgentRecoveryResult | null;
}> {
  if (params.health.healthy) {
    return { health: params.health, launchAgentRecovery: null };
  }

  const recoverLaunchAgent =
    params.deps?.recoverLaunchAgent ?? recoverInstalledLaunchAgentAfterUpdate;
  const launchAgentRecovery = await recoverLaunchAgent({
    service: params.service,
    env: params.env,
  });
  if (!launchAgentRecovery.recovered) {
    return { health: params.health, launchAgentRecovery };
  }

  const waitForHealthy = params.deps?.waitForHealthy ?? waitForGatewayHealthyRestart;
  const health = await waitForHealthy({
    service: params.service,
    port: params.port,
    expectedVersion: params.expectedVersion,
    env: params.env,
  });
  return { health, launchAgentRecovery };
}

function formatPostUpdateGatewayRecoveryInstructions(result: UpdateRunResult): string[] {
  const lines = [
    `Recovery: run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`; if macOS reports the LaunchAgent is installed but not loaded, run \`${replaceCliName(formatCliCommand("openclaw gateway install --force"), CLI_NAME)}\` from the logged-in user session, then rerun \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\`.`,
  ];
  const beforeVersion = normalizeOptionalString(result.before?.version);
  if (isPackageManagerUpdateMode(result.mode) && beforeVersion) {
    lines.push(
      `Rollback: reinstall OpenClaw ${beforeVersion} with the same package manager, then rerun \`${replaceCliName(formatCliCommand("openclaw gateway install --force"), CLI_NAME)}\`.`,
    );
  }
  return lines;
}

type PrePackageServiceStop = {
  stopped: boolean;
  inspected: boolean;
  runtimeInspected: boolean;
  running: boolean;
  blockMessage?: string;
  serviceEnv?: NodeJS.ProcessEnv;
};

function formatGatewayAncestryBlockMessage(pid: number): string {
  return `openclaw update detected it is running inside the gateway process tree.
Gateway PID ${pid} is an ancestor of this process, so this updater cannot safely stop or restart the gateway that owns it.
Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`;
}

function isGatewayAncestorPid(pid: unknown): pid is number {
  return typeof pid === "number" && pid > 0 && getSelfAndAncestorPidsSync().has(pid);
}

function gatewayAncestryBlockMessage(pid: unknown): string | undefined {
  return isGatewayAncestorPid(pid) ? formatGatewayAncestryBlockMessage(pid) : undefined;
}

function gatewayRuntimeAncestryBlockMessage(
  runtime: { pid?: unknown } | null | undefined,
): string | undefined {
  return gatewayAncestryBlockMessage(runtime?.pid);
}

async function maybeStopManagedServiceBeforePackageUpdate(params: {
  shouldRestart: boolean;
  jsonMode: boolean;
}): Promise<PrePackageServiceStop> {
  let service: ReturnType<typeof resolveGatewayService>;
  let serviceState: Awaited<ReturnType<typeof readGatewayServiceState>>;
  try {
    service = resolveGatewayService();
    serviceState = await readGatewayServiceState(service, { env: process.env });
  } catch {
    return { stopped: false, inspected: false, runtimeInspected: false, running: false };
  }

  const runtimeStatus = serviceState.runtime?.status;
  const runtimeInspected = runtimeStatus === "running" || runtimeStatus === "stopped";
  if (!serviceState.installed) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected,
      running: serviceState.running,
      serviceEnv: serviceState.env,
    };
  }

  if (!params.shouldRestart) {
    if (!params.jsonMode && serviceState.running) {
      defaultRuntime.log(
        theme.warn(
          "--no-restart is set while the managed gateway service is running; the package update will not stop or restart that process.",
        ),
      );
    }
    return {
      stopped: false,
      inspected: true,
      runtimeInspected,
      running: serviceState.running,
      serviceEnv: serviceState.env,
    };
  }

  if (!runtimeInspected) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: false,
      running: false,
      serviceEnv: serviceState.env,
    };
  }

  if (!serviceState.running) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: false,
      serviceEnv: serviceState.env,
    };
  }

  const blockMessage = gatewayRuntimeAncestryBlockMessage(serviceState.runtime);
  if (blockMessage) {
    return {
      stopped: false,
      inspected: true,
      runtimeInspected: true,
      running: true,
      blockMessage,
      serviceEnv: serviceState.env,
    };
  }

  if (!params.jsonMode) {
    defaultRuntime.log(theme.muted("Stopping managed gateway service before package update..."));
  }
  await service.stop({ env: serviceState.env, stdout: process.stdout });
  return {
    stopped: true,
    inspected: true,
    runtimeInspected: true,
    running: true,
    serviceEnv: serviceState.env,
  };
}

async function maybeRestartServiceAfterFailedPackageUpdate(params: {
  prePackageServiceStop: PrePackageServiceStop | undefined;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.prePackageServiceStop?.stopped || !params.prePackageServiceStop.serviceEnv) {
    return;
  }
  try {
    await resolveGatewayService().restart({
      env: params.prePackageServiceStop.serviceEnv,
      stdout: process.stdout,
    });
    if (!params.jsonMode) {
      defaultRuntime.log(theme.muted("Restarted managed gateway service after failed update."));
    }
  } catch (err) {
    const message = `Failed to restart managed gateway service after failed update: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

function isRunningInsideGatewayService(
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (env.OPENCLAW_SERVICE_MARKER?.trim() !== GATEWAY_SERVICE_MARKER) {
    return false;
  }
  const serviceKind = env.OPENCLAW_SERVICE_KIND?.trim();
  return !serviceKind || serviceKind === GATEWAY_SERVICE_KIND;
}

function shouldBlockPackageUpdateFromGatewayServiceEnv(params: {
  prePackageServiceStop: PrePackageServiceStop | undefined;
}): boolean {
  if (!isRunningInsideGatewayService()) {
    return false;
  }
  const stopState = params.prePackageServiceStop;
  if (!stopState?.inspected) {
    return true;
  }
  if (stopState.stopped) {
    return false;
  }
  if (!stopState.runtimeInspected) {
    return true;
  }
  return stopState.running;
}

function formatCommandFailure(stdout: string, stderr: string): string {
  const detail = (stderr || stdout).trim();
  if (!detail) {
    return "command returned a non-zero exit code";
  }
  return detail.split("\n").slice(-3).join("\n");
}

function tryResolveInvocationCwd(): string | undefined {
  try {
    return process.cwd();
  } catch {
    return undefined;
  }
}

async function resolvePackageRuntimePreflightError(params: {
  tag: string;
  timeoutMs?: number;
}): Promise<string | null> {
  if (!canResolveRegistryVersionForPackageTarget(params.tag)) {
    return null;
  }
  const target = params.tag.trim();
  if (!target) {
    return null;
  }
  const status = await fetchNpmPackageTargetStatus({
    target,
    timeoutMs: params.timeoutMs,
  });
  if (status.error) {
    return null;
  }
  const satisfies = nodeVersionSatisfiesEngine(process.versions.node ?? null, status.nodeEngine);
  if (satisfies !== false) {
    return null;
  }
  const targetLabel = status.version ?? target;
  return [
    `Node ${process.versions.node ?? "unknown"} is too old for openclaw@${targetLabel}.`,
    `The requested package requires ${status.nodeEngine}.`,
    "Upgrade Node to 22.16+ or Node 24, then rerun `openclaw update`.",
    "Bare `npm i -g openclaw` can silently install an older compatible release.",
    "After upgrading Node, use `npm i -g openclaw@latest`.",
  ].join("\n");
}

function resolveServiceRefreshEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  const resolvedEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of SERVICE_REFRESH_PATH_ENV_KEYS) {
    const rawValue = resolvedEnv[key]?.trim();
    if (!rawValue) {
      continue;
    }
    if (rawValue.startsWith("~") || path.isAbsolute(rawValue) || path.win32.isAbsolute(rawValue)) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    if (!invocationCwd) {
      resolvedEnv[key] = rawValue;
      continue;
    }
    resolvedEnv[key] = path.resolve(invocationCwd, rawValue);
  }
  return resolvedEnv;
}

function disableUpdatedPackageCompileCacheEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...env,
    NODE_DISABLE_COMPILE_CACHE: "1",
  };
}

function stripGatewayServiceMarkerEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const resolvedEnv = { ...env };
  delete resolvedEnv.OPENCLAW_SERVICE_MARKER;
  delete resolvedEnv.OPENCLAW_SERVICE_KIND;
  return resolvedEnv;
}

function resolveUpdatedInstallCommandEnv(
  env: NodeJS.ProcessEnv,
  invocationCwd?: string,
): NodeJS.ProcessEnv {
  return disableUpdatedPackageCompileCacheEnv(resolveServiceRefreshEnv(env, invocationCwd));
}

export function resolvePostInstallDoctorEnv(params?: {
  baseEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): NodeJS.ProcessEnv {
  const resolvedEnv = disableUpdatedPackageCompileCacheEnv(params?.baseEnv ?? process.env);
  if (!params?.serviceEnv) {
    return resolvedEnv;
  }

  const serviceEnv = resolveServiceRefreshEnv(params.serviceEnv, params.invocationCwd);
  for (const key of POST_INSTALL_DOCTOR_SERVICE_ENV_KEYS) {
    const value = serviceEnv[key]?.trim();
    if (value) {
      resolvedEnv[key] = serviceEnv[key];
    }
  }
  return resolvedEnv;
}

export function resolveUpdatedGatewayRestartPort(params: {
  config?: OpenClawConfig;
  processEnv?: NodeJS.ProcessEnv;
  serviceEnv?: NodeJS.ProcessEnv;
}): number {
  return resolveGatewayPort(params.config, params.serviceEnv ?? params.processEnv ?? process.env);
}

type UpdateDryRunPreview = {
  dryRun: true;
  root: string;
  installKind: "git" | "package" | "unknown";
  mode: UpdateRunResult["mode"];
  updateInstallKind: "git" | "package" | "unknown";
  switchToGit: boolean;
  switchToPackage: boolean;
  restart: boolean;
  requestedChannel: "stable" | "beta" | "dev" | null;
  storedChannel: "stable" | "beta" | "dev" | null;
  effectiveChannel: "stable" | "beta" | "dev";
  tag: string;
  currentVersion: string | null;
  targetVersion: string | null;
  downgradeRisk: boolean;
  actions: string[];
  notes: string[];
};

function printDryRunPreview(preview: UpdateDryRunPreview, jsonMode: boolean): void {
  if (jsonMode) {
    defaultRuntime.writeJson(preview);
    return;
  }

  defaultRuntime.log(theme.heading("Update dry-run"));
  defaultRuntime.log(theme.muted("No changes were applied."));
  defaultRuntime.log("");
  defaultRuntime.log(`  Root: ${theme.muted(preview.root)}`);
  defaultRuntime.log(`  Install kind: ${theme.muted(preview.installKind)}`);
  defaultRuntime.log(`  Mode: ${theme.muted(preview.mode)}`);
  defaultRuntime.log(`  Channel: ${theme.muted(preview.effectiveChannel)}`);
  defaultRuntime.log(`  Tag/spec: ${theme.muted(preview.tag)}`);
  if (preview.currentVersion) {
    defaultRuntime.log(`  Current version: ${theme.muted(preview.currentVersion)}`);
  }
  if (preview.targetVersion) {
    defaultRuntime.log(`  Target version: ${theme.muted(preview.targetVersion)}`);
  }
  if (preview.downgradeRisk) {
    defaultRuntime.log(theme.warn("  Downgrade confirmation would be required in a real run."));
  }

  defaultRuntime.log("");
  defaultRuntime.log(theme.heading("Planned actions:"));
  for (const action of preview.actions) {
    defaultRuntime.log(`  - ${action}`);
  }

  if (preview.notes.length > 0) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Notes:"));
    for (const note of preview.notes) {
      defaultRuntime.log(`  - ${theme.muted(note)}`);
    }
  }
}

async function refreshGatewayServiceEnv(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const args = ["gateway", "install", "--force"];
  if (params.jsonMode) {
    args.push("--json");
  }

  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (entrypoint) {
    const res = await runCommandWithTimeout([resolveNodeRunner(), entrypoint, ...args], {
      cwd: params.result.root,
      env: resolveUpdatedInstallCommandEnv(params.env ?? process.env, params.invocationCwd),
      timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
    });
    if (res.code === 0) {
      return;
    }
    throw new Error(
      `updated install refresh failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
    );
  }

  if (isPackageManagerUpdateMode(params.result.mode)) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  await runDaemonInstall({ force: true, json: params.jsonMode || undefined });
}

async function runUpdatedInstallGatewayRestart(params: {
  result: UpdateRunResult;
  jsonMode: boolean;
  invocationCwd?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<boolean> {
  const entrypoint = await resolveGatewayInstallEntrypoint(params.result.root);
  if (!entrypoint) {
    throw new Error(
      `updated install entrypoint not found under ${params.result.root ?? "unknown"}`,
    );
  }

  const args = ["gateway", "restart"];
  if (params.jsonMode) {
    args.push("--json");
  }
  const res = await runCommandWithTimeout([resolveNodeRunner(), entrypoint, ...args], {
    cwd: params.result.root,
    env: resolveUpdatedInstallCommandEnv(params.env ?? process.env, params.invocationCwd),
    timeoutMs: SERVICE_REFRESH_TIMEOUT_MS,
  });
  if (res.code === 0) {
    return true;
  }
  throw new Error(
    `updated install restart failed (${entrypoint}): ${formatCommandFailure(res.stdout, res.stderr)}`,
  );
}

async function tryInstallShellCompletion(opts: {
  jsonMode: boolean;
  skipPrompt: boolean;
}): Promise<void> {
  if (opts.jsonMode || !process.stdin.isTTY) {
    return;
  }

  const status = await checkShellCompletionStatus(CLI_NAME);

  if (status.usesSlowPattern) {
    defaultRuntime.log(theme.muted("Upgrading shell completion to cached version..."));
    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (cacheGenerated) {
      await installCompletion(status.shell, true, CLI_NAME);
    }
    return;
  }

  if (status.profileInstalled && !status.cacheExists) {
    defaultRuntime.log(theme.muted("Regenerating shell completion cache..."));
    await ensureCompletionCacheExists(CLI_NAME);
    return;
  }

  if (!status.profileInstalled) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Shell completion"));

    const shouldInstall = await confirm({
      message: stylePromptMessage(`Enable ${status.shell} shell completion for ${CLI_NAME}?`),
      initialValue: true,
    });

    if (isCancel(shouldInstall) || !shouldInstall) {
      if (!opts.skipPrompt) {
        defaultRuntime.log(
          theme.muted(
            `Skipped. Run \`${replaceCliName(formatCliCommand("openclaw completion --install"), CLI_NAME)}\` later to enable.`,
          ),
        );
      }
      return;
    }

    const cacheGenerated = await ensureCompletionCacheExists(CLI_NAME);
    if (!cacheGenerated) {
      defaultRuntime.log(theme.warn("Failed to generate completion cache."));
      return;
    }

    await installCompletion(status.shell, opts.skipPrompt, CLI_NAME);
  }
}

async function runPackageInstallUpdate(params: {
  root: string;
  installKind: "git" | "package" | "unknown";
  tag: string;
  timeoutMs: number;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  jsonMode: boolean;
  managedServiceEnv?: NodeJS.ProcessEnv;
  invocationCwd?: string;
}): Promise<UpdateRunResult> {
  const manager = await resolveGlobalManager({
    root: params.root,
    installKind: params.installKind,
    timeoutMs: params.timeoutMs,
  });
  const installEnv = await createGlobalInstallEnv();
  const runCommand = createGlobalCommandRunner();
  const installTarget = await resolveGlobalInstallTarget({
    manager,
    runCommand,
    timeoutMs: params.timeoutMs,
    pkgRoot: params.root,
  });
  const pkgRoot = installTarget.packageRoot;
  const packageName =
    (pkgRoot ? await readPackageName(pkgRoot) : await readPackageName(params.root)) ??
    DEFAULT_PACKAGE_NAME;
  const installSpec = resolveGlobalInstallSpec({
    packageName,
    tag: params.tag,
    env: installEnv,
  });

  const beforeVersion = pkgRoot ? await readPackageVersion(pkgRoot) : null;
  if (pkgRoot) {
    await cleanupGlobalRenameDirs({
      globalRoot: path.dirname(pkgRoot),
      packageName,
    });
  }

  const diskWarning = createLowDiskSpaceWarning({
    targetPath: pkgRoot ? path.dirname(pkgRoot) : params.root,
    purpose: "global package update",
  });
  if (diskWarning) {
    if (params.jsonMode) {
      defaultRuntime.error(`Warning: ${diskWarning}`);
    } else {
      defaultRuntime.log(theme.warn(diskWarning));
    }
  }

  const packageUpdate = await runGlobalPackageUpdateSteps({
    installTarget,
    installSpec,
    packageName,
    packageRoot: pkgRoot,
    runCommand,
    timeoutMs: params.timeoutMs,
    ...(installEnv === undefined ? {} : { env: installEnv }),
    runStep: (stepParams) =>
      runUpdateStep({
        ...stepParams,
        progress: params.progress,
      }),
    postVerifyStep: async (verifiedPackageRoot) => {
      const entryPath = await resolveGatewayInstallEntrypoint(verifiedPackageRoot);
      if (entryPath) {
        await createUpdateConfigSnapshot();
        return await runUpdateStep({
          name: `${CLI_NAME} doctor`,
          argv: [resolveNodeRunner(), entryPath, "doctor", "--non-interactive", "--fix"],
          cwd: verifiedPackageRoot,
          env: {
            ...resolvePostInstallDoctorEnv({
              serviceEnv: params.managedServiceEnv,
              invocationCwd: params.invocationCwd,
            }),
            OPENCLAW_UPDATE_IN_PROGRESS: "1",
            [UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV]: "1",
            [UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV]: "1",
          },
          timeoutMs: params.timeoutMs,
          progress: params.progress,
        });
      }
      return null;
    },
  });

  return {
    status: packageUpdate.failedStep ? "error" : "ok",
    mode: manager,
    root: packageUpdate.verifiedPackageRoot ?? params.root,
    reason: packageUpdate.failedStep ? packageUpdate.failedStep.name : undefined,
    before: { version: beforeVersion },
    after: { version: packageUpdate.afterVersion ?? beforeVersion },
    steps: packageUpdate.steps,
    durationMs: Date.now() - params.startedAt,
  };
}

async function runGitUpdate(params: {
  root: string;
  switchToGit: boolean;
  installKind: "git" | "package" | "unknown";
  timeoutMs: number | undefined;
  startedAt: number;
  progress: ReturnType<typeof createUpdateProgress>["progress"];
  channel: "stable" | "beta" | "dev";
  tag: string;
  showProgress: boolean;
  opts: UpdateCommandOptions;
  stop: () => void;
  devTargetRef?: string;
}): Promise<UpdateRunResult> {
  const updateRoot = params.switchToGit ? resolveGitInstallDir() : params.root;
  const effectiveTimeout = params.timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;
  const installEnv = await createGlobalInstallEnv();

  const cloneStep = params.switchToGit
    ? await ensureGitCheckout({
        dir: updateRoot,
        env: installEnv,
        timeoutMs: effectiveTimeout,
        progress: params.progress,
      })
    : null;

  if (cloneStep && cloneStep.exitCode !== 0) {
    const result: UpdateRunResult = {
      status: "error",
      mode: "git",
      root: updateRoot,
      reason: cloneStep.name,
      steps: [cloneStep],
      durationMs: Date.now() - params.startedAt,
    };
    params.stop();
    printResult(result, { ...params.opts, hideSteps: params.showProgress });
    defaultRuntime.exit(1);
    return result;
  }

  const updateResult = await runGatewayUpdate({
    cwd: updateRoot,
    argv1: params.switchToGit ? undefined : process.argv[1],
    timeoutMs: params.timeoutMs,
    progress: params.progress,
    channel: params.channel,
    tag: params.tag,
    devTargetRef: params.devTargetRef,
    deferConfiguredPluginInstallRepair: true,
  });
  const steps = [...(cloneStep ? [cloneStep] : []), ...updateResult.steps];

  if (params.switchToGit && updateResult.status === "ok") {
    const manager = await resolveGlobalManager({
      root: params.root,
      installKind: params.installKind,
      timeoutMs: effectiveTimeout,
    });
    const runCommand = createGlobalCommandRunner();
    const installTarget = await resolveGlobalInstallTarget({
      manager,
      runCommand,
      timeoutMs: effectiveTimeout,
      pkgRoot: params.root,
    });
    const installLocation =
      installTarget.manager === "pnpm"
        ? resolvePnpmGlobalDirFromGlobalRoot(installTarget.globalRoot)
        : null;
    const installStep = await runUpdateStep({
      name: "global install",
      argv: globalInstallArgs(installTarget, updateRoot, undefined, installLocation),
      cwd: updateRoot,
      env: installEnv,
      timeoutMs: effectiveTimeout,
      progress: params.progress,
    });
    steps.push(installStep);

    const failedStep = installStep.exitCode !== 0 ? installStep : null;
    return {
      ...updateResult,
      status: updateResult.status === "ok" && !failedStep ? "ok" : "error",
      steps,
      durationMs: Date.now() - params.startedAt,
    };
  }

  return {
    ...updateResult,
    steps,
    durationMs: Date.now() - params.startedAt,
  };
}

export async function updatePluginsAfterCoreUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
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

  const pluginLogger = params.opts.json
    ? {}
    : {
        info: (msg: string) => defaultRuntime.log(msg),
        warn: (msg: string) => defaultRuntime.log(theme.warn(msg)),
        error: (msg: string) => defaultRuntime.log(theme.error(msg)),
      };

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.heading("Updating plugins..."));
  }

  const warnings: PostUpdatePluginWarning[] = [];
  const pluginInstallRecords =
    params.pluginInstallRecords ?? (await loadInstalledPluginIndexInstallRecords());
  const syncConfig = withPluginInstallRecords(
    params.configSnapshot.sourceConfig,
    pluginInstallRecords,
  );
  const syncResult = await syncPluginsForUpdateChannel({
    config: syncConfig,
    channel: params.channel,
    workspaceDir: params.root,
    externalizedBundledPluginBridges: await listPersistedBundledPluginLocationBridges({
      workspaceDir: params.root,
    }),
    logger: pluginLogger,
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
      updateChannel: params.channel,
      skipDisabledPlugins: true,
      syncOfficialPluginInstalls: true,
      disableOnFailure: true,
      logger: pluginLogger,
      onIntegrityDrift: onPluginIntegrityDrift,
    });
    pluginConfig = repairResult.config;
    pluginsChanged ||= repairResult.changed;
    npmPluginsChanged ||= repairResult.changed;
    pluginUpdateOutcomes.push(...repairResult.outcomes);
    return missingIds;
  };

  const missingPayloadIds = await collectMissingPayloadWarnings(pluginInstallRecords);

  const npmResult = await updateNpmInstalledPlugins({
    config: pluginConfig,
    timeoutMs: params.timeoutMs,
    updateChannel: params.channel,
    skipIds: new Set([...syncResult.summary.switchedToNpm, ...missingPayloadIds]),
    skipDisabledPlugins: true,
    syncOfficialPluginInstalls: true,
    disableOnFailure: true,
    logger: pluginLogger,
    onIntegrityDrift: onPluginIntegrityDrift,
  });
  pluginConfig = npmResult.config;
  pluginsChanged ||= npmResult.changed;
  npmPluginsChanged ||= npmResult.changed;
  for (const rawOutcome of npmResult.outcomes) {
    const guided = createGuidedPostUpdatePluginOutcome(rawOutcome);
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
      .filter((entry) => !missingPayloadIds.includes(entry.pluginId))
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
    baselineInstallRecords: convergenceBaselineRecords,
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
    await commitPluginInstallRecordsWithConfig({
      previousInstallRecords: pluginInstallRecords,
      nextInstallRecords,
      nextConfig,
      baseHash: params.configSnapshot.hash,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: nextConfig,
      reason: "source-changed",
      workspaceDir: params.root,
      installRecords: nextInstallRecords,
      logger: pluginLogger,
    });
  }

  if (params.opts.json) {
    return {
      status: convergenceErrored ? "error" : warnings.length > 0 ? "warning" : "ok",
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
    defaultRuntime.log(theme.warn(warning));
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

  for (const outcome of pluginUpdateOutcomes) {
    if (outcome.status !== "error") {
      continue;
    }
    defaultRuntime.log(theme.warn(outcome.message));
  }

  return {
    status: convergenceErrored ? "error" : warnings.length > 0 ? "warning" : "ok",
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
}

async function maybeRestartService(params: {
  shouldRestart: boolean;
  result: UpdateRunResult;
  opts: UpdateCommandOptions;
  refreshServiceEnv: boolean;
  serviceEnv?: NodeJS.ProcessEnv;
  gatewayPort: number;
  restartScriptPath?: string | null;
  invocationCwd?: string;
}): Promise<boolean> {
  const verifyRestartedGateway = async (expectedGatewayVersion: string | undefined) => {
    const restartAfterStaleCleanup = async () => {
      if (params.refreshServiceEnv && isPackageManagerUpdateMode(params.result.mode)) {
        await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
        });
        return;
      }
      if (shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode })) {
        await runDaemonRestart();
      }
    };
    const service = resolveGatewayService();
    let health = await waitForGatewayHealthyRestart({
      service,
      port: params.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      env: params.serviceEnv,
    });
    if (!health.healthy && health.staleGatewayPids.length > 0) {
      if (!params.opts.json) {
        defaultRuntime.log(
          theme.warn(
            `Found stale gateway process(es) after restart: ${health.staleGatewayPids.join(", ")}. Cleaning up...`,
          ),
        );
      }
      await terminateStaleGatewayPids(health.staleGatewayPids);
      await restartAfterStaleCleanup();
      health = await waitForGatewayHealthyRestart({
        service,
        port: params.gatewayPort,
        expectedVersion: expectedGatewayVersion,
        env: params.serviceEnv,
      });
    }

    const recoveryVerification = await recoverLaunchAgentAndRecheckGatewayHealth({
      health,
      service,
      port: params.gatewayPort,
      expectedVersion: expectedGatewayVersion,
      env: params.serviceEnv,
    });
    health = recoveryVerification.health;
    const launchAgentRecovery = recoveryVerification.launchAgentRecovery;
    if (launchAgentRecovery?.attempted) {
      if (!params.opts.json) {
        defaultRuntime.log(
          launchAgentRecovery.recovered
            ? theme.warn(launchAgentRecovery.message)
            : theme.warn(launchAgentRecovery.detail),
        );
      } else {
        defaultRuntime.error(
          launchAgentRecovery.recovered ? launchAgentRecovery.message : launchAgentRecovery.detail,
        );
      }
    }

    if (health.healthy) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.success("Gateway: restarted and verified."));
      }
      return true;
    }

    const diagnosticLines = [
      "Gateway did not become healthy after restart.",
      ...renderRestartDiagnostics(health),
      ...(launchAgentRecovery?.attempted
        ? [
            launchAgentRecovery.recovered
              ? `LaunchAgent recovery: ${launchAgentRecovery.message}`
              : `LaunchAgent recovery failed: ${launchAgentRecovery.detail}`,
          ]
        : []),
      `Restart log: ${resolveGatewayRestartLogPath(params.serviceEnv ?? process.env)}`,
      `Run \`${replaceCliName(formatCliCommand("openclaw gateway status --deep"), CLI_NAME)}\` for details.`,
      ...formatPostUpdateGatewayRecoveryInstructions(params.result),
    ];
    if (params.opts.json) {
      defaultRuntime.error(diagnosticLines.join("\n"));
    } else {
      defaultRuntime.log(theme.warn(diagnosticLines[0] ?? "Gateway did not become healthy."));
      for (const line of diagnosticLines.slice(1)) {
        defaultRuntime.log(theme.muted(line));
      }
    }

    if (isPackageManagerUpdateMode(params.result.mode)) {
      return false;
    }

    return !(health.versionMismatch || health.activatedPluginErrors?.length);
  };

  if (params.shouldRestart) {
    if (!params.opts.json) {
      defaultRuntime.log("");
      defaultRuntime.log(theme.heading("Restarting service..."));
    }

    try {
      const expectedGatewayVersion = isPackageManagerUpdateMode(params.result.mode)
        ? normalizeOptionalString(params.result.after?.version)
        : undefined;
      const isPackageUpdate = isPackageManagerUpdateMode(params.result.mode);
      let restarted = false;
      let restartInitiated = false;
      let refreshedGatewayAlreadyHealthy = false;
      if (params.refreshServiceEnv) {
        try {
          await refreshGatewayServiceEnv({
            result: params.result,
            jsonMode: Boolean(params.opts.json),
            invocationCwd: params.invocationCwd,
            env: params.serviceEnv,
          });
        } catch (err) {
          // Always log the refresh failure so callers can detect it (issue #56772).
          // Previously this was silently suppressed in --json mode, hiding the root
          // cause and preventing auto-update callers from detecting the failure.
          const message = `Failed to refresh gateway service environment from updated install: ${String(err)}`;
          if (params.opts.json) {
            defaultRuntime.error(message);
          } else {
            defaultRuntime.log(theme.warn(message));
          }
          if (isPackageUpdate) {
            return false;
          }
        }
        if (isPackageUpdate && expectedGatewayVersion) {
          const health = await waitForGatewayHealthyRestart({
            service: resolveGatewayService(),
            port: params.gatewayPort,
            expectedVersion: expectedGatewayVersion,
            env: params.serviceEnv,
            attempts: POST_REFRESH_ALREADY_HEALTHY_ATTEMPTS,
            delayMs: POST_REFRESH_ALREADY_HEALTHY_DELAY_MS,
          });
          refreshedGatewayAlreadyHealthy = health.healthy;
          if (refreshedGatewayAlreadyHealthy && !params.opts.json) {
            defaultRuntime.log(
              theme.muted(
                "Gateway already reports the updated version after service refresh; skipped redundant restart.",
              ),
            );
          }
        }
      }
      // Service refresh can bootstrap a RunAtLoad LaunchAgent directly. When
      // that already produced the expected gateway version, a second kickstart
      // would only race the healthy supervisor-owned process.
      if (!refreshedGatewayAlreadyHealthy && params.restartScriptPath) {
        await createUpdateConfigSnapshot();
        await runRestartScript(params.restartScriptPath);
        restartInitiated = true;
      } else if (!refreshedGatewayAlreadyHealthy && params.refreshServiceEnv && isPackageUpdate) {
        await createUpdateConfigSnapshot();
        restarted = await runUpdatedInstallGatewayRestart({
          result: params.result,
          jsonMode: Boolean(params.opts.json),
          invocationCwd: params.invocationCwd,
          env: params.serviceEnv,
        });
      } else if (
        !refreshedGatewayAlreadyHealthy &&
        shouldUseLegacyProcessRestartAfterUpdate({ updateMode: params.result.mode })
      ) {
        await createUpdateConfigSnapshot();
        restarted = await runDaemonRestart();
      } else if (!refreshedGatewayAlreadyHealthy && !params.opts.json) {
        defaultRuntime.log(theme.muted("Gateway: restart skipped (no installed service found)."));
      }

      const shouldVerifyRestart =
        refreshedGatewayAlreadyHealthy ||
        restartInitiated ||
        (restarted && expectedGatewayVersion !== undefined);
      if (shouldVerifyRestart) {
        const restartHealthy = await verifyRestartedGateway(expectedGatewayVersion);
        if (!restartHealthy) {
          if (!params.opts.json) {
            defaultRuntime.log("");
          }
          return false;
        }
        if (!params.opts.json && restartInitiated) {
          defaultRuntime.log(theme.success("Daemon restart completed."));
          defaultRuntime.log("");
        }
      }

      if (!params.opts.json && restarted) {
        defaultRuntime.log(theme.success("Daemon restarted successfully."));
        defaultRuntime.log("");
        await createUpdateConfigSnapshot();
        process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
        process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
        try {
          const interactiveDoctor =
            process.stdin.isTTY && !params.opts.json && params.opts.yes !== true;
          await doctorCommand(defaultRuntime, {
            nonInteractive: !interactiveDoctor,
          });
        } catch (err) {
          defaultRuntime.log(theme.warn(`Doctor failed: ${String(err)}`));
        } finally {
          delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
          delete process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
        }
      }
    } catch (err) {
      if (!params.opts.json) {
        defaultRuntime.log(theme.warn(`Gateway: restart failed: ${String(err)}`));
        defaultRuntime.log(
          theme.muted(
            `You may need to restart the service manually: ${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}`,
          ),
        );
      }
      if (isPackageManagerUpdateMode(params.result.mode)) {
        return false;
      }
    }
    return true;
  }

  if (!params.opts.json) {
    defaultRuntime.log("");
    defaultRuntime.log(theme.muted("Gateway: restart skipped (--no-restart)."));
    if (params.result.mode === "npm" || params.result.mode === "pnpm") {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\`, then \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    } else {
      defaultRuntime.log(
        theme.muted(
          `Tip: Run \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\` to apply updates to a running gateway.`,
        ),
      );
    }
  }
  return true;
}

async function runPostCorePluginUpdate(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  configChanged?: boolean;
  restoredAuthoredChannels?: unknown;
  opts: UpdateCommandOptions;
  timeoutMs: number;
  pluginInstallRecords?: Record<string, PluginInstallRecord>;
}): Promise<PostCorePluginUpdateResult> {
  return await updatePluginsAfterCoreUpdate({
    root: params.root,
    channel: params.channel,
    configSnapshot: params.configSnapshot,
    configChanged: params.configChanged,
    restoredAuthoredChannels: params.restoredAuthoredChannels,
    opts: params.opts,
    timeoutMs: params.timeoutMs,
    pluginInstallRecords: params.pluginInstallRecords,
  });
}

type UpdateFinalizeResult = {
  status: "ok" | "warning" | "error";
  mode: "finalize";
  root: string;
  channel: "stable" | "beta" | "dev";
  restart: false;
  postUpdate: {
    doctor: {
      status: "ok";
    };
    plugins: PostCorePluginUpdateResult;
  };
};

function withUpdateFinalizationEnv<T>(run: () => Promise<T>): Promise<T> {
  const previousUpdateInProgress = process.env.OPENCLAW_UPDATE_IN_PROGRESS;
  const previousDeferConfiguredPluginInstallRepair =
    process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV];
  const previousParentSupportsDoctorConfigWrite =
    process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
  process.env.OPENCLAW_UPDATE_IN_PROGRESS = "1";
  process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] = "1";
  process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] = "1";
  return run().finally(() => {
    if (previousUpdateInProgress === undefined) {
      delete process.env.OPENCLAW_UPDATE_IN_PROGRESS;
    } else {
      process.env.OPENCLAW_UPDATE_IN_PROGRESS = previousUpdateInProgress;
    }
    if (previousDeferConfiguredPluginInstallRepair === undefined) {
      delete process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV];
    } else {
      process.env[UPDATE_DEFER_CONFIGURED_PLUGIN_INSTALL_REPAIR_ENV] =
        previousDeferConfiguredPluginInstallRepair;
    }
    if (previousParentSupportsDoctorConfigWrite === undefined) {
      delete process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV];
    } else {
      process.env[UPDATE_PARENT_SUPPORTS_DOCTOR_CONFIG_WRITE_ENV] =
        previousParentSupportsDoctorConfigWrite;
    }
  });
}

export async function updateFinalizeCommand(opts: UpdateFinalizeOptions): Promise<void> {
  suppressDeprecations();
  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  if (timeoutMs === null) {
    return;
  }
  assertConfigWriteAllowedInCurrentMode();

  const root = await resolveUpdateRoot();
  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
  const preFinalizeConfig = configSnapshot.valid
    ? {
        sourceConfig: configSnapshot.sourceConfig,
        authoredConfig: isRecord(configSnapshot.parsed)
          ? (configSnapshot.parsed as OpenClawConfig)
          : configSnapshot.sourceConfig,
      }
    : undefined;
  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }
  const storedChannel = configSnapshot.valid
    ? normalizeUpdateChannel(configSnapshot.config.update?.channel)
    : null;
  const channel = requestedChannel ?? storedChannel ?? DEFAULT_PACKAGE_CHANNEL;
  if (requestedChannel) {
    configSnapshot = await persistRequestedUpdateChannel({
      configSnapshot,
      requestedChannel,
    });
  }

  const pluginUpdate = await withUpdateFinalizationEnv(async () => {
    await createUpdateConfigSnapshot();
    await doctorCommand(defaultRuntime, {
      nonInteractive: true,
      repair: true,
      yes: opts.yes === true,
    });
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
      requestedChannel ?? postDoctorStoredChannel ?? storedChannel ?? DEFAULT_PACKAGE_CHANNEL;
    const pluginInstallRecords = await loadInstalledPluginIndexInstallRecords();
    return await runPostCorePluginUpdate({
      root,
      channel: postDoctorChannel,
      configSnapshot,
      configChanged: restoredConfig.changed,
      restoredAuthoredChannels: restoredConfig.authoredChannels,
      opts: {
        json: opts.json,
        timeout: opts.timeout,
        yes: opts.yes,
        restart: false,
      },
      timeoutMs: timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS,
      pluginInstallRecords,
    });
  });

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
    postUpdate: {
      doctor: {
        status: "ok",
      },
      plugins: pluginUpdate,
    },
  };

  await tryWriteCompletionCache(root, Boolean(opts.json));
  if (opts.json) {
    defaultRuntime.writeJson(result);
  } else if (result.status === "ok") {
    defaultRuntime.log(theme.muted("Update finalization completed."));
  }
  if (result.status === "error") {
    defaultRuntime.exit(1);
  }
}

async function persistRequestedUpdateChannel(params: {
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  requestedChannel: "stable" | "beta" | "dev" | null;
}): Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> {
  if (!params.requestedChannel || !params.configSnapshot.valid) {
    return params.configSnapshot;
  }
  const storedChannel = normalizeUpdateChannel(params.configSnapshot.config.update?.channel);
  if (params.requestedChannel === storedChannel) {
    return params.configSnapshot;
  }
  const requestedChannel = params.requestedChannel;

  const mutation = await mutateConfigFileWithRetry({
    writeOptions: { skipPluginValidation: true },
    mutate: (draft) => {
      draft.update = {
        ...draft.update,
        channel: requestedChannel,
      };
    },
  });
  return createUpdatedConfigSnapshot(mutation.snapshot, mutation.nextConfig);
}

function createUpdatedConfigSnapshot(
  snapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>,
  next: OpenClawConfig,
): Awaited<ReturnType<typeof readConfigFileSnapshot>> {
  if (!snapshot.valid) {
    return snapshot;
  }
  return {
    ...snapshot,
    hash: undefined,
    parsed: next,
    sourceConfig: asResolvedSourceConfig(next),
    resolved: asResolvedSourceConfig(next),
    runtimeConfig: asRuntimeConfig(next),
    config: asRuntimeConfig(next),
  };
}

async function maybeRepairLegacyConfigForUpdateChannel(params: {
  configSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  jsonMode: boolean;
}): Promise<Awaited<ReturnType<typeof readConfigFileSnapshot>>> {
  if (params.configSnapshot.valid || params.configSnapshot.legacyIssues.length === 0) {
    return params.configSnapshot;
  }

  const { repairLegacyConfigForUpdateChannel } =
    await import("../../commands/doctor/legacy-config-repair.js");
  const { snapshot, repaired } = await repairLegacyConfigForUpdateChannel(params);
  if (!params.jsonMode && repaired) {
    defaultRuntime.log(theme.muted("Migrated legacy config before changing update channel."));
  }
  return snapshot;
}

async function writePostCorePluginUpdateResultFile(
  filePath: string | undefined,
  result: PostCorePluginUpdateResult,
): Promise<void> {
  if (!filePath) {
    return;
  }
  await writeJson(filePath, result, { trailingNewline: true });
}

async function writePostCorePluginInstallRecordsFile(
  filePath: string,
  records: Record<string, PluginInstallRecord>,
): Promise<void> {
  await fs.writeFile(filePath, `${JSON.stringify(records)}\n`, "utf-8");
}

async function writePostCoreSourceConfigFile(
  filePath: string,
  preUpdateConfig: PreUpdateConfigRestoreInput | undefined,
): Promise<void> {
  if (!preUpdateConfig) {
    return;
  }
  await fs.writeFile(filePath, `${JSON.stringify(preUpdateConfig)}\n`, "utf-8");
}

async function readPostCorePluginInstallRecordsFile(
  filePath: string | undefined,
): Promise<Record<string, PluginInstallRecord> | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8")) as unknown;
    return normalizePluginInstallRecordMap(parsed);
  } catch {
    return undefined;
  }
}

async function readPostCoreSourceConfigFile(
  filePath: string | undefined,
  options?: { configPath?: string },
): Promise<PreUpdateConfigRestoreInput | undefined> {
  if (!filePath) {
    return undefined;
  }
  try {
    const parsed = parseConfigJson5(await fs.readFile(filePath, "utf-8"));
    if (!parsed.ok || !isRecord(parsed.parsed)) {
      return undefined;
    }
    return normalizePreUpdateConfigRestoreInput(parsed.parsed, options);
  } catch {
    return undefined;
  }
}

function normalizePreUpdateConfigRestoreInput(
  parsed: Record<string, unknown>,
  options?: { configPath?: string },
): PreUpdateConfigRestoreInput | undefined {
  const sourceConfig = parsed.sourceConfig;
  const authoredConfig = parsed.authoredConfig;
  if (isRecord(sourceConfig) && isRecord(authoredConfig)) {
    return {
      sourceConfig: sourceConfig as OpenClawConfig,
      authoredConfig: authoredConfig as OpenClawConfig,
    };
  }
  const authored = parsed as OpenClawConfig;
  return {
    sourceConfig: options?.configPath
      ? resolvePreUpdateSourceConfigFromAuthored(authored, options.configPath)
      : authored,
    authoredConfig: authored,
  };
}

function resolvePreUpdateSourceConfigFromAuthored(
  authoredConfig: OpenClawConfig,
  configPath: string,
): OpenClawConfig {
  try {
    const withIncludes = resolveConfigIncludes(authoredConfig, configPath, undefined, {
      allowedRoots: resolveIncludeRoots(process.env),
    });
    const resolved = resolveConfigEnvVars(withIncludes, process.env, {
      onMissing: () => undefined,
    });
    return isRecord(resolved) ? (resolved as OpenClawConfig) : authoredConfig;
  } catch {
    return authoredConfig;
  }
}

async function isFreshPreUpdateConfigSnapshot(params: {
  currentConfigPath: string;
  snapshotPath: string;
  updateStartedAtMs?: number;
}): Promise<boolean> {
  const snapshotStat = await fs.stat(params.snapshotPath).catch(() => null);
  if (!snapshotStat) {
    return false;
  }
  if (
    params.updateStartedAtMs !== undefined &&
    snapshotStat.mtimeMs + 1000 < params.updateStartedAtMs
  ) {
    return false;
  }
  if (Date.now() - snapshotStat.mtimeMs > PRE_UPDATE_CONFIG_SNAPSHOT_MAX_AGE_MS) {
    return false;
  }
  const currentStat = await fs.stat(params.currentConfigPath).catch(() => null);
  return !currentStat || snapshotStat.mtimeMs <= currentStat.mtimeMs + 1000;
}

async function execFileStdout(file: string, args: string[]): Promise<string | undefined> {
  return await new Promise((resolve) => {
    execFile(file, args, { timeout: 1000, windowsHide: true }, (error, stdout) => {
      resolve(error ? undefined : stdout);
    });
  });
}

async function readProcessStartTimeMs(pid: number): Promise<number | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) {
    return undefined;
  }
  const raw =
    process.platform === "win32"
      ? await execFileStdout("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `[Console]::Out.Write((Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o"))`,
        ])
      : await execFileStdout("ps", ["-o", "lstart=", "-p", String(pid)]);
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw.trim().replace(/\s+/g, " "));
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function resolvePostCoreUpdateStartedAtMs(
  env: NodeJS.ProcessEnv,
): Promise<number | undefined> {
  const fromEnv = Number.parseInt(env[POST_CORE_UPDATE_STARTED_AT_ENV] ?? "", 10);
  if (Number.isFinite(fromEnv) && fromEnv > 0) {
    return fromEnv;
  }
  return await readProcessStartTimeMs(process.ppid);
}

async function readPostCorePreUpdateSourceConfig(params: {
  sourceConfigPath: string | undefined;
  currentSnapshot: Awaited<ReturnType<typeof readConfigFileSnapshot>>;
  updateStartedAtMs?: number;
}): Promise<PreUpdateConfigRestoreInput | undefined> {
  const fromChildEnv = await readPostCoreSourceConfigFile(params.sourceConfigPath);
  if (fromChildEnv) {
    return fromChildEnv;
  }
  if (params.updateStartedAtMs === undefined) {
    return undefined;
  }
  const explicitPreUpdatePath = `${params.currentSnapshot.path}.pre-update`;
  if (
    await isFreshPreUpdateConfigSnapshot({
      currentConfigPath: params.currentSnapshot.path,
      snapshotPath: explicitPreUpdatePath,
      updateStartedAtMs: params.updateStartedAtMs,
    })
  ) {
    const preUpdateConfig = await readPostCoreSourceConfigFile(explicitPreUpdatePath, {
      configPath: params.currentSnapshot.path,
    });
    if (
      preUpdateConfig &&
      hasRestorablePreUpdateChannels(params.currentSnapshot, preUpdateConfig)
    ) {
      return preUpdateConfig;
    }
    return undefined;
  }

  const backupPath = `${params.currentSnapshot.path}.bak`;
  if (
    await isFreshPreUpdateConfigSnapshot({
      currentConfigPath: params.currentSnapshot.path,
      snapshotPath: backupPath,
      updateStartedAtMs: params.updateStartedAtMs,
    })
  ) {
    const preUpdateConfig = await readPostCoreSourceConfigFile(backupPath, {
      configPath: params.currentSnapshot.path,
    });
    if (
      preUpdateConfig &&
      hasRestorablePreUpdateChannels(params.currentSnapshot, preUpdateConfig)
    ) {
      return preUpdateConfig;
    }
  }
  return undefined;
}

async function readPostCorePluginUpdateResultFile(
  filePath: string,
): Promise<PostCorePluginUpdateResult | undefined> {
  try {
    const parsed = await readJsonIfExists<PostCorePluginUpdateResult>(filePath);
    if (
      parsed &&
      typeof parsed === "object" &&
      (parsed.status === "ok" ||
        parsed.status === "warning" ||
        parsed.status === "skipped" ||
        parsed.status === "error")
    ) {
      return parsed;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function stopPostCoreUpdateChild(child: ChildProcess): void {
  if (process.platform === "win32" && child.pid) {
    try {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("error", () => {
        child.kill();
      });
      return;
    } catch {
      child.kill();
      return;
    }
  }
  child.kill();
}

/**
 * Returns the stdio mode for the post-core-update child process.
 *
 * Windows shells (PowerShell/CMD) wait for all processes that hold inherited console handles to
 * exit before returning the prompt, even after the immediate child has exited.  Using "pipe" on
 * Windows prevents the child (and any grandchildren it spawns) from ever receiving a reference to
 * the parent's console handles, eliminating the terminal hang seen in #78445.
 *
 * @internal exported for testing
 */
export function resolvePostCoreUpdateChildStdio(
  platform: NodeJS.Platform = process.platform,
): "inherit" | "pipe" {
  return platform === "win32" ? "pipe" : "inherit";
}

async function continuePostCoreUpdateInFreshProcess(params: {
  root: string;
  channel: "stable" | "beta" | "dev";
  requestedChannel: "stable" | "beta" | "dev" | null;
  opts: UpdateCommandOptions;
  pluginInstallRecords: Record<string, PluginInstallRecord>;
  preUpdateConfig?: PreUpdateConfigRestoreInput;
  updateStartedAtMs: number;
}): Promise<{ resumed: boolean; pluginUpdate?: PostCorePluginUpdateResult }> {
  const entryPath = await resolveGatewayInstallEntrypoint(params.root);
  if (!entryPath) {
    return { resumed: false };
  }

  const argv = [entryPath, "update"];
  if (params.opts.json) {
    argv.push("--json");
  }
  if (params.opts.restart === false) {
    argv.push("--no-restart");
  }
  if (params.opts.yes) {
    argv.push("--yes");
  }
  if (params.opts.timeout) {
    argv.push("--timeout", params.opts.timeout);
  }
  const resultDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-update-post-core-"));
  const resultPath = path.join(resultDir, "plugins.json");
  const installRecordsPath = path.join(resultDir, "plugin-install-records.json");
  const sourceConfigPath = path.join(resultDir, "source-config.json");

  try {
    await writePostCorePluginInstallRecordsFile(installRecordsPath, params.pluginInstallRecords);
    await writePostCoreSourceConfigFile(sourceConfigPath, params.preUpdateConfig);
    const childStdio = resolvePostCoreUpdateChildStdio();
    const child = spawn(resolveNodeRunner(), argv, {
      stdio: childStdio,
      env: {
        ...stripGatewayServiceMarkerEnv(disableUpdatedPackageCompileCacheEnv(process.env)),
        [POST_CORE_UPDATE_ENV]: "1",
        [POST_CORE_UPDATE_CHANNEL_ENV]: params.channel,
        ...(params.requestedChannel
          ? { [POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]: params.requestedChannel }
          : {}),
        [POST_CORE_UPDATE_RESULT_PATH_ENV]: resultPath,
        [POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV]: installRecordsPath,
        [POST_CORE_UPDATE_STARTED_AT_ENV]: String(params.updateStartedAtMs),
        ...(params.preUpdateConfig
          ? { [POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV]: sourceConfigPath }
          : {}),
      },
    });
    // When piped, relay child output to the parent process so terminal output is preserved.
    if (childStdio === "pipe") {
      child.stdout?.pipe(process.stdout);
      child.stderr?.pipe(process.stderr);
    }

    const childResult = await new Promise<
      | { kind: "exit"; exitCode: number }
      | { kind: "plugin-update"; pluginUpdate: PostCorePluginUpdateResult }
    >((resolve, reject) => {
      let settled = false;
      const finish = (
        result:
          | { kind: "exit"; exitCode: number }
          | { kind: "plugin-update"; pluginUpdate: PostCorePluginUpdateResult },
      ) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(resultPoll);
        resolve(result);
      };
      const resultPoll = setInterval(() => {
        void readPostCorePluginUpdateResultFile(resultPath)
          .then((pluginUpdate) => {
            if (!pluginUpdate) {
              return;
            }
            stopPostCoreUpdateChild(child);
            finish({ kind: "plugin-update", pluginUpdate });
          })
          .catch(() => undefined);
      }, POST_CORE_UPDATE_RESULT_POLL_MS);
      child.once("error", (error) => {
        if (settled) {
          return;
        }
        settled = true;
        clearInterval(resultPoll);
        reject(error);
      });
      child.once("exit", (code, signal) => {
        if (settled) {
          return;
        }
        if (signal) {
          settled = true;
          clearInterval(resultPoll);
          reject(new Error(`post-update process terminated by signal ${signal}`));
          return;
        }
        finish({ kind: "exit", exitCode: code ?? 1 });
      });
    });

    const pluginUpdate =
      childResult.kind === "plugin-update"
        ? childResult.pluginUpdate
        : await readPostCorePluginUpdateResultFile(resultPath);
    const exitCode = childResult.kind === "exit" ? childResult.exitCode : 0;
    if (exitCode !== 0) {
      if (pluginUpdate) {
        return { resumed: true, pluginUpdate };
      }
      defaultRuntime.exit(exitCode);
      throw new Error(`post-update process exited with code ${exitCode}`);
    }
    return { resumed: true, ...(pluginUpdate ? { pluginUpdate } : {}) };
  } finally {
    await fs.rm(resultDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

function shouldResumePostCoreUpdateInFreshProcess(params: {
  result: UpdateRunResult;
  downgradeRisk: boolean;
}): boolean {
  if (params.downgradeRisk) {
    return false;
  }
  if (isPackageManagerUpdateMode(params.result.mode)) {
    return true;
  }
  if (params.result.mode !== "git") {
    return false;
  }
  const beforeSha = normalizeOptionalString(params.result.before?.sha);
  const afterSha = normalizeOptionalString(params.result.after?.sha);
  if (beforeSha && afterSha && beforeSha !== afterSha) {
    return true;
  }
  const beforeVersion = normalizeOptionalString(params.result.before?.version);
  const afterVersion = normalizeOptionalString(params.result.after?.version);
  return Boolean(beforeVersion && afterVersion && beforeVersion !== afterVersion);
}

async function writeControlPlaneUpdateRestartSentinelBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  result: UpdateRunResult;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await writeControlPlaneUpdateRestartSentinel({
      meta: params.meta,
      result: params.result,
    });
  } catch (err) {
    const message = `Failed to write update.run restart sentinel: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

async function markControlPlaneUpdateRestartSentinelFailureBestEffort(params: {
  meta: ControlPlaneUpdateSentinelMetaFile["meta"] | null;
  reason: string;
  jsonMode: boolean;
}): Promise<void> {
  if (!params.meta) {
    return;
  }
  try {
    await markControlPlaneUpdateRestartSentinelFailure(params.reason);
  } catch (err) {
    const message = `Failed to mark update.run restart sentinel failed: ${String(err)}`;
    if (params.jsonMode) {
      defaultRuntime.error(message);
    } else {
      defaultRuntime.log(theme.warn(message));
    }
  }
}

export async function updateCommand(opts: UpdateCommandOptions): Promise<void> {
  suppressDeprecations();
  await cleanupStaleManagedServiceUpdateHandoffs().catch(() => undefined);
  const invocationCwd = tryResolveInvocationCwd();
  const postCoreUpdateResume = process.env[POST_CORE_UPDATE_ENV] === "1";
  const postCoreUpdateChannel = process.env[POST_CORE_UPDATE_CHANNEL_ENV]?.trim();
  const postCoreRequestedChannelInput =
    process.env[POST_CORE_UPDATE_REQUESTED_CHANNEL_ENV]?.trim() ?? "";
  const postCoreInstallRecordsPath = process.env[POST_CORE_UPDATE_INSTALL_RECORDS_PATH_ENV];

  const timeoutMs = parseTimeoutMsOrExit(opts.timeout);
  const shouldRestart = opts.restart !== false;
  if (timeoutMs === null) {
    return;
  }
  if (opts.dryRun !== true) {
    await disableCurrentOpenClawUpdateLaunchdJob().catch(() => undefined);
    assertConfigWriteAllowedInCurrentMode();
  }
  const updateStepTimeoutMs = timeoutMs ?? DEFAULT_UPDATE_STEP_TIMEOUT_MS;

  const root = await resolveUpdateRoot();
  if (postCoreUpdateResume) {
    if (
      postCoreUpdateChannel !== "stable" &&
      postCoreUpdateChannel !== "beta" &&
      postCoreUpdateChannel !== "dev"
    ) {
      defaultRuntime.error("Missing post-core update channel context.");
      defaultRuntime.exit(1);
      return;
    }

    const postCoreRequestedChannel = postCoreRequestedChannelInput
      ? normalizeUpdateChannel(postCoreRequestedChannelInput)
      : null;
    if (postCoreRequestedChannelInput && !postCoreRequestedChannel) {
      defaultRuntime.error("Invalid post-core requested update channel context.");
      defaultRuntime.exit(1);
      return;
    }

    let postCoreConfigSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
    const preUpdateSourceConfig = await readPostCorePreUpdateSourceConfig({
      sourceConfigPath: process.env[POST_CORE_UPDATE_SOURCE_CONFIG_PATH_ENV],
      currentSnapshot: postCoreConfigSnapshot,
      updateStartedAtMs: await resolvePostCoreUpdateStartedAtMs(process.env),
    });
    postCoreConfigSnapshot = await persistRequestedUpdateChannel({
      configSnapshot: postCoreConfigSnapshot,
      requestedChannel: postCoreRequestedChannel,
    });
    const restoredPostCoreConfig = restoreDroppedPreUpdateChannels(
      postCoreConfigSnapshot,
      preUpdateSourceConfig,
    );

    const pluginUpdate = await runPostCorePluginUpdate({
      root,
      channel: postCoreUpdateChannel,
      configSnapshot: restoredPostCoreConfig.snapshot,
      configChanged: restoredPostCoreConfig.changed,
      restoredAuthoredChannels: restoredPostCoreConfig.authoredChannels,
      opts,
      timeoutMs: updateStepTimeoutMs,
      pluginInstallRecords: await readPostCorePluginInstallRecordsFile(postCoreInstallRecordsPath),
    });
    if (process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
      await writePostCorePluginUpdateResultFile(
        process.env[POST_CORE_UPDATE_RESULT_PATH_ENV],
        pluginUpdate,
      );
    }
    if (opts.json) {
      if (!process.env[POST_CORE_UPDATE_RESULT_PATH_ENV]) {
        const result: UpdateRunResult = {
          status: pluginUpdate.status === "error" ? "error" : "ok",
          mode: "unknown",
          root,
          steps: [],
          durationMs: 0,
          postUpdate: { plugins: pluginUpdate },
        };
        defaultRuntime.writeJson(result);
      }
    }
    defaultRuntime.exit(0);
    return;
  }

  const controlPlaneUpdateSentinelMeta = await readControlPlaneUpdateSentinelMeta();
  const updateStatus = await checkUpdateStatus({
    root,
    timeoutMs: timeoutMs ?? 3500,
    fetchGit: false,
    includeRegistry: false,
  });

  const requestedChannel = normalizeUpdateChannel(opts.channel);
  if (opts.channel && !requestedChannel) {
    defaultRuntime.error(`--channel must be "stable", "beta", or "dev" (got "${opts.channel}")`);
    defaultRuntime.exit(1);
    return;
  }

  let configSnapshot = await readConfigFileSnapshot({ skipPluginValidation: true });
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
    defaultRuntime.error(["Config is invalid; cannot set update channel.", ...issues].join("\n"));
    defaultRuntime.exit(1);
    return;
  }

  const installKind = updateStatus.installKind;
  const switchToGit = requestedChannel === "dev" && installKind !== "git";
  const switchToPackage =
    requestedChannel !== null && requestedChannel !== "dev" && installKind === "git";
  const updateInstallKind = switchToGit ? "git" : switchToPackage ? "package" : installKind;
  const defaultChannel =
    updateInstallKind === "git" ? DEFAULT_GIT_CHANNEL : DEFAULT_PACKAGE_CHANNEL;
  const channel = requestedChannel ?? storedChannel ?? defaultChannel;
  const devTargetRef =
    channel === "dev" ? process.env.OPENCLAW_UPDATE_DEV_TARGET_REF?.trim() || undefined : undefined;

  const explicitTag = normalizeTag(opts.tag);
  let tag = explicitTag ?? channelToNpmTag(channel);
  let currentVersion: string | null = null;
  let targetVersion: string | null = null;
  let downgradeRisk = false;
  let fallbackToLatest = false;
  let packageInstallSpec: string | null = null;
  let packageAlreadyCurrent = false;

  if (updateInstallKind !== "git") {
    currentVersion = switchToPackage ? null : await readPackageVersion(root);
    if (explicitTag) {
      targetVersion = await resolveTargetVersion(tag, timeoutMs);
    } else {
      targetVersion = await resolveNpmChannelTag({ channel, timeoutMs }).then((resolved) => {
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
      currentVersion === targetVersion &&
      (requestedChannel === null || requestedChannel === storedChannel);
    downgradeRisk =
      canResolveRegistryVersionForPackageTarget(tag) &&
      !fallbackToLatest &&
      currentVersion != null &&
      (targetVersion == null || (cmp != null && cmp > 0));
    packageInstallSpec = resolveGlobalInstallSpec({
      packageName: DEFAULT_PACKAGE_NAME,
      tag,
      env: process.env,
    });
  }

  if (opts.dryRun) {
    let mode: UpdateRunResult["mode"] = "unknown";
    if (updateInstallKind === "git") {
      mode = "git";
    } else if (updateInstallKind === "package") {
      mode = await resolveGlobalManager({
        root,
        installKind,
        timeoutMs: updateStepTimeoutMs,
      });
    }

    const actions: string[] = [];
    if (requestedChannel && requestedChannel !== storedChannel) {
      actions.push(`Persist update.channel=${requestedChannel} in config`);
    }
    if (switchToGit) {
      actions.push("Switch install mode from package to git checkout (dev channel)");
    } else if (switchToPackage) {
      actions.push(`Switch install mode from git to package manager (${mode})`);
    } else if (updateInstallKind === "git") {
      actions.push(`Run git update flow on channel ${channel} (fetch/rebase/build/doctor)`);
    } else if (packageAlreadyCurrent) {
      actions.push(
        `Refresh package install with spec ${packageInstallSpec ?? tag}; current version already matches ${targetVersion}`,
      );
    } else {
      actions.push(`Run global package manager update with spec ${packageInstallSpec ?? tag}`);
    }
    actions.push("Run plugin update sync after core update");
    actions.push("Refresh shell completion cache (if needed)");
    actions.push(
      shouldRestart
        ? "Restart gateway service and run doctor checks"
        : "Skip restart (because --no-restart is set)",
    );

    const notes: string[] = [];
    if (opts.tag && updateInstallKind === "git") {
      notes.push("--tag applies to npm installs only; git updates ignore it.");
    }
    if (fallbackToLatest) {
      notes.push("Beta channel resolves to latest for this run (fallback).");
    }
    if (explicitTag && !canResolveRegistryVersionForPackageTarget(tag)) {
      notes.push("Non-registry package specs skip npm version lookup and downgrade previews.");
    }

    printDryRunPreview(
      {
        dryRun: true,
        root,
        installKind,
        mode,
        updateInstallKind,
        switchToGit,
        switchToPackage,
        restart: shouldRestart,
        requestedChannel,
        storedChannel,
        effectiveChannel: channel,
        tag: packageInstallSpec ?? tag,
        currentVersion,
        targetVersion,
        downgradeRisk,
        actions,
        notes,
      },
      Boolean(opts.json),
    );
    return;
  }

  if (downgradeRisk && !opts.yes) {
    if (!process.stdin.isTTY || opts.json) {
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
    const runtimePreflightError = await resolvePackageRuntimePreflightError({
      tag,
      timeoutMs,
    });
    if (runtimePreflightError) {
      defaultRuntime.error(runtimePreflightError);
      defaultRuntime.exit(1);
      return;
    }
  }

  const showProgress = !opts.json && process.stdout.isTTY;
  if (!opts.json) {
    defaultRuntime.log(theme.heading("Updating OpenClaw..."));
    defaultRuntime.log("");
  }

  const { progress, stop } = createUpdateProgress(showProgress);
  const startedAt = Date.now();
  const preUpdatePluginInstallRecords = await loadInstalledPluginIndexInstallRecords();

  let prePackageServiceStop: PrePackageServiceStop | undefined;
  if (updateInstallKind === "package") {
    try {
      prePackageServiceStop = await maybeStopManagedServiceBeforePackageUpdate({
        shouldRestart,
        jsonMode: Boolean(opts.json),
      });
    } catch (err) {
      stop();
      defaultRuntime.error(`Failed to stop managed gateway service before update: ${String(err)}`);
      defaultRuntime.exit(1);
      return;
    }

    if (prePackageServiceStop?.blockMessage) {
      stop();
      defaultRuntime.error(prePackageServiceStop.blockMessage);
      defaultRuntime.exit(1);
      return;
    }

    if (shouldBlockPackageUpdateFromGatewayServiceEnv({ prePackageServiceStop })) {
      stop();
      defaultRuntime.error(
        [
          "Package updates cannot run from inside the gateway service process.",
          "That path replaces the active OpenClaw dist tree while the live gateway may still lazy-load old chunks.",
          `Run \`${replaceCliName(formatCliCommand("openclaw update"), CLI_NAME)}\` from a shell outside the gateway service, or stop the gateway service first and then update.`,
        ].join("\n"),
      );
      defaultRuntime.exit(1);
      return;
    }
  }

  let result: UpdateRunResult;
  try {
    result =
      updateInstallKind === "package"
        ? await runPackageInstallUpdate({
            root,
            installKind,
            tag,
            timeoutMs: updateStepTimeoutMs,
            startedAt,
            progress,
            jsonMode: Boolean(opts.json),
            managedServiceEnv: prePackageServiceStop?.serviceEnv,
            invocationCwd,
          })
        : await runGitUpdate({
            root,
            switchToGit,
            installKind,
            timeoutMs,
            startedAt,
            progress,
            channel,
            tag,
            showProgress,
            opts,
            stop,
            devTargetRef,
          });
  } catch (err) {
    stop();
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    throw err;
  }

  stop();
  if (!opts.json || result.status !== "ok") {
    printResult(result, { ...opts, hideSteps: showProgress });
  }

  if (result.status === "error") {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(opts.json),
    });
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  if (result.status === "skipped") {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result,
      jsonMode: Boolean(opts.json),
    });
    await maybeRestartServiceAfterFailedPackageUpdate({
      prePackageServiceStop,
      jsonMode: Boolean(opts.json),
    });
    if (result.reason === "dirty") {
      defaultRuntime.error(theme.error("Update blocked: local files are edited in this checkout."));
      defaultRuntime.log(
        theme.warn(
          "Git-based updates need a clean working tree before they can switch commits, fetch, or rebase.",
        ),
      );
      defaultRuntime.log(
        theme.muted("Commit, stash, or discard the local changes, then rerun `openclaw update`."),
      );
    }
    if (result.reason === "not-git-install") {
      defaultRuntime.log(
        theme.warn(
          `Skipped: this OpenClaw install isn't a git checkout, and the package manager couldn't be detected. Update via your package manager, then run \`${replaceCliName(formatCliCommand("openclaw doctor"), CLI_NAME)}\` and \`${replaceCliName(formatCliCommand("openclaw gateway restart"), CLI_NAME)}\`.`,
        ),
      );
      defaultRuntime.log(
        theme.muted(
          `Examples: \`${replaceCliName("npm i -g openclaw@latest", CLI_NAME)}\` or \`${replaceCliName("pnpm add -g openclaw@latest", CLI_NAME)}\``,
        ),
      );
    }
    defaultRuntime.exit(0);
    return;
  }

  const shouldResumePostCoreInFreshProcess = shouldResumePostCoreUpdateInFreshProcess({
    result,
    downgradeRisk,
  });

  let postUpdateConfigSnapshot =
    result.status === "ok" && !opts.dryRun
      ? await readConfigFileSnapshot({ skipPluginValidation: true })
      : configSnapshot;
  if (!shouldResumePostCoreInFreshProcess) {
    postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
      configSnapshot: postUpdateConfigSnapshot,
      requestedChannel,
    });
  }
  if (
    requestedChannel &&
    configSnapshot.valid &&
    requestedChannel !== storedChannel &&
    !shouldResumePostCoreInFreshProcess &&
    !opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel set to ${requestedChannel}.`));
  } else if (
    requestedChannel &&
    configSnapshot.valid &&
    requestedChannel !== storedChannel &&
    shouldResumePostCoreInFreshProcess &&
    !opts.json
  ) {
    defaultRuntime.log(theme.muted(`Update channel will be set to ${requestedChannel}.`));
  }

  const postUpdateRoot = result.root ?? root;

  let postCorePluginUpdate: PostCorePluginUpdateResult | undefined;
  let pluginsUpdatedInFreshProcess = false;
  if (shouldResumePostCoreInFreshProcess) {
    const freshProcessResult = await continuePostCoreUpdateInFreshProcess({
      root: postUpdateRoot,
      channel,
      requestedChannel,
      opts,
      pluginInstallRecords: preUpdatePluginInstallRecords,
      updateStartedAtMs: startedAt,
      preUpdateConfig: configSnapshot.valid
        ? {
            sourceConfig: configSnapshot.sourceConfig,
            authoredConfig: isRecord(configSnapshot.parsed)
              ? (configSnapshot.parsed as OpenClawConfig)
              : configSnapshot.sourceConfig,
          }
        : undefined,
    });
    pluginsUpdatedInFreshProcess = freshProcessResult.resumed;
    postCorePluginUpdate = freshProcessResult.pluginUpdate;
  }

  if (!pluginsUpdatedInFreshProcess) {
    if (shouldResumePostCoreInFreshProcess) {
      postUpdateConfigSnapshot = await persistRequestedUpdateChannel({
        configSnapshot: postUpdateConfigSnapshot,
        requestedChannel,
      });
    }
    const restoredConfig = restoreDroppedPreUpdateChannels(
      postUpdateConfigSnapshot,
      configSnapshot.valid
        ? {
            sourceConfig: configSnapshot.sourceConfig,
            authoredConfig: isRecord(configSnapshot.parsed)
              ? (configSnapshot.parsed as OpenClawConfig)
              : configSnapshot.sourceConfig,
          }
        : undefined,
    );
    postUpdateConfigSnapshot = restoredConfig.snapshot;
    postCorePluginUpdate = await runPostCorePluginUpdate({
      root: postUpdateRoot,
      channel,
      configSnapshot: postUpdateConfigSnapshot,
      configChanged: restoredConfig.changed,
      restoredAuthoredChannels: restoredConfig.authoredChannels,
      opts,
      timeoutMs: updateStepTimeoutMs,
      pluginInstallRecords: preUpdatePluginInstallRecords,
    });
  }

  const resultWithPostUpdate: UpdateRunResult = postCorePluginUpdate
    ? {
        ...result,
        status: postCorePluginUpdate.status === "error" ? "error" : result.status,
        ...(postCorePluginUpdate.status === "error" ? { reason: "post-update-plugins" } : {}),
        postUpdate: {
          ...result.postUpdate,
          plugins: postCorePluginUpdate,
        },
      }
    : result;

  if (postCorePluginUpdate?.status === "error") {
    await writeControlPlaneUpdateRestartSentinelBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      result: resultWithPostUpdate,
      jsonMode: Boolean(opts.json),
    });
    if (opts.json) {
      defaultRuntime.writeJson(resultWithPostUpdate);
    } else {
      defaultRuntime.error(theme.error("Update failed during plugin post-update sync."));
    }
    defaultRuntime.exit(1);
    return;
  }

  let restartScriptPath: string | null = null;
  let refreshGatewayServiceEnv = false;
  let gatewayServiceEnv: NodeJS.ProcessEnv | undefined;
  let gatewayPort = resolveUpdatedGatewayRestartPort({
    config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
    processEnv: process.env,
  });
  if (shouldRestart) {
    try {
      const serviceState = await readGatewayServiceState(resolveGatewayService(), {
        env: process.env,
      });
      if (
        shouldPrepareUpdatedInstallRestart({
          updateMode: resultWithPostUpdate.mode,
          serviceInstalled: serviceState.installed,
          serviceLoaded: serviceState.loaded,
        })
      ) {
        gatewayServiceEnv = serviceState.env;
        gatewayPort = resolveUpdatedGatewayRestartPort({
          config: postUpdateConfigSnapshot.valid ? postUpdateConfigSnapshot.config : undefined,
          processEnv: process.env,
          serviceEnv: gatewayServiceEnv,
        });
        restartScriptPath = await prepareRestartScript(serviceState.env, gatewayPort);
        refreshGatewayServiceEnv = true;
      }
    } catch {
      // Ignore errors during pre-check; fallback to standard restart
    }
  }

  await tryWriteCompletionCache(postUpdateRoot, Boolean(opts.json));
  await tryInstallShellCompletion({
    jsonMode: Boolean(opts.json),
    skipPrompt: Boolean(opts.yes),
  });

  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: controlPlaneUpdateSentinelMeta,
    result: buildControlPlaneUpdateRestartHealthPendingResult(resultWithPostUpdate),
    jsonMode: Boolean(opts.json),
  });

  const restartOk = await maybeRestartService({
    shouldRestart,
    result: resultWithPostUpdate,
    opts,
    refreshServiceEnv: refreshGatewayServiceEnv,
    serviceEnv: gatewayServiceEnv,
    gatewayPort,
    restartScriptPath,
    invocationCwd,
  });
  if (!restartOk) {
    await markControlPlaneUpdateRestartSentinelFailureBestEffort({
      meta: controlPlaneUpdateSentinelMeta,
      reason: "restart-unhealthy",
      jsonMode: Boolean(opts.json),
    });
    defaultRuntime.exit(1);
    return;
  }

  await writeControlPlaneUpdateRestartSentinelBestEffort({
    meta: controlPlaneUpdateSentinelMeta,
    result: resultWithPostUpdate,
    jsonMode: Boolean(opts.json),
  });

  if (!opts.json) {
    defaultRuntime.log(theme.muted(pickUpdateQuip()));
  } else {
    defaultRuntime.writeJson(resultWithPostUpdate);
  }
}
