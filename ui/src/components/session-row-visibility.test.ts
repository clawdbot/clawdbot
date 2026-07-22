import { expect, it } from "vitest";
import {
  rowDemandsVisibility,
  RowVisibilityReason,
  type SidebarRecentSession,
} from "./app-sidebar-session-types.ts";

const quietRow = {
  visuallyActive: false,
  containsActiveDescendant: false,
  hasActiveRun: false,
  runningChildCount: 0,
  attention: { kind: "none" },
} as SidebarRecentSession;

const states = [
  ["quiet", {}, false, false, false],
  ["visually active", { visuallyActive: true }, true, false, false],
  ["active descendant", { containsActiveDescendant: true }, true, false, false],
  ["active run", { hasActiveRun: true }, true, true, false],
  ["running status", { status: "running" }, true, false, false],
  ["running descendant", { runningChildCount: 1 }, true, false, false],
  ["attention", { attention: { kind: "question" } }, true, false, true],
] as const;

it.each(states)(
  "keeps cap, collapsed-dot, and bubbling decisions aligned for %s",
  (_name, patch, cap, runningDot, attention) => {
    const row = { ...quietRow, ...patch };
    expect([
      rowDemandsVisibility(row),
      rowDemandsVisibility(row, RowVisibilityReason.ActiveRun),
      rowDemandsVisibility(row, RowVisibilityReason.Attention),
      rowDemandsVisibility(row, RowVisibilityReason.Attention),
    ]).toEqual([cap, runningDot, attention, attention]);
  },
);
