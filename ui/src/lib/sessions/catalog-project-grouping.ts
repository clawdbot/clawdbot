import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";

export type CatalogProjectGrouping = "project" | "none";

export function normalizeCatalogProjectGrouping(raw: unknown): CatalogProjectGrouping {
  return raw === "none" ? "none" : "project";
}

type CatalogProjectGroup = {
  key: string;
  label: string;
  title: string;
  sessions: SessionCatalogSession[];
};

export function groupCatalogSessionsByProject(sessions: readonly SessionCatalogSession[]): {
  groups: CatalogProjectGroup[];
  ungrouped: SessionCatalogSession[];
} {
  const groups: CatalogProjectGroup[] = [];
  const groupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    // Accepted tradeoff: filesystem-root cwds ("/", "C:\") are not real harness
    // session roots; after trimming they fall to the ungrouped flat tail by design.
    let projectPath = session.cwd?.trim().replace(/[\\/]+$/, "");
    if (!projectPath) {
      ungrouped.push(session);
      continue;
    }
    // Mirror Claude Code desktop: any cwd at or under `.claude/worktrees/<name>`
    // folds into the origin repo; the lazy prefix picks the outermost repo root.
    const worktreeMatch = projectPath.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/);
    projectPath = worktreeMatch?.[1] ?? projectPath;
    if (!projectPath) {
      ungrouped.push(session);
      continue;
    }
    let group = groupsByPath.get(projectPath);
    if (!group) {
      group = {
        key: projectPath,
        label: projectPath.split(/[\\/]/).at(-1) || projectPath,
        title: projectPath,
        sessions: [],
      };
      groupsByPath.set(projectPath, group);
      groups.push(group);
    }
    group.sessions.push(session);
  }

  return { groups, ungrouped };
}
