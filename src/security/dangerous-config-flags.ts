// Collects dangerous config flag findings across agents and runtime config.
import {
  listAgentEntries,
  resolveAgentConfig,
  resolveAgentWorkspaceDir,
  tryResolveDefaultAgentId,
} from "../agents/agent-scope.js";
import { resolveDefaultAgentWorkspaceDir } from "../agents/workspace-default.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { collectPluginConfigContractMatches } from "../plugins/config-contract-matches.js";
import { resolvePluginConfigContractsById } from "../plugins/config-contracts.js";
import { isRecord, resolveUserPath } from "../utils.js";
import { collectEnabledInsecureOrDangerousFlagsFromContracts } from "./dangerous-config-flags-core.js";
import { collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot } from "./dangerous-config-flags-current.js";

/**
 * Collect enabled insecure/dangerous config flags for audit and startup warnings.
 * Plugin flags use current metadata when requested, then fall back to resolving manifest contracts.
 */
export function collectEnabledInsecureOrDangerousFlags(
  cfg: OpenClawConfig,
  options: { preferCurrentPluginMetadataSnapshot?: boolean } = {},
): string[] {
  const pluginEntries = cfg.plugins?.entries;
  if (!isRecord(pluginEntries)) {
    return collectEnabledInsecureOrDangerousFlagsFromContracts(cfg);
  }
  const pluginIds = Object.keys(pluginEntries);

  if (options.preferCurrentPluginMetadataSnapshot) {
    const currentSnapshotFlags = collectEnabledInsecureOrDangerousFlagsFromCurrentSnapshot(cfg);
    if (currentSnapshotFlags) {
      return currentSnapshotFlags;
    }
  }

  const defaultAgentId = tryResolveDefaultAgentId(cfg);
  const workspaceDirs = new Set<string | undefined>();
  if (defaultAgentId) {
    workspaceDirs.add(resolveAgentWorkspaceDir(cfg, defaultAgentId));
  } else {
    const roster = listAgentEntries(cfg);
    if (roster.length === 0) {
      const configuredWorkspace = cfg.agents?.defaults?.workspace?.trim();
      workspaceDirs.add(
        configuredWorkspace
          ? resolveUserPath(configuredWorkspace, process.env)
          : resolveDefaultAgentWorkspaceDir(process.env),
      );
    } else {
      let hasInheritedWorkspace = false;
      for (const entry of roster) {
        const workspace = resolveAgentConfig(cfg, entry.id)?.workspace?.trim();
        if (workspace) {
          workspaceDirs.add(resolveUserPath(workspace, process.env));
        } else {
          hasInheritedWorkspace = true;
        }
      }
      if (hasInheritedWorkspace) {
        const inheritedWorkspace = cfg.agents?.defaults?.workspace?.trim();
        workspaceDirs.add(
          inheritedWorkspace
            ? resolveUserPath(inheritedWorkspace, process.env)
            : resolveDefaultAgentWorkspaceDir(process.env),
        );
      }
    }
  }

  const flags = new Set<string>();
  for (const workspaceDir of workspaceDirs) {
    const configContracts = resolvePluginConfigContractsById({
      config: cfg,
      ...(workspaceDir ? { workspaceDir } : {}),
      env: process.env,
      pluginIds,
    });
    for (const flag of collectEnabledInsecureOrDangerousFlagsFromContracts(cfg, {
      collectPluginConfigContractMatches,
      configContractsById: configContracts,
    })) {
      flags.add(flag);
    }
  }
  return [...flags];
}
