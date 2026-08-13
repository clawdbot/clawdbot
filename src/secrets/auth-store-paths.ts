/** Discovers auth-profile store paths that may contain secret refs. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
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
  const scopedEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  paths.add(path.dirname(resolveSharedAuthStorePath(scopedEnv)));

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
  for (const agentId of listAgentIds(config)) {
    if (agentId === "main") {
      paths.add(path.dirname(resolveSharedAuthStorePath(scopedEnv)));
      continue;
    }
    const agentDir = resolveAgentDir(config, agentId);
    paths.add(resolveUserPath(agentDir));
  }

  return [...paths];
}
