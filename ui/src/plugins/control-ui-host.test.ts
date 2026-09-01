import { describe, expect, it, vi } from "vitest";
import type { ControlUiSessionListSnapshot } from "../../../src/plugin-sdk/control-ui.js";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { GatewayBrowserClient } from "../api/gateway.ts";
import type { AgentsListResult } from "../api/types.ts";
import type { RouteId } from "../app-route-paths.ts";
import { createAgentSelectionCapability } from "../app/agent-selection.ts";
import type { ApplicationContext } from "../app/context.ts";
import { i18n } from "../i18n/index.ts";
import { createAgentCapability } from "../lib/agents/index.ts";
import { createSessionCapability } from "../lib/sessions/index.ts";
import {
  createGatewayHarness,
  sessionsResult,
} from "../lib/sessions/session-capability.test-support.ts";
import { createControlUiPluginHost } from "./control-ui-host.ts";
import { type ControlUiPluginOwner, ControlUiPluginRuntime } from "./control-ui-runtime.ts";
import { scopeControlUiHost } from "./control-ui-scope.ts";

function createRosterHost(request: GatewayBrowserClient["request"]) {
  const client = { request } as GatewayBrowserClient;
  const { gateway } = createGatewayHarness(client);
  const agents = createAgentCapability(gateway);
  const sessions = createSessionCapability(gateway);
  const context = { gateway, agents, sessions } as unknown as ApplicationContext<RouteId>;
  const abort = new AbortController();
  const owner = { client, abort, descriptor: { pluginId: "review" }, disposers: new Set() } as Omit<
    ControlUiPluginOwner,
    "host"
  >;
  const runtime = new ControlUiPluginRuntime(() => context);
  runtime.start();
  return {
    context,
    host: createControlUiPluginHost(() => context, runtime, owner),
    runtime,
    agents,
    sessions,
    dispose() {
      abort.abort();
      owner.disposers.forEach((dispose) => dispose());
      owner.disposers.clear();
      runtime.dispose();
      agents.dispose();
      sessions.dispose();
    },
  };
}

describe("native UI roster refresh", () => {
  it("observes independent session windows without replacing or exposing the application roster", async () => {
    const primary = sessionsResult(
      [{ key: "agent:main:current", kind: "direct", updatedAt: 1 }],
      1,
    );
    const found = {
      ...sessionsResult(
        [{ key: "agent:writer:linked", kind: "direct", updatedAt: 2, label: "Linked session" }],
        2,
      ),
      hasMore: true,
      nextOffset: 1,
      totalCount: 2,
    };
    const research = {
      ...sessionsResult([{ key: "agent:research:current", kind: "direct", updatedAt: 3 }], 3),
      hasMore: false,
      nextOffset: null,
      totalCount: 1,
    };
    const request = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(found)
      .mockResolvedValueOnce(research);
    const fixture = createRosterHost(request);
    const linkedListener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    const researchListener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    try {
      await fixture.sessions.refresh({ agentId: "main" });
      fixture.host.sessions.observe(
        { search: "linked", archived: "all", configuredAgentsOnly: false, limit: 1 },
        linkedListener,
      );
      fixture.host.sessions.observe({ agentId: "research", limit: 2 }, researchListener);
      await vi.waitFor(() => {
        expect(linkedListener).toHaveBeenLastCalledWith({
          loading: false,
          error: null,
          result: { sessions: found.sessions, hasMore: true, nextOffset: 1, totalCount: 2 },
        });
        expect(researchListener).toHaveBeenLastCalledWith({
          loading: false,
          error: null,
          result: { sessions: research.sessions, hasMore: false, nextOffset: null, totalCount: 1 },
        });
      });
      expect(fixture.host.sessions.rows).toEqual(primary.sessions);
      expect(fixture.sessions.state.agentId).toBe("main");
      expect(request.mock.calls[1]).toEqual([
        "sessions.list",
        {
          includeGlobal: true,
          includeUnknown: true,
          configuredAgentsOnly: false,
          limit: 1,
          archived: "all",
          search: "linked",
        },
      ]);
      const delivered = linkedListener.mock.lastCall?.[0].result?.sessions[0];
      if (!delivered) {
        throw new Error("Expected the observer to receive a session row");
      }
      Object.assign(delivered, { label: "Plugin-local edit" });
      expect(
        fixture.sessions.listSnapshot({
          search: "linked",
          archivedFilter: "all",
          configuredAgentsOnly: false,
          limit: 1,
        }).result?.sessions[0]?.label,
      ).toBe("Linked session");
      expect(fixture.host.sessions.rows).toEqual(primary.sessions);
    } finally {
      fixture.dispose();
    }
  });

  it("publishes session query errors and rejects failed refreshes while allowing recovery", async () => {
    const found = sessionsResult([{ key: "agent:writer:linked", kind: "direct", updatedAt: 1 }], 1);
    const request = vi.fn().mockRejectedValueOnce(new Error("Query unavailable"));
    const fixture = createRosterHost(request);
    const listener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    try {
      const observer = fixture.host.sessions.observe({ search: "linked" }, listener);
      await vi.waitFor(() => {
        expect(listener).toHaveBeenLastCalledWith({
          result: null,
          loading: false,
          error: "Query unavailable",
        });
        expect(fixture.runtime.errors).toContainEqual({
          pluginId: "review",
          message: "Query unavailable",
        });
      });
      request.mockResolvedValueOnce(found);
      await observer.refresh();
      const result = {
        sessions: found.sessions,
        hasMore: undefined,
        nextOffset: undefined,
        totalCount: undefined,
      };
      expect(listener).toHaveBeenLastCalledWith({ result, loading: false, error: null });
      request.mockRejectedValueOnce(new Error("Refresh unavailable"));
      await expect(observer.refresh()).rejects.toThrow("Refresh unavailable");
      expect(listener).toHaveBeenLastCalledWith({
        result,
        loading: false,
        error: "Refresh unavailable",
      });
      expect(fixture.sessions.state.result).toBeNull();
      expect(fixture.sessions.state.error).toBeNull();
    } finally {
      fixture.dispose();
    }
  });

  it("ends session query callbacks and refresh authority when its view is disposed", async () => {
    const first = sessionsResult([{ key: "agent:writer:first", kind: "direct", updatedAt: 1 }], 1);
    const next = sessionsResult([{ key: "agent:writer:next", kind: "direct", updatedAt: 2 }], 2);
    const pending = createDeferred<typeof next>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(first)
      .mockImplementationOnce(() => pending.promise);
    const fixture = createRosterHost(request);
    const view = new AbortController();
    const host = scopeControlUiHost(fixture.host, view.signal);
    const listener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    try {
      const observer = host.sessions.observe({ agentId: "writer", limit: 1 }, listener);
      await vi.waitFor(() => {
        expect(listener.mock.lastCall?.[0].result?.sessions).toEqual(first.sessions);
        expect(listener.mock.lastCall?.[0].loading).toBe(false);
      });
      const refresh = observer.refresh;
      const refreshing = expect(refresh()).rejects.toThrow();
      expect(request).toHaveBeenCalledTimes(2);
      const callbackCount = listener.mock.calls.length;
      view.abort();
      pending.resolve(next);
      await refreshing;
      expect(listener.mock.calls.length).toBe(callbackCount);
      expect(fixture.host.signal.aborted).toBe(false);
      expect(() => refresh()).toThrow("This plugin UI view has ended.");
      expect(request).toHaveBeenCalledTimes(2);
    } finally {
      view.abort();
      pending.resolve(next);
      fixture.dispose();
    }
  });

  it("stops notifications when an observer's initial callback disposes its view", () => {
    const request = vi.fn().mockResolvedValue(sessionsResult([], 1));
    const fixture = createRosterHost(request);
    const view = new AbortController();
    const host = scopeControlUiHost(fixture.host, view.signal);
    const callbackAbortedStates: boolean[] = [];
    try {
      expect(() =>
        host.sessions.observe({ agentId: "writer", limit: 1 }, () => {
          callbackAbortedStates.push(view.signal.aborted);
          view.abort();
        }),
      ).toThrow("This plugin UI view has ended.");
      expect(callbackAbortedStates).toEqual([false]);
    } finally {
      view.abort();
      fixture.dispose();
    }
  });

  it.each(["agents", "sessions"] as const)(
    "refreshes cached %s rows without discarding the current roster scope",
    async (surface) => {
      const firstAgents: AgentsListResult = {
        defaultId: "main",
        mainKey: "main",
        scope: "per-sender",
        agents: [{ id: "main" }],
      };
      const nextAgents: AgentsListResult = {
        ...firstAgents,
        agents: [...firstAgents.agents, { id: "research" }],
      };
      const firstSessions = sessionsResult(
        [{ key: "agent:research:old", kind: "direct", updatedAt: 1 }],
        1,
      );
      const nextSessions = sessionsResult(
        [{ key: "agent:research:new", kind: "direct", updatedAt: 2 }],
        2,
      );
      const request = vi
        .fn()
        .mockResolvedValueOnce(surface === "agents" ? firstAgents : firstSessions)
        .mockResolvedValueOnce(surface === "agents" ? nextAgents : nextSessions);
      const fixture = createRosterHost(request);
      try {
        if (surface === "agents") {
          await fixture.agents.ensureList();
        } else {
          await fixture.sessions.refresh({ agentId: "research", search: "draft", limit: 5 });
        }
        await fixture.host[surface].refresh();
        expect(fixture.host[surface].rows).toEqual(
          surface === "agents" ? nextAgents.agents : nextSessions.sessions,
        );
        expect(request).toHaveBeenCalledTimes(2);
        expect(request.mock.calls[1]).toEqual(request.mock.calls[0]);
      } finally {
        fixture.dispose();
      }
    },
  );

  it.each(["agents", "sessions"] as const)(
    "rejects a failed %s refresh through the SDK",
    async (surface) => {
      const request = vi.fn().mockRejectedValue(new Error("Roster unavailable"));
      const fixture = createRosterHost(request);
      try {
        await expect(fixture.host[surface].refresh()).rejects.toThrow();
        expect(request).toHaveBeenCalledOnce();
        expect(
          surface === "agents" ? fixture.agents.state.agentsError : fixture.sessions.state.error,
        ).toBe("Roster unavailable");
      } finally {
        fixture.dispose();
      }
    },
  );
});

describe("native UI session mutations", () => {
  it("patches a queried global owner without replacing the primary roster or its model", async () => {
    const primary = sessionsResult(
      [{ key: "global", kind: "global", agentId: "main", model: "main-model" }],
      1,
    );
    const queried = sessionsResult(
      [{ key: "global", kind: "global", agentId: "writer", model: "writer-model" }],
      2,
    );
    const patch = createDeferred<unknown>();
    const request = vi
      .fn()
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(queried)
      .mockImplementationOnce(() => patch.promise)
      .mockResolvedValueOnce(primary);
    const fixture = createRosterHost(request);
    const listener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    try {
      await fixture.sessions.refresh({ agentId: "main", search: "current", limit: 7 });
      fixture.host.sessions.observe({ agentId: "writer", includeGlobal: true }, listener);
      await vi.waitFor(() =>
        expect(listener.mock.lastCall?.[0].result?.sessions).toEqual(queried.sessions),
      );
      const session = listener.mock.lastCall?.[0].result?.sessions[0];
      if (!session) {
        throw new Error("Expected the queried global session");
      }

      const updating = fixture.host.sessions.patch(
        { sessionKey: session.key, agentId: session.agentId },
        { model: "replacement-model" },
      );
      const completed = expect(updating).resolves.toBeUndefined();
      expect(fixture.sessions.state.modelOverrides).toEqual({});
      patch.resolve({ key: "global", entry: { model: "replacement-model" } });
      await completed;

      expect(request).toHaveBeenCalledWith("sessions.patch", {
        key: "global",
        agentId: "writer",
        model: "replacement-model",
      });
      expect(request).toHaveBeenLastCalledWith(
        "sessions.list",
        expect.objectContaining({
          agentId: "main",
          search: "current",
          limit: 7,
        }),
      );
      expect(fixture.sessions.state.agentId).toBe("main");
      expect(fixture.sessions.state.modelOverrides).toEqual({});
      expect(fixture.host.sessions.rows).toEqual(primary.sessions);
    } finally {
      patch.resolve(null);
      fixture.dispose();
    }
  });

  it("rejects a session patch that its session owner could not complete", async () => {
    const request = vi.fn();
    const fixture = createRosterHost(request);
    fixture.sessions.dispose();
    try {
      await expect(
        fixture.host.sessions.patch(
          { sessionKey: "global", agentId: "writer" },
          { label: "Updated" },
        ),
      ).rejects.toThrow("The session update did not complete");
      expect(request).not.toHaveBeenCalled();
    } finally {
      fixture.dispose();
    }
  });
});

describe("native UI locale subscription", () => {
  it("publishes locale changes through the host and fences notifications after activation ends", async () => {
    const original = i18n.getLocale();
    const next = original === "de" ? "en" : "de";
    const subscribe = () => () => undefined;
    const context = {
      gateway: { subscribe },
      sessions: { subscribe },
      agents: { subscribe },
      agentSelection: { subscribe },
      theme: { subscribe },
    } as unknown as ApplicationContext<RouteId>;
    const abort = new AbortController();
    const owner = { abort, descriptor: { pluginId: "review" }, disposers: new Set() } as Omit<
      ControlUiPluginOwner,
      "host"
    >;
    const runtime = {
      isCurrent: (current: Omit<ControlUiPluginOwner, "host">) =>
        current === owner && !current.abort.signal.aborted,
    } as ControlUiPluginRuntime;
    const host = createControlUiPluginHost(() => context, runtime, owner);
    const notified = vi.fn(() => host.locale);
    const stop = host.subscribe(notified);
    try {
      await i18n.setLocale(next);
      expect(notified).toHaveReturnedWith(next);
      expect(notified).toHaveBeenCalledOnce();
      abort.abort();
      await i18n.setLocale(original);
      expect(notified).toHaveBeenCalledOnce();
    } finally {
      stop();
      await i18n.setLocale(original);
    }
  });
});

describe("native UI page navigation", () => {
  it("opens a queried global session with its owner before changing the selected key", async () => {
    const primary = sessionsResult(
      [{ key: "global", kind: "global", agentId: "main", boardFace: "dashboard" }],
      1,
    );
    const queried = sessionsResult(
      [{ key: "global", kind: "global", agentId: "writer", boardFace: "chat" }],
      2,
    );
    const request = vi.fn().mockResolvedValueOnce(primary).mockResolvedValueOnce(queried);
    const fixture = createRosterHost(request);
    const selection = createAgentSelectionCapability(
      {
        ...fixture.context.gateway,
        connection: { gatewayUrl: "ws://localhost:18789" },
      },
      fixture.agents,
    );
    const navigate = vi.fn();
    let selectedWhenKeyChanged: string | null = null;
    const setSessionKey = vi.fn(() => {
      selectedWhenKeyChanged = selection.state.selectedId;
    });
    Object.assign(fixture.context, { basePath: "", agentSelection: selection, navigate });
    Object.assign(fixture.context.gateway, { setSessionKey });
    const listener = vi.fn<(snapshot: ControlUiSessionListSnapshot) => void>();
    try {
      await fixture.sessions.refresh({ agentId: "main" });
      fixture.host.sessions.observe({ agentId: "writer", includeGlobal: true }, listener);
      await vi.waitFor(() =>
        expect(listener.mock.lastCall?.[0].result?.sessions).toEqual(queried.sessions),
      );
      const session = listener.mock.lastCall?.[0].result?.sessions[0];
      if (!session) {
        throw new Error("Expected the queried global session");
      }

      fixture.host.sessions.open({ sessionKey: session.key, agentId: session.agentId });

      expect(navigate).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ pathname: "/chat/writer" }),
      );
      expect(setSessionKey).toHaveBeenCalledWith("global");
      expect(selectedWhenKeyChanged).toBe("writer");
      expect(fixture.sessions.state.agentId).toBe("main");
      expect(fixture.host.sessions.rows).toEqual(primary.sessions);
    } finally {
      fixture.dispose();
    }
  });

  it.each([true, false])(
    "preserves scoped filters during replacement navigation (native route: %s)",
    (native) => {
      const originalUrl = window.location.href;
      window.history.replaceState(null, "", "/?agent=main&p.filter=ready");
      const navigate = vi.fn();
      const replace = vi.fn();
      const context = {
        basePath: "/console",
        gateway: {
          snapshot: {
            hello: {
              controlUiTabs: native
                ? [{ pluginId: "review", id: "board", placement: "route:workboard" }]
                : [],
            },
          },
        },
        navigate,
        replace,
      } as unknown as ApplicationContext<RouteId>;
      const abort = new AbortController();
      const owner = { abort, descriptor: { pluginId: "review" }, disposers: new Set() } as Omit<
        ControlUiPluginOwner,
        "host"
      >;
      const runtime = {
        isCurrent: (current: Omit<ControlUiPluginOwner, "host">) =>
          current === owner && !current.abort.signal.aborted,
      } as ControlUiPluginRuntime;
      const host = createControlUiPluginHost(() => context, runtime, owner);
      const target = { id: "board", path: ["Team / One"], params: { filter: "done" } };
      try {
        const location = new URL(
          host.navigation.pageHref(target, { preserveSearch: true }),
          window.location.origin,
        );
        expect(location.pathname).toBe(
          native ? "/console/workboard/Team%20%2F%20One" : "/console/plugin",
        );
        expect(location.searchParams.get("agent")).toBe("main");
        expect(location.searchParams.get("p.filter")).toBe("done");
        if (!native) {
          expect(location.searchParams.get("plugin")).toBe("review");
          expect(location.searchParams.get("id")).toBe("board");
        }
        host.navigation.openPage(target, { replace: true, preserveSearch: true });
        expect(replace).toHaveBeenCalledWith(
          native ? "workboard" : "plugin",
          expect.objectContaining({
            pathname: location.pathname,
            search: location.search,
          }),
        );
        expect(navigate).not.toHaveBeenCalled();
        expect(
          new URL(host.navigation.pageHref(target), window.location.origin).searchParams.has(
            "agent",
          ),
        ).toBe(false);
        abort.abort();
        expect(() => host.navigation.openPage(target)).toThrow("activation has ended");
      } finally {
        window.history.replaceState(null, "", originalUrl);
      }
    },
  );
});
