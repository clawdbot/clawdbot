// Fast `openclaw status --json` scan policy.
// Skips channel tables and most network/update work unless `--all` asks for fuller evidence.

import { GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA } from "../config/bundled-channel-config-metadata.generated.js";
import type { OpenClawConfig } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import { isRecord } from "../utils.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

const statusScanMemoryModuleLoader = createLazyImportLoader(
  () => import("./status.scan-memory.js"),
);
const statusScanPluginStatusModuleLoader = createLazyImportLoader(
  () => import("../plugins/status.js"),
);

const IGNORED_CHANNEL_CONFIG_KEYS = new Set(["defaults", "modelByChannel"]);
const STATUS_JSON_CHANNEL_ENV_PREFIXES = GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter(
  (entry) => entry.configurable !== false,
).map((entry) => `${entry.channelId.replace(/[^a-z0-9]+/gi, "_").toUpperCase()}_`);
const STATUS_JSON_CHANNEL_ENV_VARS = new Set(
  GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA.filter((entry) => entry.configurable !== false).flatMap(
    (entry) => entry.channelEnvVars ?? [],
  ),
);

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

/** Runs the default fast status JSON scan. */
export async function scanStatusJsonFast(
  opts: {
    timeoutMs?: number;
    all?: boolean;
  },
  runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  const overview = await collectStatusScanOverview({
    env: process.env,
    commandName: "status --json",
    opts,
    showSecrets: false,
    runtime,
    allowMissingConfigFastPath: true,
    resolveHasConfiguredChannels: (cfg) => hasPotentialConfiguredChannelsForStatusJson(cfg),
    includeChannelsData: false,
    fetchGitUpdate: opts.all === true,
    includeRegistryUpdate: opts.all === true,
    includeLocalStatusRpcFallback: opts.all === true,
    gatewayProbeTimeoutMs: opts.all === true ? undefined : (opts.timeoutMs ?? 1000),
  });
  const pluginCompatibility = opts.all
    ? await statusScanPluginStatusModuleLoader
        .load()
        .then(({ buildPluginCompatibilitySnapshotNotices }) =>
          buildPluginCompatibilitySnapshotNotices({ config: overview.cfg }),
        )
    : [];
  return await executeStatusScanFromOverview({
    overview,
    runtime,
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) => {
      if (!opts.all) {
        return null;
      }
      const { resolveDefaultMemoryDatabasePath, resolveStatusMemoryStatusSnapshot } =
        await statusScanMemoryModuleLoader.load();
      return await resolveStatusMemoryStatusSnapshot({
        cfg,
        agentStatus,
        memoryPlugin,
        requireDefaultDatabasePath: resolveDefaultMemoryDatabasePath,
      });
    },
    channelIssues: overview.channelIssues,
    channels: overview.channels,
    pluginCompatibility,
  });
}
