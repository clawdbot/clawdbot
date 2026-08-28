import fs from "node:fs";
import path from "node:path";
import { readNonBlankString } from "@openclaw/normalization-core/string-coerce";
import { listAgentIds, resolveAgentDir } from "../agents/agent-scope.js";
import { resolveSharedMainAuthAgentDir } from "../agents/auth-profiles/shared-main-dir.js";
import { resolveLegacyInheritedAuthAgentDir } from "../agents/legacy-inherited-auth-dir.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveUserPath } from "../utils.js";

function resolveLegacyAuthAgentDir(agentDir?: string): string {
  return agentDir ? resolveUserPath(agentDir) : resolveSharedMainAuthAgentDir();
}

export type AuthProfileRepairCandidate = {
  agentDir?: string;
  authPath: string;
};

function listExistingAgentDirsFromState(env: NodeJS.ProcessEnv): string[] {
  const root = path.join(resolveStateDir(env), "agents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return (
    entries
      // Symlinked state agent dirs must repair like real ones; statSync follows.
      .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
      .map((entry) => path.join(root, entry.name, "agent"))
      .filter((agentDir) => {
        try {
          return fs.statSync(agentDir).isDirectory();
        } catch {
          return false;
        }
      })
  );
}

/**
 * One canonical enumeration of legacy auth-store repair candidates. Sidecar
 * inline-recovery and flat-store SQLite migration must see the same dirs, or
 * decryptable sidecar secrets get imported as credential-less profiles.
 */
export function listAuthProfileRepairCandidates(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv,
): AuthProfileRepairCandidate[] {
  const candidates = new Map<string, AuthProfileRepairCandidate>();
  const addCandidate = (agentDir: string | undefined): void => {
    // Retain the selected home's expanded directory for later SQLite writes too.
    const resolvedAgentDir = agentDir ? resolveUserPath(agentDir, env) : undefined;
    const authPath = resolveLegacyAuthProfilesPath(
      resolvedAgentDir ?? resolveSharedMainAuthAgentDir(env),
    );
    const existing = candidates.get(authPath);
    // Shared-main owns aliases of its source; do not demote it to a per-agent import.
    if (!existing || agentDir === undefined) {
      candidates.set(authPath, { agentDir: resolvedAgentDir, authPath });
    }
  };
  // The shared-main default store (undefined agentDir) must stay first so the
  // canonical location wins the per-path dedupe over agent-scoped aliases.
  addCandidate(undefined);
  addCandidate(resolveLegacyInheritedAuthAgentDir(cfg, env));
  const envAgentDir =
    readNonBlankString(env.OPENCLAW_AGENT_DIR) ?? readNonBlankString(env.PI_CODING_AGENT_DIR);
  if (envAgentDir) {
    addCandidate(envAgentDir);
  }
  for (const agentId of listAgentIds(cfg)) {
    addCandidate(resolveAgentDir(cfg, agentId, env));
  }
  for (const agentDir of listExistingAgentDirsFromState(env)) {
    addCandidate(agentDir);
  }
  return [...candidates.values()];
}

export function resolveLegacyAuthProfilesPath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth-profiles.json");
}

export function resolveLegacyAuthStatePath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth-state.json");
}

export function resolveLegacyFlatAuthPath(agentDir?: string): string {
  return path.join(resolveLegacyAuthAgentDir(agentDir), "auth.json");
}
