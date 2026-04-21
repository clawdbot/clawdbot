import { withProgress } from "../cli/progress.js";
import { hasConfiguredChannelsForReadOnlyScope } from "../plugins/channel-plugin-ids.js";
import { buildPluginCompatibilitySnapshotNotices } from "../plugins/status.js";
import type { RuntimeEnv } from "../runtime.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { resolveStatusMemoryStatusSnapshot } from "./status.scan-memory.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";
import { scanStatusJsonWithPolicy } from "./status.scan.fast-json.js";

export async function scanStatus(
  opts: {
    json?: boolean;
    timeoutMs?: number;
    all?: boolean;
  },
  _runtime: RuntimeEnv,
): Promise<StatusScanResult> {
  if (opts.json) {
    return await scanStatusJsonWithPolicy(
      {
        timeoutMs: opts.timeoutMs,
        all: opts.all,
      },
      _runtime,
      {
        commandName: "status --json",
        resolveHasConfiguredChannels: (cfg) =>
          hasConfiguredChannelsForReadOnlyScope({ config: cfg }),
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
          }),
      },
    );
  }
  return await withProgress(
    {
      label: "Scanning status…",
      total: 10,
      enabled: true,
    },
    async (progress) => {
      const overview = await collectStatusScanOverview({
        commandName: "status",
        opts,
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
        progress,
        labels: {
          loadingConfig: "Loading config…",
          checkingTailscale: "Checking Tailscale…",
          checkingForUpdates: "Checking for updates…",
          resolvingAgents: "Resolving agents…",
          probingGateway: "Probing gateway…",
          queryingChannelStatus: "Querying channel status…",
          summarizingChannels: "Summarizing channels…",
        },
      });

      progress.setLabel("Checking plugins…");
      const pluginCompatibility = buildPluginCompatibilitySnapshotNotices({ config: overview.cfg });
      progress.tick();

      progress.setLabel("Checking memory and sessions…");
      const result = await executeStatusScanFromOverview({
        overview,
        resolveMemory: async ({ cfg, agentStatus, memoryPlugin }) =>
          await resolveStatusMemoryStatusSnapshot({
            cfg,
            agentStatus,
            memoryPlugin,
          }),
        channelIssues: overview.channelIssues,
        channels: overview.channels,
        pluginCompatibility,
      });
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return result;
    },
  );
}
