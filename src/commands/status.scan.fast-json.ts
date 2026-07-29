// Fast `openclaw status --json` scan policy.
// Skips channel tables and most network/update work unless `--all` asks for fuller evidence.

import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { isRecord } from "../utils.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import {
  resolveDefaultMemoryDatabasePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const STATUS_JSON_CHANNEL_ENV_PREFIXES = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) => entry.configurable !== false,
).map((entry) => `${entry.channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`);
const STATUS_JSON_CHANNEL_ENV_VARS = new Set(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).flatMap(
    (entry) => entry.channelEnvVars ?? [],
  ),
);

type StatusJsonScanPolicy = {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  fetchGitUpdate?: boolean;
  includeRegistryUpdate?: boolean;
  includeLocalStatusRpcFallback?: boolean;
  gatewayProbeTimeoutMs?: number | ((cfg: OpenClawConfig) => number | undefined);
  resolveHasConfiguredChannels: (
    cfg: OpenClawConfig,
    sourceConfig: OpenClawConfig,
  ) => boolean | Promise<boolean>;
  resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
};

function hasMeaningfulStatusJsonChannelConfig(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  return Object.keys(value).some((key) => key !== "enabled");
}

function hasExplicitStatusJsonChannelConfig(cfg: OpenClawConfig): boolean {
  if (!isRecord(cfg.channels)) {
    return false;
  }
  for (const [key, value] of Object.entries(cfg.channels)) {
    if (IGNORED_CHANNEL_CONFIG_KEYS.has(key)) {
      continue;
    }
    // `enabled` alone can be a default scaffold; require another configured field.
    if (hasMeaningfulStatusJsonChannelConfig(value)) {
      return true;
    }
  }
  return false;
}

function hasStatusJsonChannelEnvConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }
    if (
      STATUS_JSON_CHANNEL_ENV_VARS.has(key) ||
      STATUS_JSON_CHANNEL_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))
    ) {
      return true;
    }
  }
  return false;
}

function hasPotentialConfiguredChannelsForStatusJson(cfg: OpenClawConfig): boolean {
  return hasExplicitStatusJsonChannelConfig(cfg) || hasStatusJsonChannelEnvConfig();
}

/** Runs status JSON with an injectable policy for tests and specialized callers. */
export async function scanStatusJsonWithPolicy(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
  policy: StatusJsonScanPolicy,
): Promise<StatusScanResult> {
  const overview = await collectStatusScanOverview({
    commandName: policy.commandName,
    opts,
    showSecrets: false,
    runtime,
    allowMissingConfigFastPath: policy.allowMissingConfigFastPath,
    resolveHasConfiguredChannels: policy.resolveHasConfiguredChannels,
    includeChannelsData: false,
    // Fast JSON only needs to know whether channels may exist; it does not render channel tables.
    includeChannelSecretTargets: false,
    skipConfigPluginValidation: true,
    fetchGitUpdate: policy.fetchGitUpdate,
    includeRegistryUpdate: policy.includeRegistryUpdate,
    includeLocalStatusRpcFallback: policy.includeLocalStatusRpcFallback,
    gatewayProbeTimeoutMs: policy.gatewayProbeTimeoutMs,
  });
  return await executeStatusScanFromOverview({
    overview,
    runtime,
    resolveMemory: policy.resolveMemory,
    channelIssues: [],
    channels: { rows: [], details: [] },
    pluginCompatibility: [],
  });
}

/** Runs the default fast status JSON scan. */
export async function scanStatusJsonFast(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  return await scanStatusJsonWithPolicy(opts, runtime, {
    commandName: "status --json",
    allowMissingConfigFastPath: true,
    fetchGitUpdate: opts.all === true,
    includeRegistryUpdate: opts.all === true,
    includeLocalStatusRpcFallback: opts.all === true,
    gatewayProbeTimeoutMs: opts.all === true ? undefined : () => opts.timeoutMs ?? 1000,
    resolveHasConfiguredChannels: (cfg) => hasPotentialConfiguredChannelsForStatusJson(cfg),
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
      opts.all
        ? await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
            requireDefaultDatabasePath: resolveDefaultMemoryDatabasePath,
          })
        : null,
  });
}
