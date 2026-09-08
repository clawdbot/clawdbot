// Top-level text status scan entrypoint.
// Human `status --all` and JSON status use their dedicated command paths.

import { withProgress } from "../cli/progress.js";
import { executeStatusScanFromOverview } from "./status.scan-execute.ts";
import { collectStatusScanOverview } from "./status.scan-overview.ts";
import type { StatusScanResult } from "./status.scan-result.ts";

/** Runs the text status scan. */
export async function scanStatus(opts: {
  timeoutMs?: number;
  deep?: boolean;
}): Promise<StatusScanResult> {
  return await withProgress(
    {
      label: "Scanning status…",
      total: 9,
      enabled: true,
    },
    async (progress) => {
      const isDetailedScan = opts.deep === true;
      const overview = await collectStatusScanOverview({
        env: process.env,
        commandName: "status",
        opts,
        showSecrets: process.env.OPENCLAW_SHOW_SECRETS?.trim() !== "0",
        includeLiveChannelStatus: isDetailedScan,
        includeChannelSetupRuntimeFallback: isDetailedScan,
        fetchGitUpdate: isDetailedScan,
        includeRegistryUpdate: isDetailedScan,
        includeAdvertisedControlUiLinks: true,
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

      progress.setLabel("Checking memory and sessions…");
      const result = await executeStatusScanFromOverview({
        overview,
        resolveMemory: async () => null,
        channelIssues: overview.channelIssues,
        channels: overview.channels,
        pluginCompatibility: [],
      });
      progress.tick();

      progress.setLabel("Rendering…");
      progress.tick();

      return result;
    },
  );
}
