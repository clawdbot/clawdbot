// Control UI tests cover navigation behavior.
import { describe, expect, it } from "vitest";
import {
  SETTINGS_NAVIGATION_GROUPS,
  SIDEBAR_NAV_ROUTES,
  isPluginsHubRoute,
  navigationIconForRoute,
  settingsSearchTextMatches,
  subtitleForRoute,
  titleForRoute,
} from "./app-navigation.ts";
import { inferBasePathFromPathname, normalizeBasePath } from "./app-route-paths.ts";
import {
  createApplicationRouter,
  pathForRoute,
  routeIdFromPath,
  type RouteId,
} from "./app-routes.ts";
import { pluginTabKey, pluginTabRefFromSearch, pluginTabSearch } from "./pages/plugin/route.ts";

/**
 * All route identifiers derived from sidebar nav routes plus routed settings
 * slices and the Plugins hub tabs, which route without their own sidebar item.
 */
const ALL_ROUTES: RouteId[] = Array.from(
  new Set<RouteId>([
    "chat",
    "custodian",
    ...SIDEBAR_NAV_ROUTES,
    "skills",
    "skill-workshop",
    // Hub tabs and settings subpages route without their own nav entry.
    "worktrees",
    "memory-import",
    "model-setup",
    ...SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes),
  ]),
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
  { routeId: "worktrees", path: "/worktrees", alias: "/settings/worktrees" },
  { routeId: "sessions", path: "/sessions", alias: "/settings/sessions" },
  { routeId: "nodes", path: "/settings/devices", alias: "/nodes" },
  { routeId: "agents", path: "/settings/agents", alias: "/agents" },
  {
    routeId: "memory-import",
    path: "/memory-import",
    alias: "/settings/memory-import",
  },
  { routeId: "ai-agents", path: "/settings/ai-agents", alias: "/ai-agents" },
  {
    routeId: "model-setup",
    path: "/settings/model-setup",
    alias: "/model-setup",
  },
  {
    routeId: "model-providers",
    path: "/settings/model-providers",
    alias: "/model-providers",
  },
] as const satisfies readonly { routeId: RouteId; path: string; alias: string }[];

describe("navigationIconForRoute", () => {
  it("returns stable icons for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, navigationIconForRoute(routeId)])),
    ).toEqual({
      chat: "messageSquare",
      custodian: "lobster",
      activity: "activity",
      apps: "layoutGrid",
      approvals: "badgeCheck",
      workboard: "kanban",
      worktrees: "folder",
      channels: "link",
      connection: "radio",
      sessions: "fileText",
      usage: "coins",
      cron: "calendarClock",
      tasks: "listChecks",
      agents: "bot",
      skills: "zap",
      plugins: "puzzle",
      "skill-workshop": "wrench",
      nodes: "monitorSmartphone",
      config: "settings",
      profile: "circleUser",
      communications: "send",
      appearance: "palette",
      automation: "terminal",
      mcp: "wrench",
      infrastructure: "globe",
      labs: "flaskConical",
      about: "fileText",
      "ai-agents": "brain",
      "model-setup": "spark",
      "model-providers": "plug",
      "memory-import": "download",
      notifications: "bell",
      security: "shieldCheck",
      advanced: "fileCode",
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

describe("settingsSearchTextMatches", () => {
  it("uses locale-aware word prefixes for short queries", () => {
    expect(settingsSearchTextMatches("CPU usage", "cp")).toBe(true);
    expect(settingsSearchTextMatches("MCP", "cp")).toBe(false);
    expect(settingsSearchTextMatches("外観設定", "設定")).toBe(true);
  });
});

describe("titleForRoute", () => {
  it("returns expected titles for every route", () => {
    expect(
      Object.fromEntries(ALL_ROUTES.map((routeId) => [routeId, titleForRoute(routeId)])),
    ).toEqual({
      chat: "Chat",
      custodian: "OpenClaw",
      activity: "Activity",
      apps: "Apps",
      approvals: "Approvals",
      workboard: "Workboard",
      worktrees: "Worktrees",
      channels: "Channels",
      connection: "Connection",
      sessions: "Threads",
      usage: "Usage",
      cron: "Automations",
      tasks: "Tasks",
      agents: "Agents",
      skills: "Skills",
      plugins: "Plugins",
      "skill-workshop": "Skill Workshop",
      nodes: "Devices",
      config: "Settings",
      profile: "Profile",
      communications: "Communications",
      appearance: "Appearance",
      automation: "Automation",
      mcp: "MCP",
      infrastructure: "Infrastructure",
      labs: "Labs",
      about: "About",
      "ai-agents": "Agent Defaults",
      "model-setup": "Model Setup",
      "model-providers": "Model Providers",
      "memory-import": "Import Memory",
      notifications: "Notifications",
      security: "Privacy & Security",
      advanced: "Advanced",
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
      custodian: "System setup and care.",
      activity: "Browser-local tool activity summaries.",
      apps: "Companion apps for phone, watch, desktop, and browser.",
      approvals: "Recent exec, plugin, and system-agent approvals.",
      workboard: "Agent work queue and thread handoff.",
      worktrees: "Isolated agent task checkouts and recovery snapshots.",
      channels: "Channels and settings.",
      connection: "Gateway endpoint, credentials, and handshake status.",
      sessions: "Active threads and defaults.",
      usage: "API usage and costs.",
      cron: "Scheduled tasks and recurring agent runs.",
      tasks: "Background tasks: subagents, cron runs, CLI.",
      agents: "Workspaces, tools, identities.",
      skills: "Skills and API keys.",
      plugins: "Install and manage optional capabilities.",
      "skill-workshop": "Review, refine, and apply proposals before they become live skills.",
      nodes: "Paired devices, pairing approvals, and exec bindings.",
      config: "Model defaults, language, and gateway host.",
      profile: "Your agent's stats, streaks, and life in the reef.",
      communications: "Channels, messages, and audio settings.",
      appearance: "Theme, UI, and setup wizard settings.",
      automation: "Commands, hooks, cron, and plugins.",
      mcp: "MCP servers, auth, tools, and diagnostics.",
      infrastructure: "Gateway, web, browser, and media settings.",
      labs: "Experimental agent and tool capabilities.",
      about: "Control UI and connected Gateway build identity.",
      "ai-agents": "Global agent defaults: models, skills, tools, memory, session.",
      "model-setup": "Connect a verified AI model",
      "model-providers": "Configured providers with plan, quota, and cost.",
      "memory-import": "Bring Codex and Claude Code memory into an agent workspace.",
      notifications: "Browser push notifications from your gateway.",
      security: "Gateway auth, exec policy, tool profile, and approvals.",
      advanced: "Every remaining config section, plus the raw file editor.",
      debug: "Snapshots, events, RPC.",
      logs: "Live gateway logs.",
    });
  });
});

describe("pathForRoute", () => {
  it("returns correct path without base", () => {
    expect(pathForRoute("chat")).toBe("/chat");
    expect(pathForRoute("apps")).toBe("/apps");
    expect(pathForRoute("custodian")).toBe("/custodian");
    expect(pathForRoute("connection")).toBe("/settings/connection");
    expect(pathForRoute("debug")).toBe("/debug");
    expect(pathForRoute("logs")).toBe("/logs");
    expect(pathForRoute("plugins")).toBe("/settings/plugins");
    expect(pathForRoute("approvals")).toBe("/settings/approvals");
    expect(pathForRoute("labs")).toBe("/settings/labs");
  });

  it("prepends base path", () => {
    expect(pathForRoute("chat", "/ui")).toBe("/ui/chat");
    expect(pathForRoute("sessions", "/apps/openclaw")).toBe("/apps/openclaw/sessions");
  });
});

describe("route path normalization", () => {
  it("normalizes base paths and trailing route slashes", () => {
    expect(normalizeBasePath("")).toBe("");
    expect(normalizeBasePath("/")).toBe("");
    expect(normalizeBasePath("ui")).toBe("/ui");
    expect(normalizeBasePath("/apps/openclaw/")).toBe("/apps/openclaw");
    expect(routeIdFromPath("/chat/")).toBe("chat");
    expect(routeIdFromPath("/ui/chat/", "/ui/")).toBe("chat");
  });
});

describe("routeIdFromPath", () => {
  it("returns tab for valid path", () => {
    expect(routeIdFromPath("/chat")).toBe("chat");
    expect(routeIdFromPath("/custodian")).toBe("custodian");
    expect(routeIdFromPath("/new")).toBe("new-session");
    expect(routeIdFromPath("/overview")).toBeNull();
    expect(routeIdFromPath("/settings/connection")).toBe("connection");
    expect(routeIdFromPath("/connection")).toBeNull();
    expect(routeIdFromPath("/activity")).toBe("activity");
    expect(routeIdFromPath("/apps")).toBe("apps");
    expect(routeIdFromPath("/sessions")).toBe("sessions");
    expect(routeIdFromPath("/debug")).toBe("debug");
    expect(routeIdFromPath("/logs")).toBe("logs");
    expect(routeIdFromPath("/dreaming")).toBeNull();
    expect(routeIdFromPath("/dreams")).toBeNull();
    expect(routeIdFromPath("/settings/plugins")).toBe("plugins");
    expect(routeIdFromPath("/plugins")).toBeNull();
    expect(routeIdFromPath("/settings/about")).toBe("about");
    expect(routeIdFromPath("/settings/labs")).toBe("labs");
    expect(routeIdFromPath("/labs")).toBeNull();
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
    expect(routeIdFromPath("/Sessions")).toBeNull();
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
  it("handles direct routes, nested mounts, mount roots, and index.html", () => {
    expect(inferBasePathFromPathname("/")).toBe("");
    expect(inferBasePathFromPathname("/chat")).toBe("");
    expect(inferBasePathFromPathname("/custodian")).toBe("");
    expect(inferBasePathFromPathname("/settings/connection")).toBe("");
    expect(inferBasePathFromPathname("/ui/chat")).toBe("/ui");
    expect(inferBasePathFromPathname("/apps/openclaw/sessions")).toBe("/apps/openclaw");
    expect(inferBasePathFromPathname("/__openclaw__/")).toBe("/__openclaw__");
    expect(inferBasePathFromPathname("/apps/openclaw/")).toBe("/apps/openclaw");
    expect(inferBasePathFromPathname("/typo")).toBe("");
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

  it("collapses the plugins hub to a single sidebar entry", () => {
    expect(SIDEBAR_NAV_ROUTES).not.toContain("skills");
    expect(SIDEBAR_NAV_ROUTES).not.toContain("skill-workshop");
    expect(isPluginsHubRoute("plugins")).toBe(true);
    expect(isPluginsHubRoute("skills")).toBe(true);
    expect(isPluginsHubRoute("skill-workshop")).toBe(true);
    expect(isPluginsHubRoute("sessions")).toBe(false);
  });

  it("keeps detailed settings slices routed but out of the customizable sidebar", () => {
    const settingsRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);
    expect(SIDEBAR_NAV_ROUTES).not.toContain("config");
    expect(settingsRoutes).toEqual([
      "custodian",
      "profile",
      "config",
      "appearance",
      "notifications",
      "connection",
      "channels",
      "communications",
      "nodes",
      "agents",
      "ai-agents",
      "labs",
      "model-providers",
      "mcp",
      "automation",
      "security",
      "approvals",
      "infrastructure",
      "advanced",
      "debug",
      "logs",
      "about",
    ]);
  });

  it("keeps settings sidebar groups unique and general first", () => {
    const settingsRoutes = SETTINGS_NAVIGATION_GROUPS.flatMap((group) => group.routes);
    expect(new Set(settingsRoutes).size).toBe(settingsRoutes.length);
    const [firstGroup] = SETTINGS_NAVIGATION_GROUPS;
    expect(firstGroup?.labelKey).toBeNull();
    expect(firstGroup?.routes).toContain("config");
    for (const group of SETTINGS_NAVIGATION_GROUPS.slice(1)) {
      expect(group.labelKey).toBeTruthy();
    }
  });
});
