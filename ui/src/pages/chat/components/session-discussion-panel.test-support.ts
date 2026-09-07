import { vi } from "vitest";
import type { SessionDiscussionPanelConfig } from "./session-discussion-panel.ts";
import "./session-discussion-panel.ts";

export type SessionDiscussionInfoLoader = SessionDiscussionPanelConfig["loadInfo"];
export type SessionDiscussionOpener = SessionDiscussionPanelConfig["openDiscussion"];
export type SessionDiscussionStateListener = SessionDiscussionPanelConfig["onStateChange"];

type DiscussionPanelElement = HTMLElement & {
  sessionKey: string;
  canOpen: boolean;
  sourceGeneration: number;
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange: SessionDiscussionStateListener;
  updateComplete: Promise<unknown>;
};

const panels: DiscussionPanelElement[] = [];

export function resetDiscussionPanelTestState(): void {
  panels.splice(0).forEach((panel) => panel.remove());
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.removeAttribute("data-theme-mode");
  document.documentElement.removeAttribute("style");
  vi.restoreAllMocks();
}

export function expectedEmbedUrl(url: string, mode: "light" | "dark" = "dark"): string {
  const resolved = new URL(url);
  if (
    resolved.searchParams.get("openclawHostTheme") !== "1" ||
    !/^\/embed\/(?:channel|thread)\/[^/]+\/[^/]+\/?$/u.test(resolved.pathname)
  ) {
    return resolved.href;
  }
  resolved.searchParams.set("theme", mode);
  resolved.searchParams.set("hostOrigin", window.location.origin);
  return resolved.href;
}

export function mount(params: {
  loadInfo: SessionDiscussionInfoLoader;
  openDiscussion: SessionDiscussionOpener;
  onStateChange?: SessionDiscussionStateListener;
  canOpen?: boolean;
}): DiscussionPanelElement {
  const panel = document.createElement("openclaw-session-discussion") as DiscussionPanelElement;
  panel.sessionKey = "agent:main:first";
  panel.loadInfo = params.loadInfo;
  panel.openDiscussion = params.openDiscussion;
  panel.onStateChange = params.onStateChange ?? vi.fn();
  panel.canOpen = params.canOpen ?? true;
  document.body.append(panel);
  panels.push(panel);
  return panel;
}
