import type { GatewaySessionRow } from "../../api/types.ts";

function pathBasename(value: string): string {
  const trimmed = value.replace(/[\\/]+$/, "");
  return trimmed.split(/[\\/]/).pop() || trimmed;
}

export function resolveSessionWorkspace(params: {
  session: GatewaySessionRow | undefined;
  agentWorkspace?: string;
  worktreePath?: string | null;
}): { root: string | null; label: string | null } {
  const row = params.session;
  if (!row) {
    return { root: null, label: null };
  }
  if (row.repositoryWorkspaceId) {
    return {
      root: row.execNode ? row.execCwd?.trim() || null : null,
      label: row.repository ? pathBasename(row.repository.url).replace(/\.git$/u, "") : null,
    };
  }
  // Exec-node paths belong to that node. Mirror loadSessionFileRoot precedence;
  // an unresolved worktree must never borrow the agent's different checkout.
  const root = row.execNode
    ? row.execCwd?.trim() || null
    : row.spawnedWorkspaceDir?.trim() ||
      row.spawnedCwd?.trim() ||
      params.worktreePath?.trim() ||
      (!row.worktree ? params.agentWorkspace?.trim() : "") ||
      null;
  const label = row.worktree?.repoRoot
    ? pathBasename(row.worktree.repoRoot)
    : root
      ? pathBasename(root)
      : null;
  return { root, label };
}
