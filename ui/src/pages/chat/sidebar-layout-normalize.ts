import { isRecord } from "@openclaw/normalization-core";
import type {
  SidebarColumn,
  SidebarLayout,
  SidebarPanel,
  SidebarSlotId,
} from "./sidebar-layout-types.ts";

const DEFAULT_WIDTH = 360;
const CHAT_DEFAULT_WIDTH = 480;
const MIN_WIDTH = 260;
const MAX_WIDTH = 1_200;

function isSlotId(value: unknown): value is SidebarSlotId {
  return value === "chat" || value === "discussion" || value === "detail";
}

function clampWidth(width: number): number {
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, width));
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
    return { columns: [] };
  }
  const usedColumnIds = new Set<string>();
  const usedPanelIds = new Set<string>();
  const usedSlots = new Set<SidebarSlotId>();
  const columns: SidebarColumn[] = [];
  for (const rawColumn of value.columns) {
    if (
      !isRecord(rawColumn) ||
      (rawColumn.side !== "left" && rawColumn.side !== "right") ||
      !Array.isArray(rawColumn.panels)
    ) {
      continue;
    }
    const columnId = uniqueId(rawColumn.id, "column", usedColumnIds);
    const panels: SidebarPanel[] = [];
    const panelIds = new Map<string, string>();
    for (const rawPanel of rawColumn.panels) {
      if (!isRecord(rawPanel) || !isSlotId(rawPanel.slot) || usedSlots.has(rawPanel.slot)) {
        continue;
      }
      const rawPanelId = typeof rawPanel.id === "string" ? rawPanel.id.trim() : "";
      const panelId = uniqueId(rawPanel.id, rawPanel.slot, usedPanelIds);
      const sourceId = rawPanelId || rawPanel.slot;
      if (!panelIds.has(sourceId)) {
        panelIds.set(sourceId, panelId);
      }
      usedSlots.add(rawPanel.slot);
      panels.push({ id: panelId, slot: rawPanel.slot });
    }
    if (panels.length === 0) {
      continue;
    }
    const requestedActiveId =
      typeof rawColumn.activePanelId === "string" ? rawColumn.activePanelId.trim() : "";
    const activePanelId = panelIds.get(requestedActiveId) ?? panels[0]!.id;
    const fallbackWidth = panels.some((panel) => panel.slot === "chat")
      ? CHAT_DEFAULT_WIDTH
      : DEFAULT_WIDTH;
    const width =
      typeof rawColumn.width === "number" && Number.isFinite(rawColumn.width)
        ? clampWidth(rawColumn.width)
        : fallbackWidth;
    columns.push({ id: columnId, side: rawColumn.side, panels, activePanelId, width });
  }
  return { columns };
}
