// @vitest-environment node
import { createRouter, definePage } from "@openclaw/uirouter";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewayEventFrame } from "../../api/gateway.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { chatHistoryRequests } from "./chat-history-state.ts";
import { createState } from "./chat-history.inflight.test-support.ts";
import { loadChatHistory } from "./chat-history.ts";
import { loadChatRoute } from "./route-loader.ts";
import type { ChatRouteData } from "./session-route-data.ts";

const sessionKey = "agent:main:dashboard:12345678-90ab-cdef-1234-567890abcdef";
const message = { role: "assistant", content: "Selected conversation", id: "reply" };
const cleanups: Array<() => void> = [];
afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) {
    cleanup();
  }
});

function fixture() {
  const lifecycle = new AbortController();
  const router = createRouter<"chat" | "other", ApplicationContext, null, ChatRouteData>({
    routes: [
      definePage({
        id: "chat",
        path: "/chat",
        component: () => null,
        loader: (context, { location, signal }) => loadChatRoute(context, location, "chat", signal),
      }),
      definePage({ id: "other", path: "/other", component: () => null }),
    ],
  });
  cleanups.push(() => {
    lifecycle.abort();
    router.stop();
  });
  const events = new Set<(event: GatewayEventFrame) => void>();
  const history = {
    messages: [message],
    sessionInfo: { key: sessionKey, kind: "direct", updatedAt: 1 },
  };
  const request = vi.fn(async (method: string) => {
    if (method !== "chat.startup") {
      throw new Error(`Unexpected request: ${method}`);
    }
    return {
      ...history,
      resolution: {
        ok: true,
        key: sessionKey,
        agentId: "main",
        displayName: "Selected conversation",
      },
    };
  });
  const state = createState({});
  state.client = { request } as unknown as NonNullable<typeof state.client>;
  state.sessionKey = sessionKey;
  const snapshot = { phase: "connected", client: state.client, hello: state.hello };
  const context = {
    basePath: "",
    router,
    lifecycleAbortSignal: lifecycle.signal,
    gateway: {
      snapshot,
      subscribe: () => () => {},
      subscribeEvents: (listener: (event: GatewayEventFrame) => void) => {
        events.add(listener);
        return () => events.delete(listener);
      },
    },
    agents: { state: { agentsList: { mainKey: "main" } } },
    sessions: {
      canonicalListRevision: 1,
      list: vi.fn(),
      state: { result: null },
      whenCachedRosterSettled: async () => undefined,
    },
  } as unknown as ApplicationContext;
  const loadRoute = async () => {
    await router.navigate("chat", context, undefined, {
      pathname: "/chat/main/selected-conversation-12345678",
      search: "",
      hash: "",
    });
    return router.getState().matches[0]?.data;
  };
  return { context, lifecycle, router, events, loadRoute, request, state };
}

describe("short chat startup", () => {
  it("renders the selected short-link history using the authoritative startup reply once", async () => {
    const h = fixture();
    await expect(h.loadRoute()).resolves.toMatchObject({ kind: "session", sessionKey });
    vi.useFakeTimers();
    const read = createDeferred();
    chatHistoryRequests(h.state).initialSnapshotHydration = {
      sessionKey,
      promise: read.promise,
      startedBeforeReady: true,
    };
    const loading = loadChatHistory(h.state, { startup: true, deferBranches: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.state.chatMessages).toEqual([message]);
    read.resolve();
    await loading;
    expect(h.request).toHaveBeenCalledOnce();
    expect(h.request).toHaveBeenCalledWith(
      "chat.startup",
      expect.objectContaining({ shortId: "12345678", agentId: "main" }),
    );
    expect(h.events.size).toBe(0);
  });

  it.each(["abort", "reconnect", "event", "replacement", "disconnect"] as const)(
    "rejects a startup handoff after %s",
    async (change) => {
      const h = fixture();
      await h.loadRoute();
      if (change === "abort") {
        h.router.getState().matches[0]!.abortController.abort();
      }
      if (change === "reconnect") {
        h.context.gateway.snapshot.hello = { ...h.state.hello } as typeof h.state.hello;
      }
      if (change === "event") {
        for (const listener of h.events) {
          listener({ type: "event", event: "session.message", payload: { sessionKey } });
        }
      }
      if (change === "replacement") {
        await h.router.navigate("other", h.context);
      }
      if (change === "disconnect") {
        h.lifecycle.abort();
      }
      await loadChatHistory(h.state, { startup: true, deferBranches: true });
      expect(h.request).toHaveBeenCalledTimes(2);
      expect(h.request).toHaveBeenLastCalledWith(
        "chat.startup",
        expect.objectContaining({ sessionKey }),
      );
      expect(h.events.size).toBe(0);
    },
  );

  it("retains a successful route's startup through a slow first render", async () => {
    vi.useFakeTimers();
    try {
      const h = fixture();
      await h.loadRoute();
      expect(h.events.size).toBe(1);
      await vi.advanceTimersByTimeAsync(2_001);
      expect(h.events.size).toBe(1);
      await loadChatHistory(h.state, { startup: true, deferBranches: true });
      expect(h.request).toHaveBeenCalledOnce();
      expect(h.events.size).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
