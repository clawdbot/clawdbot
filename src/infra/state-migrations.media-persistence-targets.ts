import fs from "node:fs";
import path from "node:path";
import { resolveAgentSessionDirsFromAgentsDirSync } from "../agents/session-dirs.js";
import { resolveStateDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import {
  createOpenClawAgentDatabasePathMatcher,
  isPersistentOpenClawAgentDatabasePath,
  listOpenClawRegisteredAgentDatabases,
  unregisterOpenClawAgentDatabase,
} from "../state/openclaw-agent-db-registry.js";
import { isPathInside } from "./path-guards.js";

type AgentDatabaseMigrationTarget = {
  agentId: string;
  path: string;
  realPath: string;
  source: "configured" | "disk" | "registry";
};

type CandidateTarget = Omit<AgentDatabaseMigrationTarget, "realPath">;

function listDefaultAgentDatabaseTargets(
  env: NodeJS.ProcessEnv,
  warnings: string[],
): CandidateTarget[] {
  const agentsDir = path.join(resolveStateDir(env), "agents");
  try {
    return resolveAgentSessionDirsFromAgentsDirSync(agentsDir).map((sessionsDir) => {
      const agentDir = path.dirname(sessionsDir);
      return {
        agentId: normalizeAgentId(path.basename(agentDir)),
        path: path.join(agentDir, "agent", "openclaw-agent.sqlite"),
        source: "disk" as const,
      };
    });
  } catch (error) {
    warnings.push(`Could not enumerate agent databases under ${agentsDir}: ${String(error)}`);
    return [];
  }
}

export function resolveAgentDatabaseMigrationTargets(params: {
  changes: string[];
  configuredAgentDatabaseTargets: readonly { agentId: string; path: string }[];
  env: NodeJS.ProcessEnv;
  warnings: string[];
}): AgentDatabaseMigrationTarget[] {
  let registered: ReturnType<typeof listOpenClawRegisteredAgentDatabases> = [];
  try {
    registered = listOpenClawRegisteredAgentDatabases({
      env: params.env,
      includeIncompatibleSchemaVersions: true,
    });
  } catch (error) {
    params.warnings.push(
      `Failed enumerating registered agent databases for state migration: ${String(error)}`,
    );
  }
  // Owner authority is explicit config, then the recorded registry fact, then
  // directory-name inference. Recorded identity must beat a stale directory basename.
  const candidates: CandidateTarget[] = [
    ...params.configuredAgentDatabaseTargets.map((target) => ({
      agentId: target.agentId,
      path: target.path,
      source: "configured" as const,
    })),
    ...registered.map((entry) => ({
      agentId: entry.agentId,
      path: entry.path,
      source: "registry" as const,
    })),
    ...listDefaultAgentDatabaseTargets(params.env, params.warnings),
  ];
  const activeStateDir = resolveStateDir(params.env);
  let activeStateDirRealPath: string | undefined;
  try {
    activeStateDirRealPath = fs.realpathSync.native(activeStateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      params.warnings.push(
        `Could not resolve active state directory ${activeStateDir}: ${String(error)}`,
      );
    }
  }
  const configuredPathMatcher = createOpenClawAgentDatabasePathMatcher();
  const targets: AgentDatabaseMigrationTarget[] = [];
  const seenRealPaths = new Set<string>();
  for (const candidate of candidates) {
    // Preserve the original locator: lexical normalization of `link/../file`
    // can select a different file than filesystem symlink traversal does.
    const pathname = candidate.path;
    if (!isPersistentOpenClawAgentDatabasePath(pathname, params.env)) {
      if (candidate.source === "registry") {
        unregisterOpenClawAgentDatabase({
          agentId: candidate.agentId,
          env: params.env,
          path: candidate.path,
        });
        params.changes.push(
          `Removed archived or transient agent database registry entry ${pathname}.`,
        );
      }
      continue;
    }
    let realPath: string | undefined;
    try {
      realPath = fs.realpathSync.native(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        params.warnings.push(`Could not resolve agent database ${pathname}: ${String(error)}`);
      }
    }
    const isConfiguredPath = params.configuredAgentDatabaseTargets.some((configuredTarget) => {
      if (normalizeAgentId(configuredTarget.agentId) !== normalizeAgentId(candidate.agentId)) {
        return false;
      }
      try {
        return configuredPathMatcher(pathname, configuredTarget.path);
      } catch {
        return false;
      }
    });
    const isInsideActiveStateDir = Boolean(
      realPath &&
      activeStateDirRealPath &&
      (realPath === activeStateDirRealPath || isPathInside(activeStateDirRealPath, realPath)),
    );
    if (realPath && !isInsideActiveStateDir && !isConfiguredPath) {
      if (candidate.source === "registry") {
        unregisterOpenClawAgentDatabase({
          agentId: candidate.agentId,
          env: params.env,
          path: candidate.path,
        });
      }
      params.warnings.push(
        `Skipped foreign agent database ${pathname}; it is outside the active state directory and is not a configured session store.`,
      );
      continue;
    }
    let stat: fs.Stats | undefined;
    try {
      stat = fs.statSync(pathname);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        params.warnings.push(
          `Could not inspect ${candidate.source === "registry" ? "registered " : ""}agent database ${pathname}: ${String(error)}`,
        );
        continue;
      }
    }
    if (!stat?.isFile()) {
      if (candidate.source === "registry") {
        unregisterOpenClawAgentDatabase({
          agentId: candidate.agentId,
          env: params.env,
          path: candidate.path,
        });
        params.changes.push(`Removed missing agent database registry entry ${pathname}.`);
        params.warnings.push(`Skipped missing registered agent database ${pathname}.`);
      }
      continue;
    }
    if (!realPath) {
      if (candidate.source === "registry") {
        unregisterOpenClawAgentDatabase({
          agentId: candidate.agentId,
          env: params.env,
          path: candidate.path,
        });
      }
      params.warnings.push(
        `Skipped agent database ${pathname}; its filesystem boundary is unresolved.`,
      );
      continue;
    }
    if (seenRealPaths.has(realPath)) {
      continue;
    }
    // Claim identity only after every persistence, boundary, and file gate passed.
    seenRealPaths.add(realPath);
    targets.push({ ...candidate, path: pathname, realPath });
  }
  return targets;
}
