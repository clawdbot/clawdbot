import { describe, expect, it } from "vitest";
import {
  TAB_GROUPS,
  iconForTab,
  inferBasePathFromPathname,
  normalizeBasePath,
  normalizePath,
  pathForTab,
  subtitleForTab,
  tabFromPath,
  titleForTab,
  type Tab,
} from "./navigation.ts";

/** All valid tab identifiers derived from TAB_GROUPS */
const ALL_TABS: Tab[] = TAB_GROUPS.flatMap((group) => group.tabs) as Tab[];

const leadingSlashNormalizerCases = [
  { name: "normalizeBasePath", normalize: normalizeBasePath, input: "ui", expected: "/ui" },
  { name: "normalizePath", normalize: normalizePath, input: "chat", expected: "/chat" },
];

describe("iconForTab", () => {
  it("returns stable icons for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, iconForTab(tab)]))).toEqual({
      chat: "messageSquare",
      overview: "barChart",
      channels: "link",
      instances: "radio",
      sessions: "fileText",
      usage: "barChart",
      cron: "loader",
      agents: "folder",
      skills: "zap",
      nodes: "monitor",
      dreams: "moon",
      config: "settings",
      communications: "send",
      appearance: "spark",
      automation: "terminal",
      infrastructure: "globe",
      aiAgents: "brain",
      debug: "bug",
      logs: "scrollText",
    });
  });

  it("returns a fallback icon for unknown tab", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownTab = "unknown" as Tab;
    expect(iconForTab(unknownTab)).toBe("folder");
  });
});

describe("titleForTab", () => {
  it("returns expected titles for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, titleForTab(tab)]))).toEqual({
      chat: "Chat",
      overview: "Overview",
      channels: "Channels",
      instances: "Instances",
      sessions: "Sessions",
      usage: "Usage",
      cron: "Cron Jobs",
      agents: "Agents",
      skills: "Skills",
      nodes: "Nodes",
      dreams: "Dreaming",
      config: "Config",
      communications: "Communications",
      appearance: "Appearance",
      automation: "Automation",
      infrastructure: "Infrastructure",
      aiAgents: "AI & Agents",
      debug: "Debug",
      logs: "Logs",
    });
  });
});

describe("subtitleForTab", () => {
  it("returns expected subtitles for every tab", () => {
    expect(Object.fromEntries(ALL_TABS.map((tab) => [tab, subtitleForTab(tab)]))).toEqual({
      chat: "Gateway chat for quick interventions.",
      overview: "Status, entry points, health.",
      channels: "Channels and settings.",
      instances: "Connected clients and nodes.",
      sessions: "Active sessions and defaults.",
      usage: "API usage and costs.",
      cron: "Wakeups and recurring runs.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      nodes: "Paired devices and commands.",
      dreams: "Memory dreaming, consolidation, and reflection.",
      config: "Edit openclaw.json.",
      communications: "Channels, messages, and audio settings.",
      appearance: "Theme, UI, and setup wizard settings.",
      automation: "Commands, hooks, cron, and plugins.",
      infrastructure: "Gateway, web, browser, and media settings.",
      aiAgents: "Agents, models, skills, tools, memory, session.",
      debug: "Snapshots, events, RPC.",
      logs: "Live gateway logs.",
    });
  });
});

describe("leading slash path normalizers", () => {
  it.each(leadingSlashNormalizerCases)(
    "$name adds leading slash if missing",
    ({ expected, input, normalize }) => {
      expect(normalize(input)).toBe(expected);
    },
  );
});

describe("normalizeBasePath", () => {
  it("returns empty string for falsy input", () => {
    expect(normalizeBasePath("")).toBe("");
  });

  it("removes trailing slash", () => {
    expect(normalizeBasePath("/ui/")).toBe("/ui");
  });

  it("returns empty string for root path", () => {
    expect(normalizeBasePath("/")).toBe("");
  });

  it("handles nested paths", () => {
    expect(normalizeBasePath("/apps/openclaw")).toBe("/apps/openclaw");
  });
});

describe("normalizePath", () => {
  it("returns / for falsy input", () => {
    expect(normalizePath("")).toBe("/");
  });

  it("removes trailing slash except for root", () => {
    expect(normalizePath("/chat/")).toBe("/chat");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("pathForTab", () => {
  it("returns correct path without base", () => {
    expect(pathForTab("chat")).toBe("/chat");
    expect(pathForTab("overview")).toBe("/overview");
  });

  it("prepends base path", () => {
    expect(pathForTab("chat", "/ui")).toBe("/ui/chat");
    expect(pathForTab("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("tabFromPath", () => {
  it("returns tab for valid path", () => {
    expect(tabFromPath("/chat")).toBe("chat");
    expect(tabFromPath("/overview")).toBe("overview");
    expect(tabFromPath("/sessions")).toBe("sessions");
    expect(tabFromPath("/dreaming")).toBe("dreams");
    expect(tabFromPath("/dreams")).toBe("dreams");
  });

  it("returns chat for root path", () => {
    expect(tabFromPath("/")).toBe("chat");
  });

  it("handles base paths", () => {
    expect(tabFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(tabFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
  });

  it("returns null for unknown path", () => {
    expect(tabFromPath("/unknown")).toBeNull();
  });

  it("is case-insensitive", () => {
    expect(tabFromPath("/CHAT")).toBe("chat");
    expect(tabFromPath("/Overview")).toBe("overview");
  });
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/dreaming")).toBe("");
    expect(inferBasePathFromPathname("/dreams")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("TAB_GROUPS", () => {
  it("contains all expected groups", () => {
    expect(TAB_GROUPS.map((g) => g.label)).toEqual(["chat", "control", "agent", "settings"]);
  });

  it("all tabs are unique", () => {
    const allTabs = TAB_GROUPS.flatMap((g) => g.tabs);
    const uniqueTabs = new Set(allTabs);
    expect(uniqueTabs.size).toBe(allTabs.length);
  });
});
