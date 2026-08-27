/** Discovers auth-profile store paths that may contain secret refs. */
import fs from "node:fs";
import path from "node:path";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSharedAuthStorePath } from "../agents/auth-profiles/path-resolve.js";
import { resolveAuthProfileDatabasePath } from "../agents/auth-profiles/sqlite.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

export type AuthProfileStoreTarget =
  | { kind: "shared"; path: string; env: NodeJS.ProcessEnv; stateDir: string }
  | { kind: "agent"; path: string; agentDir: string };

/** Lists canonical auth-profile databases that may contain SecretRefs. */
export function listAuthProfileStoreTargets(
  config: OpenClawConfig,
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
): AuthProfileStoreTarget[] {
  const targets = new Map<string, AuthProfileStoreTarget>();
  // Scope default auth store discovery to the provided stateDir instead of
  // ambient process env, so scans do not include unrelated host-global stores.
  const scopedEnv = {
    ...env,
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  };
  const addTarget = (target: AuthProfileStoreTarget) => {
    const key = path.resolve(target.path);
    if (targets.get(key)?.kind === "shared") {
      return;
    }
    targets.set(key, target);
  };
  addTarget({
    kind: "shared",
    path: resolveSharedAuthStorePath(scopedEnv),
    env: scopedEnv,
    stateDir,
  });

  const agentsRoot = path.join(resolveUserPath(stateDir, scopedEnv), "agents");
  if (fs.existsSync(agentsRoot)) {
    for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) {
        continue;
      }
      const agentDir = path.join(agentsRoot, entry.name, "agent");
      addTarget({ kind: "agent", agentDir, path: resolveAuthProfileDatabasePath(agentDir) });
    }
  }

  // Configured agent dirs may live outside stateDir; include them after state-dir discovery.
  for (const agentId of listAgentIds(config)) {
    const agentDir = resolveUserPath(resolveAgentDir(config, agentId, scopedEnv), scopedEnv);
    addTarget({ kind: "agent", agentDir, path: resolveAuthProfileDatabasePath(agentDir) });
  }

  return [...targets.values()];
}
