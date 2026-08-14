import type { SessionCatalogSession } from "../../../../packages/gateway-protocol/src/index.ts";

export type CatalogProjectGrouping = "project" | "person" | "none";

export function normalizeCatalogProjectGrouping(raw: unknown): CatalogProjectGrouping {
  return raw === "none" || raw === "person" ? raw : "project";
}

/**
 * The repository a working directory belongs to, or nothing when the path says
 * nothing useful. Every surface that groups by project has to agree on this, or
 * one checkout ends up as two projects under two headings.
 *
 * Accepted tradeoff: filesystem-root paths are not real session roots and fall
 * to the flat tail by design. A path at or under `.claude/worktrees/<name>`
 * folds into its origin repo, matching Claude Code desktop; the lazy prefix
 * picks the outermost repo root.
 */
export function resolveProjectRoot(path: string | undefined): string | undefined {
  const trimmed = path?.trim().replace(/[\\/]+$/, "");
  if (!trimmed) {
    return undefined;
  }
  const worktreeMatch = trimmed.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/);
  return worktreeMatch?.[1] || trimmed;
}

/**
 * Section id a Coding project heading collapses under. It is shared so the
 * renderer that folds the group and the projection that decides which rows are
 * visible cannot disagree about which id they are talking about.
 */
export function workProjectSectionId(projectPath: string): string {
  return `work-project:${projectPath}`;
}

/** Folder name a project heading shows for a repository path. */
export function projectRootLabel(projectPath: string): string {
  return projectPath.split(/[\\/]/).at(-1) || projectPath;
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
  // Custom groups are collected separately so they sort ahead of project groups
  // regardless of session order; interleaving by first-seen would make section
  // order depend on the roster's sort.
  const customGroups: CatalogProjectGroup[] = [];
  const projectGroups: CatalogProjectGroup[] = [];
  const groupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    const customGroup = session.customGroup?.trim();
    if (customGroup) {
      const key = `custom:${customGroup}`;
      let group = groupsByPath.get(key);
      if (!group) {
        group = {
          key,
          label: customGroup,
          title: `Custom group: ${customGroup}`,
          sessions: [],
        };
        groupsByPath.set(key, group);
        customGroups.push(group);
      }
      group.sessions.push(session);
      continue;
    }
    const projectPath = resolveProjectRoot(session.cwd);
    if (!projectPath) {
      ungrouped.push(session);
      continue;
    }
    let group = groupsByPath.get(projectPath);
    if (!group) {
      group = {
        key: projectPath,
        label: projectRootLabel(projectPath),
        title: projectPath,
        sessions: [],
      };
      groupsByPath.set(projectPath, group);
      projectGroups.push(group);
    }
    group.sessions.push(session);
  }

  return { groups: [...customGroups, ...projectGroups], ungrouped };
}

/** Groups adopted sessions by their creator identity. Native threads only carry
    `createdActor` once adopted (the gateway strips provider-supplied actors), so
    unattributed sessions intentionally fall to the flat ungrouped tail. */
export function groupCatalogSessionsByPerson(sessions: readonly SessionCatalogSession[]): {
  groups: CatalogProjectGroup[];
  ungrouped: SessionCatalogSession[];
} {
  const groupsById = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    const actor = session.createdActor;
    if (!actor?.id) {
      ungrouped.push(session);
      continue;
    }
    const key = `person:${actor.id}`;
    let group = groupsById.get(key);
    if (!group) {
      const label = actor.label?.trim() || actor.id;
      group = { key, label, title: `Created by ${label}`, sessions: [] };
      groupsById.set(key, group);
    }
    group.sessions.push(session);
  }

  // Label order keeps the section stable regardless of roster sort.
  const groups = [...groupsById.values()].toSorted((a, b) => a.label.localeCompare(b.label));
  return { groups, ungrouped };
}
