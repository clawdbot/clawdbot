// Agent-scoped session store discovery for per-agent hot reads.
import fsSync from "node:fs";
import path from "node:path";
import { normalizeAgentId } from "../../routing/session-key.js";
import { resolveStateDir } from "../paths.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveAgentsDirFromSessionStorePath, resolveSessionStorePathCore } from "./paths.js";
import { resolveSqliteTargetFromSessionStorePath } from "./session-sqlite-target.js";
import type { SessionStoreTarget } from "./targets-collision.js";
import {
  resolveValidatedManagedFilePathSync,
  shouldSkipDiscoveryError,
  shouldSkipDiscoveredAgentDirName,
} from "./targets-path-validation.js";

export function resolveValidatedDiscoveredStorePathSync(params: {
  sessionsDir: string;
  agentsRoot: string;
  realAgentsRoot?: string;
}): string | undefined {
  const storePath = path.join(params.sessionsDir, "sessions.json");
  const validatedStorePath = resolveValidatedManagedFilePathSync({
    agentsRoot: params.agentsRoot,
    filePath: storePath,
    realAgentsRoot: params.realAgentsRoot,
  });
  if (validatedStorePath) {
    return validatedStorePath;
  }
  const sqlitePath = resolveSqliteTargetFromSessionStorePath(storePath).path;
  if (!sqlitePath) {
    return undefined;
  }
  return resolveValidatedManagedFilePathSync({
    agentsRoot: params.agentsRoot,
    filePath: sqlitePath,
    realAgentsRoot: params.realAgentsRoot,
  })
    ? storePath
    : undefined;
}

export function toDiscoveredSessionStoreTarget(
  sessionsDir: string,
  storePath: string,
): SessionStoreTarget | undefined {
  const dirName = path.basename(path.dirname(sessionsDir));
  const agentId = normalizeAgentId(dirName);
  if (shouldSkipDiscoveredAgentDirName(dirName, agentId)) {
    return undefined;
  }
  return {
    agentId,
    // Keep the actual on-disk store path so retired/manual agent dirs remain discoverable
    // even if their directory name no longer round-trips through normalizeAgentId().
    storePath,
  };
}

/**
 * Resolves only the requested agent's on-disk store candidates under every discovery root.
 *
 * Per-agent store configs share one template, but a template may contain `{agentId}` before the
 * final `agents/<agentId>` segment (e.g. `/stores/{agentId}/agents/{agentId}/...`). Because
 * `resolveSessionStorePathCore` replaces every occurrence, each configured agent expansion can
 * resolve a distinct agents root. To preserve main's discovery contract, roots are derived from
 * every configured agent expansion plus the default state root — never just the requested agent.
 *
 * Discovery stays agent-scoped: other agent directories are filtered out by normalized id before
 * any file is statted, so one single-session read performs a constant number of filesystem checks
 * regardless of how many stores exist on disk. Directory-name aliases (e.g. "Retired Agent") stay
 * visible because the filter compares normalized ids rather than literal directory paths.
 */
export function resolveSameAgentDiscoveredSessionStoreTargetsSync(
  cfg: OpenClawConfig,
  requested: string,
  env: NodeJS.ProcessEnv,
  configuredAgentIds: string[] = [],
): SessionStoreTarget[] {
  const roots = new Set<string>();
  // Derive roots from every configured template expansion, not just the requested agent: a
  // template with `{agentId}` before the final `agents/<agentId>` segment yields one root per
  // configured agent, and an alternate same-agent store may live under another agent's root.
  const expansionIds = new Set<string>([requested, ...configuredAgentIds]);
  for (const agentId of expansionIds) {
    const templateRoot = resolveAgentsDirFromSessionStorePath(
      resolveSessionStorePathCore(cfg.session?.store, { agentId, env }),
    );
    if (templateRoot) {
      roots.add(templateRoot);
    }
  }
  roots.add(path.join(resolveStateDir(env), "agents"));
  const targets: SessionStoreTarget[] = [];
  for (const agentsDir of roots) {
    try {
      const realAgentsRoot = fsSync.realpathSync.native(agentsDir);
      const entries = fsSync.readdirSync(agentsDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const dirName = entry.name;
        const agentId = normalizeAgentId(dirName);
        if (shouldSkipDiscoveredAgentDirName(dirName, agentId) || agentId !== requested) {
          continue;
        }
        const sessionsDir = path.join(agentsDir, dirName, "sessions");
        const target = toDiscoveredSessionStoreTarget(
          sessionsDir,
          path.join(sessionsDir, "sessions.json"),
        );
        const validatedStorePath = resolveValidatedDiscoveredStorePathSync({
          sessionsDir,
          agentsRoot: agentsDir,
          realAgentsRoot,
        });
        if (target && validatedStorePath) {
          targets.push({ ...target, storePath: validatedStorePath });
        }
      }
    } catch (err) {
      if (shouldSkipDiscoveryError(err)) {
        continue;
      }
      throw err;
    }
  }
  return targets;
}
