/** Discovers auth-profile store paths that may contain secret refs. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

type AuthProfileStoreTarget = { agentDir?: string; path: string };

/** Lists canonical auth-profile databases that may contain SecretRefs. */
export function listAuthProfileStoreTargets(
  config: OpenClawConfig,
  stateDir: string,
): AuthProfileStoreTarget[] {
  const targets = new Map<string, AuthProfileStoreTarget>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  const scopedEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  const addTarget = (agentDir?: string) => {
    const pathname = agentDir
      ? resolveAuthProfileDatabasePath(agentDir)
      : resolveSharedAuthStorePath(scopedEnv);
    targets.set(path.resolve(pathname), { ...(agentDir ? { agentDir } : {}), path: pathname });
  };
  addTarget();

  const agentsRoot = path.join(resolveUserPath(stateDir), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      addTarget(path.join(agentsRoot, entry.name, "agent"));
    }
  }

  // Configured agent dirs may live outside stateDir; include them after state-dir discovery.
  for (const agentId of listAgentIds(config)) {
    addTarget(resolveUserPath(resolveAgentDir(config, agentId)));
  }

  return [...targets.values()];
}
