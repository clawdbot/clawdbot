import {
  forceTerminalRender,
  type TerminalPanelSessionTab,
} from "./terminal-panel-session-types.ts";
import { terminalTheme } from "./terminal-theme.ts";

export function updateTerminalSessionTheme(
  tabs: readonly TerminalPanelSessionTab[],
  themeMode: "dark" | "light",
): void {
  const theme = terminalTheme(themeMode);
  for (const tab of tabs) {
    // ghostty-web 0.4.0 ignores options.theme after open() (its option
    // handler only warns), so update the renderer directly and force one
    // full render — the frame loop repaints only dirty rows, which would
    // leave a static screen on the old palette.
    const term = tab.controller.terminal;
    if (term.renderer && term.wasmTerm) {
      term.renderer.setTheme(theme);
      forceTerminalRender(tab.controller);
    }
  }
}

export function reattachTerminalSessionHosts(
  tabs: readonly TerminalPanelSessionTab[],
  activeId: string | null,
  viewport: Element | null,
): void {
  if (!viewport) {
    return;
  }
  // Hiding the panel returns `nothing`, which detaches each session's ghostty
  // host. Re-attach live hosts whenever the viewport is rendered so a
  // hide/show cycle keeps the terminals intact instead of blanking them.
  for (const tab of tabs) {
    if (tab.host.parentElement !== viewport) {
      viewport.append(tab.host);
    }
  }
  const activeTab = tabs.find((tab) => tab.id === activeId);
  if (activeTab) {
    activeTab.controller.fit();
    // FitAddon skips unchanged dimensions; force dirty-row rendering to
    // repair a canvas that was detached while the panel was hidden.
    forceTerminalRender(activeTab.controller);
  }
}

export function fitActiveTerminalSession(
  tabs: readonly TerminalPanelSessionTab[],
  activeId: string | null,
): void {
  tabs.find((tab) => tab.id === activeId)?.controller.fit();
}

export function fitAllTerminalSessions(tabs: readonly TerminalPanelSessionTab[]): void {
  for (const tab of tabs) {
    tab.controller.fit();
  }
}

export function prepareTerminalSessionHostVisibility(
  tabs: readonly TerminalPanelSessionTab[],
  activeId: string | null,
): void {
  // Keep only the active session's host visible; ghostty renders to a canvas
  // that must be laid out to measure correctly.
  for (const tab of tabs) {
    tab.host.style.display = tab.id === activeId ? "block" : "none";
  }
}
