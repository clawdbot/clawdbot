import { replaceConfigFile } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import type { RuntimeEnv } from "../../runtime.js";

export async function persistChannelPluginConfig(params: {
  cfg: OpenClawConfig;
  pluginInstalled: boolean;
  baseHash?: string;
  runtime: RuntimeEnv;
}): Promise<void> {
  const cfg = params.cfg;
  if (cfg.plugins?.installs && Object.keys(cfg.plugins.installs).length > 0) {
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: cfg,
      baseHash: params.baseHash,
    });
    await refreshPluginRegistryAfterConfigMutation({
      config: committed.config,
      reason: "source-changed",
      installRecords: committed.installRecords,
      logger: { warn: (message) => params.runtime.log(message) },
    });
    return;
  }

  await replaceConfigFile({
    nextConfig: cfg,
    baseHash: params.baseHash,
  });
  if (params.pluginInstalled) {
    await refreshPluginRegistryAfterConfigMutation({
      config: cfg,
      reason: "source-changed",
      logger: { warn: (message) => params.runtime.log(message) },
    });
  }
}
