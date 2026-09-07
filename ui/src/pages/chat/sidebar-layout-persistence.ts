import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeSidebarLayout } from "./sidebar-layout-normalize.ts";
import type { SidebarLayout } from "./sidebar-layout.ts";

export type SidebarSessionLayouts = Record<string, SidebarLayout>;
export type SidebarSessionActivePanels = Record<string, string>;

const MAX_SIDEBAR_SESSION_LAYOUTS = 50;

export function normalizeSidebarSessionLayouts(value: unknown): SidebarSessionLayouts {
  const layouts: SidebarSessionLayouts = {};
  for (const [sessionKey, rawLayout] of Object.entries(asNonArrayRecord(value)).slice(
    -MAX_SIDEBAR_SESSION_LAYOUTS,
  )) {
    const key = sessionKey.trim();
    if (!key) {
      continue;
    }
    layouts[key] = normalizeSidebarLayout(rawLayout);
  }
  return layouts;
}

export function updateSidebarSessionLayout(
  current: SidebarSessionLayouts | undefined,
  sessionKey: string,
  layout: SidebarLayout,
): SidebarSessionLayouts {
  const key = sessionKey.trim();
  const layouts = normalizeSidebarSessionLayouts(current);
  if (!key) {
    return layouts;
  }
  delete layouts[key];
  layouts[key] = normalizeSidebarLayout(layout);
  return Object.fromEntries(Object.entries(layouts).slice(-MAX_SIDEBAR_SESSION_LAYOUTS));
}

export function normalizeSidebarSessionActivePanels(value: unknown): SidebarSessionActivePanels {
  const selections: SidebarSessionActivePanels = {};
  for (const [sessionKey, panelId] of Object.entries(asNonArrayRecord(value)).slice(
    -MAX_SIDEBAR_SESSION_LAYOUTS,
  )) {
    const key = sessionKey.trim();
    const id = typeof panelId === "string" ? panelId.trim() : "";
    if (key && id) {
      selections[key] = id;
    }
  }
  return selections;
}

export function updateSidebarSessionActivePanel(
  current: SidebarSessionActivePanels | undefined,
  sessionKey: string,
  panelId: string,
): SidebarSessionActivePanels {
  const key = sessionKey.trim();
  const id = panelId.trim();
  const selections = normalizeSidebarSessionActivePanels(current);
  if (!key || !id) {
    return selections;
  }
  delete selections[key];
  selections[key] = id;
  return Object.fromEntries(Object.entries(selections).slice(-MAX_SIDEBAR_SESSION_LAYOUTS));
}
