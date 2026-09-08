import type {
  SessionCatalogSession,
  SessionCreatedActor,
} from "../../../../packages/gateway-protocol/src/index.ts";
import { presenceViewerLabel } from "../presence-users.ts";

export type CatalogProjectGrouping = "project" | "person" | "none";

export function normalizeCatalogProjectGrouping(raw: unknown): CatalogProjectGrouping {
  return raw === "none" || raw === "person" ? raw : "project";
}

// Sidebar, table, and catalog groups share keys from projected identities;
// raw actor ids can alias profiles or collide across identity namespaces.
export function sessionActorGroupId(owner: SessionCreatedActor | undefined): string {
  const identity = owner?.identity;
  if (!identity) {
    return "";
  }
  return identity.type === "profile" || identity.type === "agent"
    ? `${identity.type}:${identity.id}`
    : JSON.stringify(identity, Object.keys(identity).toSorted());
}

// Canonicalize a checkout path for grouping: strip trailing separators so
// `/repo` and `/repo/` key one section, then mirror Claude Code desktop by
// folding any cwd at or under `.claude/worktrees/<name>` into the origin repo
// (the lazy prefix picks the outermost repo root). Returns null for separator-only
// paths or worktrees with no origin repo.
export function foldWorktreeCheckoutPath(path: string): string | null {
  const trimmed = path.replace(/[\\/]+$/, "");
  if (!trimmed) {
    return null;
  }
  const match = trimmed.match(/^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/]/);
  return match ? match[1] || null : trimmed;
}

/** Basename shown for a checkout path in project sections. */
export function checkoutDisplayName(path: string): string {
  return path.split(/[\\/]/).findLast(Boolean) ?? path;
}

type CatalogProjectGroup = {
  kind: "custom" | "project" | "person";
  key: string;
  // Collapse ids predate the group-kind namespace. Read the old suffix until
  // the next toggle migrates that section to its canonical id.
  legacySectionKey?: string;
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
  const customGroupsByName = new Map<string, CatalogProjectGroup>();
  const projectGroupsByPath = new Map<string, CatalogProjectGroup>();
  const ungrouped: SessionCatalogSession[] = [];

  for (const session of sessions) {
    const customGroup = session.customGroup?.trim();
    if (customGroup) {
      const key = `custom:${customGroup}`;
      let group = customGroupsByName.get(customGroup);
      if (!group) {
        group = {
          kind: "custom",
          key,
          legacySectionKey: key,
          label: customGroup,
          title: `Custom group: ${customGroup}`,
          sessions: [],
        };
        customGroupsByName.set(customGroup, group);
        customGroups.push(group);
      }
      group.sessions.push(session);
      continue;
    }
    // Paths without a project identity fall to the ungrouped flat tail;
    // do not invent a project name when canonicalization returns no origin.
    const trimmedPath = session.cwd?.trim();
    const projectPath = trimmedPath ? foldWorktreeCheckoutPath(trimmedPath) : null;
    if (!projectPath) {
      ungrouped.push(session);
      continue;
    }
    let group = projectGroupsByPath.get(projectPath);
    if (!group) {
      group = {
        kind: "project",
        key: `project:${projectPath}`,
        legacySectionKey: projectPath,
        label: checkoutDisplayName(projectPath),
        title: projectPath,
        sessions: [],
      };
      projectGroupsByPath.set(projectPath, group);
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
    const actorGroupId = sessionActorGroupId(actor);
    if (!actor?.identity || !actorGroupId) {
      ungrouped.push(session);
      continue;
    }
    const key = `person:${actorGroupId}`;
    let group = groupsById.get(key);
    if (!group) {
      const label =
        actor.identity.type === "profile"
          ? presenceViewerLabel({
              id: actor.identity.id,
              name: actor.label?.trim() || actor.identity.id,
            })
          : actor.label?.trim() || actor.identity.id;
      group = {
        kind: "person",
        key,
        legacySectionKey: `person:${actor.id}`,
        label,
        title: `Created by ${label}`,
        sessions: [],
      };
      groupsById.set(key, group);
    }
    group.sessions.push(session);
  }

  // Label order keeps the section stable regardless of roster sort.
  const groups = [...groupsById.values()].toSorted((a, b) => a.label.localeCompare(b.label));
  return { groups, ungrouped };
}
