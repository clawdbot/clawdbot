// @vitest-environment node
import type { RouteLocation, RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import {
  agentRouteFromPath,
  inferBasePathFromPathname,
  memoryTabFromPath,
  pathForMemoryTab,
  pathForAgentPanel,
  pathForPluginsHubTab,
  pluginsHubTabFromPath,
  routeIdFromPath,
  type MemoryRouteTab,
  type PluginsHubRouteTab,
} from "./app-route-paths.ts";
import { createApplicationRouter, startApplicationRouter } from "./app-routes.ts";
import type { ApplicationContext } from "./app/context.ts";
import type { AgentsPanel } from "./lib/agents/panels.ts";

const AGENT_PANEL_CASES = [
  "overview",
  "files",
  "tools",
  "skills",
  "channels",
  "cron",
  "memory",
] as const satisfies readonly AgentsPanel[];

describe("Agent panel route paths", () => {
  it.each(AGENT_PANEL_CASES)("round-trips the %s panel with an encoded agent id", (panel) => {
    const pathname = pathForAgentPanel("team.writer", panel);
    expect(pathname).toBe(`/settings/agents/team%2Ewriter/${panel}`);
    expect(agentRouteFromPath(pathname)).toEqual({
      agentId: "team.writer",
      panel,
      panelSegment: panel,
      invalidPanel: false,
    });
    expect(routeIdFromPath(pathname)).toBe("agents");
  });

  it("round-trips the agent default panel without an explicit segment", () => {
    const pathname = pathForAgentPanel("research", null, "/ui");
    expect(pathname).toBe("/ui/settings/agents/research");
    expect(agentRouteFromPath(pathname, "/ui")).toEqual({
      agentId: "research",
      panel: "files",
      panelSegment: null,
      invalidPanel: false,
    });
    expect(inferBasePathFromPathname(pathname)).toBe("/ui");
  });

  it("falls back unknown panel segments to the default panel", () => {
    expect(agentRouteFromPath("/settings/agents/research/unknown")).toEqual({
      agentId: "research",
      panel: "files",
      panelSegment: null,
      invalidPanel: true,
    });
    expect(routeIdFromPath("/settings/agents/research/unknown")).toBe("agents");
  });

  it("rejects malformed, slash-containing, and nested agent paths", () => {
    expect(() => pathForAgentPanel("agent/child")).toThrow("Invalid agent id");
    expect(() => pathForAgentPanel(".")).toThrow("Invalid agent id");
    expect(() => pathForAgentPanel("..")).toThrow("Invalid agent id");
    expect(agentRouteFromPath("/settings/agents/agent%2Fchild")).toBeNull();
    expect(agentRouteFromPath("/settings/agents/%")).toBeNull();
    expect(agentRouteFromPath("/settings/agents/research/tools/extra")).toBeNull();
  });

  it("publishes the real dynamic pathname after the exact-match startup bridge", async () => {
    let location: RouteLocation = {
      pathname: "/settings/agents/team%2Ewriter/tools",
      search: "?probe=1",
      hash: "#catalog",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const agentsRoute = router.getRoute("agents");
    if (!agentsRoute) {
      throw new Error("Agents route missing");
    }
    agentsRoute.component = async () => ({ render: () => null });
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
      agents: [{ id: "main" }, { id: "team.writer" }],
    };
    const context = {
      basePath: "",
      gateway: { snapshot: { phase: "stopped", client: null } },
      agents: {
        state: { agentsList, agentsError: null },
        ensureList: () => Promise.resolve(agentsList),
      },
    } as unknown as ApplicationContext;

    await startApplicationRouter(router, history, "", context);

    expect(router.getState().location).toEqual(location);
    expect(router.getState().matches[0]?.location).toEqual(location);
    expect(location.pathname).toBe("/settings/agents/team%2Ewriter/tools");
    expect(location.search).toBe("?probe=1");
    expect(location.hash).toBe("#catalog");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    router.stop();
  });

  it("normalizes an invalid panel once before the startup bridge", async () => {
    let location: RouteLocation = {
      pathname: "/settings/agents/main/unknown",
      search: "?probe=1",
      hash: "#agents",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const agentsRoute = router.getRoute("agents");
    if (!agentsRoute) {
      throw new Error("Agents route missing");
    }
    agentsRoute.component = async () => ({ render: () => null });
    const agentsList = {
      defaultId: "main",
      mainKey: "main",
      scope: "agent",
      agents: [{ id: "main" }],
    };
    const context = {
      basePath: "",
      gateway: { snapshot: { phase: "stopped", client: null } },
      agents: {
        state: { agentsList, agentsError: null },
        ensureList: () => Promise.resolve(agentsList),
      },
    } as unknown as ApplicationContext;

    await startApplicationRouter(router, history, "", context);

    expect(replace).toHaveBeenCalledOnce();
    expect(replace).toHaveBeenCalledWith({
      pathname: "/settings/agents/main",
      search: "?probe=1",
      hash: "#agents",
    });
    expect(push).not.toHaveBeenCalled();
    expect(location.pathname).toBe("/settings/agents/main");
    router.stop();
  });
});

describe("Memory tab route paths", () => {
  it.each([
    ["overview", "/settings/memory"],
    ["memories", "/settings/memory/memories"],
    ["dreams", "/settings/memory/dreams"],
    ["settings", "/settings/memory/settings"],
  ] as const)("round-trips %s through its canonical path", (tab, pathname) => {
    expect(pathForMemoryTab(tab)).toBe(pathname);
    expect(memoryTabFromPath(pathname)).toBe(tab);
    expect(routeIdFromPath(pathname)).toBe("memory");
  });

  it.each(["overview", "memories", "dreams", "settings"] as const)(
    "round-trips %s under a configured base path",
    (tab: MemoryRouteTab) => {
      const pathname = pathForMemoryTab(tab, "/ui");
      expect(memoryTabFromPath(pathname, "/ui")).toBe(tab);
      expect(routeIdFromPath(pathname, "/ui")).toBe("memory");
      expect(inferBasePathFromPathname(pathname)).toBe("/ui");
    },
  );

  it("rejects unknown and nested Memory tab segments", () => {
    expect(memoryTabFromPath("/settings/memory/unknown")).toBeNull();
    expect(memoryTabFromPath("/settings/memory/dreams/extra")).toBeNull();
    expect(routeIdFromPath("/settings/memory/unknown")).toBeNull();
    expect(routeIdFromPath("/settings/memory/dreams/extra")).toBeNull();
  });

  it("publishes the real dynamic pathname after the exact-match startup bridge", async () => {
    let location: RouteLocation = {
      pathname: "/settings/memory/settings",
      search: "",
      hash: "#memory-backend",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const memoryRoute = router.getRoute("memory");
    if (!memoryRoute) {
      throw new Error("Memory route missing");
    }
    memoryRoute.component = async () => ({ render: () => null });
    const context = {
      basePath: "",
      runtimeConfig: {
        ensureLoaded: () => Promise.resolve(),
        ensureSchemaLoaded: () => Promise.resolve(),
      },
    } as unknown as ApplicationContext;

    await startApplicationRouter(router, history, "", context);

    expect(router.getState().location).toEqual(location);
    expect(router.getState().matches[0]?.location).toEqual(location);
    expect(location.pathname).toBe("/settings/memory/settings");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    router.stop();
  });
});

describe("Plugins hub tab route paths", () => {
  it.each([
    ["installed", "/settings/plugins"],
    ["discover", "/settings/plugins/discover"],
  ] as const)("round-trips %s through its canonical path", (tab, pathname) => {
    expect(pathForPluginsHubTab(tab)).toBe(pathname);
    expect(pluginsHubTabFromPath(pathname)).toBe(tab);
    expect(routeIdFromPath(pathname)).toBe("plugins");
  });

  it.each(["installed", "discover"] as const)(
    "round-trips %s under a configured base path",
    (tab: PluginsHubRouteTab) => {
      const pathname = pathForPluginsHubTab(tab, "/ui");
      expect(pluginsHubTabFromPath(pathname, "/ui")).toBe(tab);
      expect(routeIdFromPath(pathname, "/ui")).toBe("plugins");
      expect(inferBasePathFromPathname(pathname)).toBe("/ui");
    },
  );

  it("rejects unknown and nested Plugins hub tab segments", () => {
    expect(pluginsHubTabFromPath("/settings/plugins/unknown")).toBeNull();
    expect(pluginsHubTabFromPath("/settings/plugins/discover/extra")).toBeNull();
    expect(routeIdFromPath("/settings/plugins/unknown")).toBeNull();
    expect(routeIdFromPath("/settings/plugins/discover/extra")).toBeNull();
  });

  it("publishes the real dynamic pathname after the exact-match startup bridge", async () => {
    let location: RouteLocation = {
      pathname: "/settings/plugins/discover",
      search: "?query=calendar",
      hash: "#featured",
    };
    const push = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const replace = vi.fn((next: RouteLocation) => {
      location = next;
    });
    const history: RouterHistory = {
      location: () => location,
      push,
      replace,
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const pluginsRoute = router.getRoute("plugins");
    if (!pluginsRoute) {
      throw new Error("Plugins route missing");
    }
    pluginsRoute.component = async () => ({ render: () => null });
    const context = {
      basePath: "",
      gateway: {
        snapshot: { phase: "reconnecting", client: null },
      },
    } as unknown as ApplicationContext;

    await startApplicationRouter(router, history, "", context);

    expect(router.getState().location).toEqual(location);
    expect(router.getState().matches[0]?.location).toEqual(location);
    expect(location.pathname).toBe("/settings/plugins/discover");
    expect(location.search).toBe("?query=calendar");
    expect(location.hash).toBe("#featured");
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    router.stop();
  });
});
