import { KEYBOARD_SHORTCUT_COMBOS as combos } from "../../lib/keyboard-shortcut-contract.ts";
import type { ChatPageHost } from "./chat-state-host.ts";
import type { SidebarSlotId } from "./sidebar-layout-types.ts";

type PanelContext = {
  state?: Pick<ChatPageHost, "terminalAvailable" | "browserPanelAvailable">;
  desktopAvailable?: boolean;
  discussion?: unknown;
  discussionAvailable?: boolean;
  dashboardAvailable: () => boolean;
};

function panel(
  slot: SidebarSlotId,
  combo: (typeof combos)[keyof typeof combos],
  available: (context: PanelContext) => boolean = () => true,
) {
  return { slot, combo, available };
}

export const SIDEBAR_PANEL_SHORTCUTS = {
  terminal: panel("terminal", combos.terminalPanel, (c) => c.state?.terminalAvailable === true),
  browser: panel("browser", combos.browserPanel, (c) => c.state?.browserPanelAvailable === true),
  workspace: panel("workspace", combos.workspaceFiles),
  companion: panel("companion", combos.sideChat),
  tasks: panel("tasks", combos.tasksPanel),
  desktop: panel("desktop", combos.desktopPanel, (c) => c.desktopAvailable === true),
  discussion: panel(
    "discussion",
    combos.discussionPanel,
    (c) => c.discussion != null && c.discussionAvailable === true,
  ),
  dashboard: panel("dashboard", combos.dashboardPanel, (c) => c.dashboardAvailable()),
  detail: panel("detail", combos.reviewPanel),
  conversation: undefined,
};
