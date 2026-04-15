import { hasPotentialConfiguredChannels } from "../channels/config-presence.js";
import { ensureCliPluginRegistryLoaded } from "../cli/plugin-registry-loader.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import {
  resolveDefaultMemoryStorePath,
  resolveStatusMemoryStatusSnapshot,
} from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

type StatusJsonScanPolicy = {
  commandName: string;
  allowMissingConfigFastPath?: boolean;
  resolveHasConfiguredChannels: (
    cfg: Parameters<typeof hasPotentialConfiguredChannels>[0],
  ) => boolean;
  resolveMemory: Parameters<typeof executeStatusScanFromOverview>[0]["resolveMemory"];
};

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
  });
  if (overview.hasConfiguredChannels) {
    await ensureCliPluginRegistryLoaded({
      scope: "configured-channels",
      routeLogsToStderr: true,
      config: overview.cfg,
      activationSourceConfig: overview.sourceConfig,
    });
  }

  return await executeStatusScanFromOverview({
    overview,
    runtime,
    resolveMemory: policy.resolveMemory,
    channelIssues: [],
    channels: { rows: [], details: [] },
    pluginCompatibility: [],
  });
}

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
    resolveHasConfiguredChannels: (cfg) =>
      hasPotentialConfiguredChannels(cfg, process.env, {
        includePersistedAuthState: false,
      }),
    resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
      opts.all
        ? await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
            requireDefaultStore: resolveDefaultMemoryStorePath,
          })
        : null,
  });
}
