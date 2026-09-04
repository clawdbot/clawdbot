import { isRecord } from "@openclaw/normalization-core";
import type { SidebarLayout, SidebarPanel, SidebarSlotId } from "./sidebar-layout-types.ts";

const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 360;
const MIN_WIDTH = 260;
const MIN_HEIGHT = 220;
const MAX_WIDTH = 1_200;
const MAX_HEIGHT = 800;

function normalizeSlotId(value: unknown): SidebarSlotId | null {
  // Stable releases persisted dashboard panels as `chat`; normalize that
  // storage contract here so upgrades retain the selected panel and layout.
  if (value === "chat") {
    return "dashboard";
  }
  return value === "browser" ||
    value === "companion" ||
    value === "conversation" ||
    value === "dashboard" ||
    value === "desktop" ||
    value === "detail" ||
    value === "discussion" ||
    value === "tasks" ||
    value === "terminal" ||
    value === "workspace"
    ? value
    : null;
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
}

function clampHeight(height: number): number {
  return Math.min(MAX_HEIGHT, Math.max(MIN_HEIGHT, height));
}

function uniqueId(value: unknown, fallback: string, used: Set<string>): string {
  const base = typeof value === "string" && value.trim() ? value.trim() : fallback;
  let id = base;
  let suffix = 2;
  while (used.has(id)) {
    id = `${base}-${suffix++}`;
  }
  used.add(id);
  return id;
}

export function normalizeSidebarLayout(value: unknown): SidebarLayout {
  if (!isRecord(value) || !Array.isArray(value.columns)) {
    return { columns: [], open: false, expanded: false };
  }
  const usedColumnIds = new Set<string>();
  const usedPanelIds = new Set<string>();
  const usedSlots = new Set<SidebarSlotId>();
  const panels: SidebarPanel[] = [];
  const panelIdsBySource = new Map<string, string>();
  let activePanelId = "";
  let width = DEFAULT_WIDTH;
  let height = DEFAULT_HEIGHT;
  for (const rawColumn of value.columns) {
    if (
      !isRecord(rawColumn) ||
      (rawColumn.side !== "left" && rawColumn.side !== "right") ||
      !Array.isArray(rawColumn.panels)
    ) {
      continue;
    }
    uniqueId(rawColumn.id, "column", usedColumnIds);
    const columnPanels: SidebarPanel[] = [];
    const panelIds = new Map<string, string>();
    for (const rawPanel of rawColumn.panels) {
      if (!isRecord(rawPanel)) {
        continue;
      }
      const slot = normalizeSlotId(rawPanel.slot);
      if (!slot || usedSlots.has(slot)) {
        continue;
      }
      const rawPanelId = typeof rawPanel.id === "string" ? rawPanel.id.trim() : "";
      const panelId = uniqueId(rawPanel.id, slot, usedPanelIds);
      const sourceId = rawPanelId || (rawPanel.slot === "chat" ? "chat" : slot);
      if (!panelIds.has(sourceId)) {
        panelIds.set(sourceId, panelId);
      }
      if (!panelIdsBySource.has(sourceId)) {
        panelIdsBySource.set(sourceId, panelId);
      }
      usedSlots.add(slot);
      columnPanels.push({ id: panelId, slot });
    }
    const requestedActiveId =
      typeof rawColumn.activePanelId === "string" ? rawColumn.activePanelId.trim() : "";
    activePanelId = panelIds.get(requestedActiveId) ?? activePanelId;
    width =
      typeof rawColumn.width === "number" && Number.isFinite(rawColumn.width)
        ? clampWidth(rawColumn.width)
        : width;
    height =
      typeof rawColumn.height === "number" && Number.isFinite(rawColumn.height)
        ? clampHeight(rawColumn.height)
        : height;
    panels.push(...columnPanels);
  }
  const requestedMainId =
    typeof value.mainPanelId === "string" ? value.mainPanelId.trim() : undefined;
  let mainPanelId = requestedMainId ? panelIdsBySource.get(requestedMainId) : undefined;
  let conversation = panels.find((panel) => panel.slot === "conversation");
  // Legacy expansion only hid chat while the side panel was open. A minimized
  // panel must not displace chat just because its old expanded flag was retained.
  if (value.mainPanelId === undefined && value.expanded === true && value.open !== false) {
    mainPanelId = panels.find((panel) => panel.id === activePanelId)?.id ?? panels[0]?.id;
  }
  if (mainPanelId || conversation || requestedMainId !== undefined || value.expanded === true) {
    if (!conversation) {
      conversation = {
        id: uniqueId("conversation", "conversation", usedPanelIds),
        slot: "conversation",
      };
      panels.push(conversation);
    }
    mainPanelId ??= conversation.id;
    if (!panels.some((panel) => panel.id === activePanelId && panel.id !== mainPanelId)) {
      activePanelId =
        conversation.id !== mainPanelId
          ? conversation.id
          : (panels.find((panel) => panel.id !== mainPanelId)?.id ?? "");
    }
  }
  const columns =
    usedColumnIds.size > 0 || panels.length > 0 || value.open === true
      ? [
          {
            id: usedColumnIds.values().next().value ?? "side-panel-column",
            side: "right" as const,
            panels,
            activePanelId: panels.some(
              (panel) => panel.id === activePanelId && panel.id !== mainPanelId,
            )
              ? activePanelId
              : (panels.find((panel) => panel.id !== mainPanelId)?.id ?? ""),
            height,
            width,
          },
        ]
      : [];
  return {
    columns,
    ...(mainPanelId ? { mainPanelId } : {}),
    dock: value.dock === "bottom" || value.dock === "left" ? value.dock : "right",
    open: typeof value.open === "boolean" ? value.open : columns.length > 0,
    expanded: value.expanded === true,
  };
}
