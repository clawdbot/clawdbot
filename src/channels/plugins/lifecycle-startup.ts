/**
 * Channel plugin startup maintenance runner.
 *
 * Invokes optional plugin lifecycle hooks without blocking unrelated channels.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listChannelPlugins } from "./registry.js";

type ChannelStartupLogger = {
  info?: (message: string) => void;
  warn?: (message: string) => void;
};

/**
 * Runs startup maintenance hooks for all loaded channel plugins.
 */
export async function runChannelPluginStartupMaintenance(params: {
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  log: ChannelStartupLogger;
  trigger?: string;
  logPrefix?: string;
}): Promise<void> {
  for (const plugin of listChannelPlugins()) {
    const runStartupMaintenance = plugin.lifecycle?.runStartupMaintenance;
    if (!runStartupMaintenance) {
      continue;
    }
    try {
      await runStartupMaintenance(params);
    } catch (err) {
      // Startup maintenance is best-effort. One channel failing repair or
      // cleanup must not stop the gateway from starting other channel plugins.
      params.log.warn?.(
        `${params.logPrefix?.trim() || "gateway"}: ${plugin.id} startup maintenance failed; continuing: ${String(err)}`,
      );
    }
  }
}
