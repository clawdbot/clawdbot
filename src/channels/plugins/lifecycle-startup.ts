/** Invokes optional startup maintenance for loaded channel plugins. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { listLoadedChannelPlugins } from "./registry-loaded.js";
import type { ChannelPlugin } from "./types.plugin.js";

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
  for (const plugin of listLoadedChannelPlugins() as ChannelPlugin[]) {
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
