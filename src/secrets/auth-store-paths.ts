/** Discovers auth-profile store paths that may contain secret refs. */
import fs from "node:fs";
import path from "node:path";
import {
  listAgentIds,
  resolveAgentConfig,
  resolveAgentDir,
  resolveDefaultAgentId,
} from "../agents/agent-scope.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

/**
 * Lists deduplicated auth-profile store agent dirs that may contain SecretRefs.
 * Covers implicit main, discovered state-dir agents, and config-declared agent dirs.
 */
export function listAuthProfileStoreAgentDirs(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  // Use the configured default agent instead of hard-coding "main" so deployments
  // that set `default: true` on a non-"main" agent resolve the correct store path.
  const defaultAgentId = resolveDefaultAgentId(config);
  paths.add(path.join(resolveUserPath(stateDir), "agents", defaultAgentId, "agent"));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent"));
    }
  }

  // Configured agent dirs may live outside stateDir; include them after state-dir discovery.
  // Agents with a custom agentDir resolve via resolveAgentDir (which honors that
  // override). Agents without one are scoped to the provided stateDir rather than
  // the ambient process env, mirroring the default-agent seed above so scans stay
  // confined to the requested state dir.
  for (const agentId of listAgentIds(config)) {
    const configuredDir = resolveAgentConfig(config, agentId)?.agentDir?.trim();
    if (configuredDir) {
      paths.add(resolveUserPath(resolveAgentDir(config, agentId)));
      continue;
    }
    paths.add(path.join(resolveUserPath(stateDir), "agents", agentId, "agent"));
  }

  return [...paths];
}
