// Control UI tests cover navigation behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAVIGATION_GROUPS,
  SETTINGS_NAVIGATION_ROUTES,
  SIDEBAR_NAV_ROUTES,
  navigationIconForRoute,
  subtitleForRoute,
  titleForRoute,
} from "./app-navigation.ts";
import { normalizePath } from "./app-route-paths.ts";
import {
  createApplicationRouter,
  inferBasePathFromPathname,
  normalizeBasePath,
  pathForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-routes.ts";
import { pluginTabKey, pluginTabRefFromSearch, pluginTabSearch } from "./pages/plugin/route.ts";

/** All route identifiers derived from sidebar nav routes plus routed settings slices. */
const ALL_ROUTES: RouteId[] = Array.from(
  new Set<RouteId>(["chat", ...SIDEBAR_NAV_ROUTES, ...SETTINGS_NAVIGATION_ROUTES]),
);

const SETTINGS_ROUTE_PATHS = [
  { routeId: "config", path: "/settings/general", alias: "/config" },
  { routeId: "profile", path: "/settings/profile", alias: "/profile" },
  { routeId: "channels", path: "/settings/channels", alias: "/channels" },
  {
    routeId: "communications",
    path: "/settings/communications",
    alias: "/communications",
  },
  { routeId: "appearance", path: "/settings/appearance", alias: "/appearance" },
  { routeId: "automation", path: "/settings/automation", alias: "/automation" },
  { routeId: "mcp", path: "/settings/mcp", alias: "/mcp" },
  {
    routeId: "infrastructure",
    path: "/settings/infrastructure",
    alias: "/infrastructure",
  },
  { routeId: "worktrees", path: "/settings/worktrees", alias: "/worktrees" },
  { routeId: "ai-agents", path: "/settings/ai-agents", alias: "/ai-agents" },
  {
    routeId: "model-providers",
    path: "/settings/model-providers",
    alias: "/model-providers",
  },
] as const satisfies readonly { routeId: RouteId; path: string; alias: string }[];

const leadingSlashNormalizerCases = [
  { name: "normalizeBasePath", normalize: normalizeBasePath, input: "ui", expected: "/ui" },
  { name: "normalizePath", normalize: normalizePath, input: "chat", expected: "/chat" },
];

describe("navigationIconForRoute", () => {
  it("returns stable icons for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, navigationIconForRoute(routeId)])),
    ).toEqual({
      chat: "messageSquare",
      overview: "barChart",
      activity: "activity",
      workboard: "kanban",
      worktrees: "folder",
      channels: "link",
      sessions: "fileText",
      usage: "barChart",
      cron: "calendarClock",
      tasks: "listChecks",
      agents: "bot",
      skills: "zap",
      plugins: "puzzle",
      "skill-workshop": "wrench",
      nodes: "monitor",
      dreams: "moon",
      config: "settings",
      profile: "lobster",
      communications: "send",
      appearance: "spark",
      automation: "terminal",
      mcp: "wrench",
      infrastructure: "globe",
      about: "fileText",
      "ai-agents": "brain",
      "model-providers": "plug",
      debug: "bug",
      logs: "scrollText",
    });
  });

  it("returns a fallback icon for unknown route", () => {
    // TypeScript won't allow this normally, but runtime could receive unexpected values
    const unknownRouteId = "unknown" as RouteId;
    expect(navigationIconForRoute(unknownRouteId)).toBe("folder");
  });
});

describe("titleForRoute", () => {
  it("returns expected titles for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, titleForRoute(routeId)])),
    ).toEqual({
      chat: "Chat",
      overview: "Overview",
      activity: "Activity",
      workboard: "Workboard",
      worktrees: "Worktrees",
      channels: "Channels",
      sessions: "Sessions",
      usage: "Usage",
      cron: "Cron Jobs",
      tasks: "Tasks",
      agents: "Agents",
      skills: "Skills",
      plugins: "Plugins",
      "skill-workshop": "Skill Workshop",
      nodes: "Devices",
      dreams: "Dreaming",
      config: "Settings",
      profile: "Profile",
      communications: "Communications",
      appearance: "Appearance",
      automation: "Automation",
      mcp: "MCP",
      infrastructure: "Infrastructure",
      about: "About",
      "ai-agents": "AI & Agents",
      "model-providers": "Model Providers",
      debug: "Debug",
      logs: "Logs",
    });
  });
});

describe("subtitleForRoute", () => {
  it("returns expected subtitles for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, subtitleForRoute(routeId)])),
    ).toEqual({
      chat: "Gateway chat for quick interventions.",
      overview: "Status, entry points, health.",
      activity: "Browser-local tool activity summaries.",
      workboard: "Agent work queue and session handoff.",
      worktrees: "Isolated agent task checkouts and recovery snapshots.",
      channels: "Channels and settings.",
      sessions: "Active sessions and defaults.",
      usage: "API usage and costs.",
      cron: "Wakeups and recurring runs.",
      tasks: "Background tasks: subagents, cron runs, CLI.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      plugins: "Install and manage optional capabilities.",
      "skill-workshop": "Review, refine, and apply proposals before they become live skills.",
      nodes: "Paired devices, live connections, and commands.",
      dreams: "Memory dreaming, consolidation, and reflection.",
      config: "Edit openclaw.json.",
      profile: "Your agent's stats, streaks, and life in the reef.",
      communications: "Channels, messages, and audio settings.",
      appearance: "Theme, UI, and setup wizard settings.",
      automation: "Commands, hooks, cron, and plugins.",
      mcp: "MCP servers, auth, tools, and diagnostics.",
      infrastructure: "Gateway, web, browser, and media settings.",
      about: "Control UI and connected Gateway build identity.",
      "ai-agents": "Agents, models, skills, tools, memory, session.",
      "model-providers": "Configured providers with plan, quota, and cost.",
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

describe("pathForRoute", () => {
  it("returns correct path without base", () => {
    expect(pathForRoute("chat")).toBe("/chat");
    expect(pathForRoute("overview")).toBe("/overview");
    expect(pathForRoute("debug")).toBe("/debug");
    expect(pathForRoute("logs")).toBe("/logs");
    expect(pathForRoute("plugins")).toBe("/settings/plugins");
  });

  it("prepends base path", () => {
    expect(pathForRoute("chat", "/ui")).toBe("/ui/chat");
    expect(pathForRoute("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("routeIdFromPath", () => {
  it("returns tab for valid path", () => {
    expect(routeIdFromPath("/chat")).toBe("chat");
    expect(routeIdFromPath("/new")).toBe("new-session");
    expect(routeIdFromPath("/overview")).toBe("overview");
    expect(routeIdFromPath("/activity")).toBe("activity");
    expect(routeIdFromPath("/sessions")).toBe("sessions");
    expect(routeIdFromPath("/debug")).toBe("debug");
    expect(routeIdFromPath("/logs")).toBe("logs");
    expect(routeIdFromPath("/dreaming")).toBe("dreams");
    expect(routeIdFromPath("/dreams")).toBe("dreams");
    expect(routeIdFromPath("/settings/plugins")).toBe("plugins");
    expect(routeIdFromPath("/plugins")).toBeNull();
    expect(routeIdFromPath("/settings/about")).toBe("about");
    expect(routeIdFromPath("/about")).toBeNull();
  });

  it("leaves root fallback to application startup", () => {
    expect(routeIdFromPath("/")).toBeNull();
  });

  it("handles base paths", () => {
    expect(routeIdFromPath("/ui/chat", "/ui")).toBe("chat");
    expect(routeIdFromPath("/apps/openclaw/sessions", "/apps/openclaw")).toBe("sessions");
    expect(routeIdFromPath("/ui/settings/plugins", "/ui")).toBe("plugins");
  });

  it("rejects route-shaped paths outside the configured base path", () => {
    expect(routeIdFromPath("/xx/chat", "/ui")).toBeNull();
    expect(routeIdFromPath("/other/sessions", "/apps/openclaw")).toBeNull();
  });

  it("returns null for unknown path", () => {
    expect(routeIdFromPath("/unknown")).toBeNull();
    expect(routeIdFromPath("/instances")).toBeNull();
  });

  it("matches canonical route casing exactly", () => {
    expect(routeIdFromPath("/CHAT")).toBeNull();
    expect(routeIdFromPath("/Overview")).toBeNull();
  });
});

describe("compiled settings routes", () => {
  const router = createApplicationRouter();

  it.each(SETTINGS_ROUTE_PATHS)(
    "routes $routeId through its canonical path and legacy alias",
    ({ routeId, path, alias }) => {
      expect(pathForRoute(routeId)).toBe(path);
      expect(routeIdFromPath(path)).toBe(routeId);
      expect(routeIdFromPath(alias)).toBe(routeId);
      expect(router.pathForRoute(routeId)).toBe(path);
      expect(router.routeIdFromPath(path)).toBe(routeId);
      expect(router.routeIdFromPath(alias)).toBe(routeId);
    },
  );

  it.each(SETTINGS_ROUTE_PATHS)(
    "routes $routeId under a configured mount path",
    ({ routeId, path, alias }) => {
      expect(pathForRoute(routeId, "/settings")).toBe(`/settings${path}`);
      expect(routeIdFromPath(`/settings${path}`, "/settings")).toBe(routeId);
      expect(routeIdFromPath(`/settings${alias}`, "/settings")).toBe(routeId);
      expect(router.pathForRoute(routeId, "/settings")).toBe(`/settings${path}`);
      expect(router.routeIdFromPath(`/settings${path}`, "/settings")).toBe(routeId);
      expect(router.routeIdFromPath(`/settings${alias}`, "/settings")).toBe(routeId);
    },
  );
});

describe("inferBasePathFromPathname", () => {
  it("returns empty string for root", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
  });

  it("returns empty string for direct tab path", () => {
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/overview")).toBe("");
    expect(inferBasePathFromPathname("/settings/general")).toBe("");
    expect(inferBasePathFromPathname("/settings/appearance")).toBe("");
    expect(inferBasePathFromPathname("/appearance")).toBe("");
    expect(inferBasePathFromPathname("/dreaming")).toBe("");
    expect(inferBasePathFromPathname("/dreams")).toBe("");
    expect(inferBasePathFromPathname("/settings/plugins")).toBe("");
  });

  it("infers base path from nested paths", () => {
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
    expect(inferBasePathFromPathname("/ui/settings/general")).toBe("/ui");
    expect(inferBasePathFromPathname("/ui/appearance")).toBe("/ui");
    expect(inferBasePathFromPathname("/ui/settings/plugins")).toBe("/ui");
  });

  it("preserves mount roots without a route suffix", () => {
    expect(inferBasePathFromPathname("/__openclaw__/")).toBe("/__openclaw__");
    expect(inferBasePathFromPathname("/apps/openclaw/")).toBe("/apps/openclaw");
    expect(inferBasePathFromPathname("/about/")).toBe("/about");
    expect(inferBasePathFromPathname("/typo")).toBe("");
  });

  it("handles index.html suffix", () => {
    expect(inferBasePathFromPathname("/index.html")).toBe("");
    expect(inferBasePathFromPathname("/ui/index.html")).toBe("/ui");
  });
});

describe("plugin tabs route", () => {
  it("round-trips the shared /plugin route", () => {
    expect(pathForRoute("plugin", "")).toBe("/plugin");
    expect(routeIdFromPath("/plugin", "")).toBe("plugin");
    // The tab id travels in the search, not the pathname.
    expect(routeIdFromPath("/plugin/logbook", "")).toBeNull();
  });

  it("round-trips a namespaced tab reference through the search", () => {
    const ref = { pluginId: "logbook", id: "logbook" };
    expect(pluginTabRefFromSearch(pluginTabSearch(ref))).toEqual(ref);
    expect(pluginTabKey(ref)).toBe("logbook/logbook");
    // Distinct plugins with the same local tab id stay distinct.
    expect(pluginTabKey({ pluginId: "other", id: "logbook" })).not.toBe(pluginTabKey(ref));
  });

  it("round-trips a selected Codex host and thread without changing the tab key", () => {
    const ref = {
      pluginId: "codex",
      id: "sessions",
      hostId: "node:macbook",
      threadId: "thread-1",
    };
    expect(pluginTabRefFromSearch(pluginTabSearch(ref))).toEqual(ref);
    expect(pluginTabKey(ref)).toBe("codex/sessions");
  });

  it("stays out of the customizable static sidebar routes", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("plugin");
    expect(SIDEBAR_NAV_ROUTES).toContain("plugins");
    expect(routeIdFromPath("/settings/plugins")).toBe("plugins");
    expect(routeIdFromPath("/plugins")).toBeNull();
  });
});

describe("SIDEBAR_NAV_ROUTES", () => {
  it("all routes are unique", () => {
    expect(new Set(SIDEBAR_NAV_ROUTES).size).toBe(SIDEBAR_NAV_ROUTES.length);
  });

  it("keeps detailed settings slices routed but out of the customizable sidebar", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("config");
    expect(SETTINGS_NAVIGATION_ROUTES).toEqual([
      "profile",
      "config",
      "appearance",
      "channels",
      "communications",
      "ai-agents",
      "model-providers",
      "automation",
      "mcp",
      "infrastructure",
      "worktrees",
      "debug",
      "logs",
      "about",
    ]);
  });

  it("keeps settings sidebar groups unique and general first", () => {
    expect(new Set(SETTINGS_NAVIGATION_ROUTES).size).toBe(SETTINGS_NAVIGATION_ROUTES.length);
    const [firstGroup] = SETTINGS_NAVIGATION_GROUPS;
    expect(firstGroup.labelKey).toBeNull();
    expect(firstGroup.routes).toContain("config");
    for (const group of SETTINGS_NAVIGATION_GROUPS.slice(1)) {
      expect(group.labelKey).toBeTruthy();
    }
  });
});
