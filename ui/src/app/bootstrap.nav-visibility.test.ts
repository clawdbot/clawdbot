import { describe, expect, it, vi } from "vitest";
import {
  SIDEBAR_SESSION_NAV_COLLAPSE_QUERY,
  withSidebarNavCollapseIntent,
} from "../app-session-route-paths.ts";
import { bootstrapApplication } from "./bootstrap.ts";
import { loadSettings, saveSettings, setSettingsChangeListener } from "./settings.ts";

const SIDEBAR_COLLAPSE_SEARCH = new URLSearchParams({
  [SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.name]: SIDEBAR_SESSION_NAV_COLLAPSE_QUERY.value,
}).toString();

describe("withSidebarNavCollapseIntent", () => {
  it.each([
    ["/chat/main/research", "/chat/main/research?nav=collapsed"],
    ["/chat/main?catalog=codex&thread=one", "/chat/main?catalog=codex&thread=one&nav=collapsed"],
    ["/chat/main?nav=collapsed&catalog=codex", "/chat/main?nav=collapsed&catalog=codex"],
    ["/chat/main?catalog=codex#details", "/chat/main?catalog=codex&nav=collapsed#details"],
  ])("marks %s exactly once while preserving its route", (href, expected) => {
    expect(withSidebarNavCollapseIntent(href)).toBe(expected);
  });
});

describe("normalizeInitialApplicationLocation", () => {
  it.each([
    {
      initialUrl: `/chat/research/conversation?keep=yes&${SIDEBAR_COLLAPSE_SEARCH}#details`,
      expectedUrl: "/chat/research/conversation?keep=yes#details",
      navCollapsed: true,
    },
    {
      initialUrl: `/chat/research?${SIDEBAR_COLLAPSE_SEARCH}`,
      expectedUrl: "/chat/research",
      navCollapsed: true,
    },
    {
      initialUrl: `/chat?${SIDEBAR_COLLAPSE_SEARCH}`,
      expectedUrl: "/chat",
      navCollapsed: false,
    },
    {
      initialUrl: `/dashboard/research/conversation?${SIDEBAR_COLLAPSE_SEARCH}`,
      expectedUrl: "/dashboard/research/conversation",
      navCollapsed: false,
    },
    {
      initialUrl: "/settings/appearance",
      expectedUrl: "/settings/appearance",
      navCollapsed: false,
    },
  ])("seeds sidebar visibility once from explicit new-tab intent at $initialUrl", (testCase) => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", testCase.initialUrl);
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;

    try {
      runtime = bootstrapApplication({
        sessionPathBuilderReady: new Promise<void>(() => {}),
      });
      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(testCase.navCollapsed);
      expect(`${window.location.pathname}${window.location.search}${window.location.hash}`).toBe(
        testCase.expectedUrl,
      );
    } finally {
      runtime?.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("keeps the sidebar expanded for an unmarked chat-session deep link", () => {
    const previousSettings = loadSettings();
    const previousUrl = window.location.href;
    window.history.replaceState({}, "", "/chat/research/conversation");
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;

    try {
      runtime = bootstrapApplication({
        sessionPathBuilderReady: new Promise<void>(() => {}),
      });
      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(false);
    } finally {
      runtime?.stop();
      window.history.replaceState({}, "", previousUrl);
      saveSettings(previousSettings);
    }
  });

  it("keeps sidebar visibility in memory without rewriting persisted settings", () => {
    const previousSettings = loadSettings();
    let runtime: ReturnType<typeof bootstrapApplication> | undefined;
    const onPersistedSettingsChanged = vi.fn();

    try {
      runtime = bootstrapApplication({
        sessionPathBuilderReady: new Promise<void>(() => {}),
      });
      setSettingsChangeListener(onPersistedSettingsChanged);

      runtime.context.navigation.update({ navCollapsed: true });

      expect(runtime.context.navigation.snapshot.navCollapsed).toBe(true);
      expect(onPersistedSettingsChanged).not.toHaveBeenCalled();

      runtime.context.navigation.update({ navWidth: previousSettings.navWidth + 1 });

      expect(onPersistedSettingsChanged).toHaveBeenCalledOnce();
      expect(loadSettings().navWidth).toBe(previousSettings.navWidth + 1);
    } finally {
      runtime?.stop();
      setSettingsChangeListener(null);
      saveSettings(previousSettings);
    }
  });
});
