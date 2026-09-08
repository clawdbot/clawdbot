import type { ConfigWriteOptions } from "../../config/io.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import type { RuntimeEnv } from "../../runtime.js";

export async function persistChannelPluginConfig(params: {
  cfg: OpenClawConfig;
  pluginInstalled: boolean;
  baseHash?: string;
  writeOptions?: ConfigWriteOptions;
  runtime: RuntimeEnv;
}): Promise<void> {
  const committed = await commitConfigWithPendingPluginInstalls({
    sourceConfig: params.cfg,
    baseHash: params.baseHash,
    writeOptions: params.writeOptions,
  });
  if (committed.movedInstallRecords || params.pluginInstalled) {
    await refreshPluginRegistryAfterConfigMutation({
      reason: "source-changed",
      ...(committed.movedInstallRecords ? { installRecords: committed.installRecords } : {}),
      logger: { warn: (message) => params.runtime.log(message) },
    });
  }
}
