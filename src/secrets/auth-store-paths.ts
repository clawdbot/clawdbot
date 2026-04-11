import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveAuthStorePath } from "../agents/auth-profiles/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

export function listAuthProfileStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  const paths = new Set<string>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  paths.add(path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"));

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      paths.add(path.join(agentsRoot, entry.name, "agent", "auth-profiles.json"));
    }
  }

  for (const agentId of listAgentIds(config)) {
    if (agentId === "main") {
      paths.add(
        path.join(resolveUserPath(stateDir), "agents", "main", "agent", "auth-profiles.json"),
      );
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(resolveAuthStorePath(agentDir)));
  }

  return [...paths];
}

export function collectAuthStorePaths(config: OpenClawConfig, stateDir: string): string[] {
  return listAuthProfileStorePaths(config, stateDir);
}
