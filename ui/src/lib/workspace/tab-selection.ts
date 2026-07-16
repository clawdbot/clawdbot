import type { WorkspaceDocument, WorkspaceTab, WorkspaceWidgetStatus } from "./types.ts";

/** The `custom:<name>` widget name, or null for builtin/unknown kinds. */
export function customWidgetName(kind: string): string | null {
  return kind.startsWith("custom:") ? kind.slice("custom:".length) || null : null;
}

/** Registry status for a custom widget kind, or null when not a tracked custom widget. */
export function customWidgetStatus(
  workspace: WorkspaceDocument,
  kind: string,
): WorkspaceWidgetStatus | null {
  const name = customWidgetName(kind);
  if (!name) {
    return null;
  }
  return workspace.widgetsRegistry[name]?.status ?? null;
}

/**
 * Tabs in display order: honor `prefs.tabOrder` first, then any doc-order tabs the
 * ordering omits, so a partial `tabOrder` still shows every tab.
 */
export function orderedTabs(workspace: WorkspaceDocument): WorkspaceTab[] {
  const bySlug = new Map(workspace.tabs.map((tab) => [tab.slug, tab]));
  const ordered: WorkspaceTab[] = [];
  const seen = new Set<string>();
  for (const slug of workspace.prefs.tabOrder) {
    const tab = bySlug.get(slug);
    if (tab && !seen.has(slug)) {
      ordered.push(tab);
      seen.add(slug);
    }
  }
  for (const tab of workspace.tabs) {
    if (!seen.has(tab.slug)) {
      ordered.push(tab);
      seen.add(tab.slug);
    }
  }
  return ordered;
}

export function visibleTabs(workspace: WorkspaceDocument): WorkspaceTab[] {
  return orderedTabs(workspace).filter((tab) => !tab.hidden);
}

export function hiddenTabs(workspace: WorkspaceDocument): WorkspaceTab[] {
  return orderedTabs(workspace).filter((tab) => tab.hidden);
}

export function findTab(
  workspace: WorkspaceDocument,
  slug: string | null,
): WorkspaceTab | undefined {
  if (!slug) {
    return undefined;
  }
  return workspace.tabs.find((tab) => tab.slug === slug);
}

/** Resolve the requested tab or the first available fallback. */
export function resolveActiveSlug(
  workspace: WorkspaceDocument,
  requested: string | null,
): string | null {
  const requestedTab = findTab(workspace, requested);
  if (requestedTab) {
    return requestedTab.slug;
  }
  const firstVisible = visibleTabs(workspace)[0];
  return firstVisible?.slug ?? orderedTabs(workspace)[0]?.slug ?? null;
}
