import type { ResolvedAcpxPluginConfig } from "./config.js";

export async function prepareAcpxCodexAuthConfig(params: {
  pluginConfig: ResolvedAcpxPluginConfig;
  stateDir: string;
  logger?: unknown;
}): Promise<ResolvedAcpxPluginConfig> {
  void params.stateDir;
  void params.logger;
  return params.pluginConfig;
}
