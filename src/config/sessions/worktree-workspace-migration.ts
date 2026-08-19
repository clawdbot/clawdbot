import path from "node:path";
import { resolveAgentWorkspaceDir } from "../../agents/agent-scope.js";
import { listRegistryWorktreesForMigration } from "../../agents/worktrees/registry.js";
import { resolveProjectRegistry } from "../../projects/project-registry.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { listSessionEntriesReadOnly, patchSessionEntryCore } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveLegacyCanonicalWorkspace(params: {
  agentId: string;
  cfg: OpenClawConfig;
  entry: SessionEntry;
  env: NodeJS.ProcessEnv;
  sessionKey: string;
  worktrees: ReturnType<typeof listRegistryWorktreesForMigration>;
}): string | undefined {
  const worktree = params.entry.worktree;
  if (!worktree || worktree.canonicalWorkspaceDir) {
    return undefined;
  }
  const recordedRepoRoot = path.resolve(worktree.repoRoot);
  if (params.entry.projectId) {
    const project = resolveProjectRegistry(params.cfg, params.entry.projectId, { env: params.env });
    const projectRoot = project ? path.resolve(project.repoRoot) : undefined;
    return projectRoot && isInside(recordedRepoRoot, projectRoot) ? projectRoot : undefined;
  }
  const record = params.worktrees.find((candidate) => candidate.id === worktree.id);
  const spawnedCwd = params.entry.spawnedCwd;
  if (
    record?.ownerKind === "session" &&
    record.ownerId === params.sessionKey &&
    spawnedCwd &&
    path.resolve(record.repoRoot) === path.resolve(worktree.repoRoot)
  ) {
    const relative = path.relative(path.resolve(record.path), path.resolve(spawnedCwd));
    if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) {
      return path.resolve(recordedRepoRoot, relative);
    }
  }
  const agentWorkspace = path.resolve(
    resolveAgentWorkspaceDir(params.cfg, params.agentId, params.env),
  );
  return agentWorkspace && agentWorkspace === recordedRepoRoot ? agentWorkspace : undefined;
}

export async function migrateManagedWorktreeCanonicalWorkspaces(params: {
  agentId: string;
  cfg: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  storePath: string;
}): Promise<number> {
  const env = params.env ?? process.env;
  const worktrees = listRegistryWorktreesForMigration(env);
  let migrated = 0;
  for (const { entry, sessionKey } of listSessionEntriesReadOnly({
    agentId: params.agentId,
    env,
    storePath: params.storePath,
    readConsistency: "latest",
  })) {
    const canonicalWorkspaceDir = resolveLegacyCanonicalWorkspace({
      agentId: params.agentId,
      cfg: params.cfg,
      entry,
      env,
      sessionKey,
      worktrees,
    });
    if (!canonicalWorkspaceDir) {
      continue;
    }
    const updated = await patchSessionEntryCore(
      { agentId: params.agentId, env, sessionKey, storePath: params.storePath },
      (current) => {
        if (
          !current.worktree ||
          current.worktree.id !== entry.worktree?.id ||
          current.worktree.canonicalWorkspaceDir
        ) {
          return null;
        }
        return {
          worktree: { ...current.worktree, canonicalWorkspaceDir },
        };
      },
      { preserveActivity: true, skipMaintenance: true },
    );
    if (updated?.worktree?.canonicalWorkspaceDir === canonicalWorkspaceDir) {
      migrated += 1;
    }
  }
  return migrated;
}
