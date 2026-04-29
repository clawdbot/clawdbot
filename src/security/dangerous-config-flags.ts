import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  collectPluginConfigContractMatches,
  resolvePluginConfigContractsById,
} from "../plugins/config-contracts.js";
import { isRecord } from "../utils.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";

export function collectEnabledInsecureOrDangerousFlags(cfg: OpenClawConfig): string[] {
  const pluginEntries = cfg.plugins?.entries;
  if (!isRecord(pluginEntries)) {
    return collectEnabledInsecureOrDangerousFlagsFromContracts(cfg);
  }

  const configContracts = resolvePluginConfigContractsById({
    config: cfg,
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
    env: process.env,
    pluginIds: Object.keys(pluginEntries),
  });
  return collectEnabledInsecureOrDangerousFlagsFromContracts(cfg, {
    collectPluginConfigContractMatches,
    configContractsById: configContracts,
  });
}
