// @vitest-environment node
import { notFound, type RouteLocation, type RouterHistory } from "@openclaw/uirouter";
import { describe, expect, it, vi } from "vitest";
import {
  agentRouteFromPath,
  inferBasePathFromPathname,
  memoryTabFromPath,
  pathForMemoryTab,
  pathForAgentPanel,
  pathForRoute,
  pathForPluginsHubTab,
  pathForWorkboardBoard,
  pluginsHubTabFromPath,
  routeIdFromPath,
  type RouteId,
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

const DYNAMIC_STARTUP_CASES = [
  {
    label: "agent panel",
    routeId: "agents",
    location: {
      pathname: pathForAgentPanel("team.writer", "tools"),
      search: "?probe=1",
      hash: "#catalog",
    },
  },
  {
    label: "chat session",
    routeId: "chat",
    location: {
      pathname: "/chat/main/01JSESSIONA",
      search: "?probe=1",
      hash: "#message",
    },
  },
  {
    label: "dashboard session",
    routeId: "dashboard",
    location: {
      pathname: "/dashboard/main/01JSESSIONA",
      search: "?probe=1",
      hash: "#dashboard",
    },
  },
  {
    label: "Beam share",
    routeId: "chat",
    location: {
      pathname: "/beam/0123456789ab",
      search: "",
      hash: "#message",
    },
  },
  {
    label: "workboard board",
    routeId: "workboard",
    location: {
      pathname: pathForWorkboardBoard("ops.v2"),
      search: "?agent=main",
      hash: "#queue",
    },
  },
  {
    label: "Memory tab",
    routeId: "memory",
    location: {
      pathname: pathForMemoryTab("settings"),
      search: "?probe=1",
      hash: "#memory-backend",
    },
  },
  {
    label: "Plugins tab",
    routeId: "plugins",
    location: {
      pathname: pathForPluginsHubTab("discover"),
      search: "?query=calendar",
      hash: "#featured",
    },
  },
] as const satisfies readonly {
  label: string;
  routeId: RouteId;
  location: RouteLocation;
}[];

describe("Dynamic route startup bridge", () => {
  it("keeps plausible generic catalog share paths on chat", () => {
    for (const pathname of [
      "/beam/0123456789ab",
      "/beam/ABCDEF012345",
      "/beam/nothexvaluezz",
      "/beam/0123456789abcdef0123456789abcdef0",
    ]) {
      expect(routeIdFromPath(pathname)).toBe("chat");
    }
    expect(routeIdFromPath("/openclaw/beam/0123456789ab", "/openclaw")).toBe("chat");
    expect(inferBasePathFromPathname("/openclaw/beam/0123456789ab")).toBe("/openclaw");
  });

  it("does not steal mounted routes, docs, app resources, or reserved routes", () => {
    for (const pathname of [
      "/ui/chat",
      "/ui/config",
      "/concepts/agent-workspace",
      "/api/files/1",
      "/control/avatar/main",
      "/plugins/diffs/view/id/token",
      "/beam/0123456789a",
      "/beam/not-valid",
    ]) {
      expect(routeIdFromPath(pathname)).toBeNull();
    }
    expect(routeIdFromPath("/control/avatar/main", "/control")).toBeNull();
    expect(routeIdFromPath("/settings/about")).toBe("about");
    expect(routeIdFromPath("/workboard/0123456789ab")).toBe("workboard");
    expect(routeIdFromPath("/plugin/0123456789ab")).toBeNull();
    expect(routeIdFromPath("/usage/0123456789ab")).toBeNull();
    expect(routeIdFromPath("/settings/0123456789ab")).toBeNull();
    expect(routeIdFromPath("/openclaw/skills/0123456789ab", "/openclaw")).toBeNull();
  });

  it("registers the Updates settings path", () => {
    expect(pathForRoute("updates")).toBe("/settings/updates");
    expect(routeIdFromPath("/settings/updates")).toBe("updates");
  });

  it("registers the Secrets settings path", () => {
    expect(pathForRoute("secrets")).toBe("/settings/secrets");
    expect(routeIdFromPath("/settings/secrets")).toBe("secrets");
  });

  it("registers the Portals workspace path", () => {
    expect(pathForRoute("portals")).toBe("/portals");
    expect(routeIdFromPath("/portals")).toBe("portals");
  });

  it("matches mixed-case deep links exactly like the uirouter path key", () => {
    // uirouter lowercases static path keys; a case-sensitive pre-gate would
    // rewrite /Usage to /chat before the router ever saw it.
    expect(routeIdFromPath("/Usage")).toBe("usage");
    expect(routeIdFromPath("/Settings/About")).toBe("about");
    expect(routeIdFromPath("/ui/Usage", "/ui")).toBe("usage");
  });

  it.each(DYNAMIC_STARTUP_CASES)(
    "loads the $label once while publishing its real location",
    async ({ routeId, location: initialLocation }) => {
      let location: RouteLocation = { ...initialLocation };
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
      const route = router.getRoute(routeId);
      if (!route) {
        throw new Error(`Route missing: ${routeId}`);
      }
      const loader = vi.fn(async () => ({ routeId }));
      const originalLoader = route.loader;
      const originalComponent = route.component;
      try {
        route.loader = loader;
        route.component = async () => ({ render: () => null });

        await startApplicationRouter(router, history, "", {
          basePath: "",
        } as unknown as ApplicationContext);

        expect(loader).toHaveBeenCalledOnce();
        expect(router.getState().matches[0]?.location).toEqual(initialLocation);
        expect(push).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
      } finally {
        router.stop();
        route.loader = originalLoader;
        route.component = originalComponent;
      }
    },
  );

  it("loads a later dynamic history destination exactly once", async () => {
    let location: RouteLocation = {
      pathname: "/chat/main/01JSESSIONA",
      search: "",
      hash: "#first",
    };
    let historyListener: ((next: RouteLocation) => void) | undefined;
    const history: RouterHistory = {
      location: () => location,
      push: vi.fn((next: RouteLocation) => {
        location = next;
      }),
      replace: vi.fn((next: RouteLocation) => {
        location = next;
      }),
      listen: (listener) => {
        historyListener = listener;
        return () => {
          historyListener = undefined;
        };
      },
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const loader = vi.fn<NonNullable<typeof route.loader>>(async () => ({}));
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = loader;
      route.component = async () => ({ render: () => null });

      await startApplicationRouter(router, history, "", {
        basePath: "",
      } as unknown as ApplicationContext);
      expect(loader).toHaveBeenCalledOnce();

      location = {
        pathname: "/chat/main/01JSESSIONB",
        search: "?probe=1",
        hash: "#second",
      };
      historyListener?.(location);

      await vi.waitFor(() => {
        expect(loader).toHaveBeenCalledTimes(2);
        expect(loader.mock.calls[1]?.[1].location).toEqual(location);
      });
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });

  it("keeps a loader not-found state without rejecting startup", async () => {
    let location: RouteLocation = { pathname: "/", search: "", hash: "" };
    const history: RouterHistory = {
      location: () => location,
      push: vi.fn(),
      replace: vi.fn((next: RouteLocation) => {
        location = next;
      }),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = () => notFound({ routeId: "chat" });
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", {
          basePath: "",
        } as unknown as ApplicationContext),
      ).resolves.toBeUndefined();

      expect(location.pathname).toBe("/chat");
      expect(router.getState().status).toBe("notFound");
      expect(router.getState().matches[0]).toMatchObject({
        routeId: "chat",
        status: "notFound",
        error: { type: "notFound", data: { routeId: "chat" } },
      });
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });

  it("tolerates not-found from both dynamic startup navigations", async () => {
    const location: RouteLocation = {
      pathname: "/chat/main/01JSESSIONA",
      search: "",
      hash: "",
    };
    const history: RouterHistory = {
      location: () => location,
      push: vi.fn(),
      replace: vi.fn(),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const loader = vi.fn(() => notFound({ routeId: "chat" }));
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = loader;
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", {
          basePath: "",
        } as unknown as ApplicationContext),
      ).resolves.toBeUndefined();

      expect(loader).toHaveBeenCalledTimes(2);
      expect(router.getState().status).toBe("notFound");
      expect(router.getState().location).toEqual(location);
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });

  it("still rejects non-not-found startup failures", async () => {
    const failure = new Error("chat loader failed");
    const history: RouterHistory = {
      location: () => ({ pathname: "/chat", search: "", hash: "" }),
      push: vi.fn(),
      replace: vi.fn(),
      listen: () => () => undefined,
    };
    const router = createApplicationRouter();
    const route = router.getRoute("chat");
    if (!route) {
      throw new Error("Chat route missing");
    }
    const originalLoader = route.loader;
    const originalComponent = route.component;
    try {
      route.loader = () => {
        throw failure;
      };
      route.component = async () => ({ render: () => null });

      await expect(
        startApplicationRouter(router, history, "", {
          basePath: "",
        } as unknown as ApplicationContext),
      ).rejects.toBe(failure);
    } finally {
      router.stop();
      route.loader = originalLoader;
      route.component = originalComponent;
    }
  });
});

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
});
