// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../test/helpers/promise.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { SESSION_FACE_PREFERENCE_PARAM } from "../../lib/sessions/route-navigation.ts";
import { loadChatRoute } from "./route-loader.ts";
import {
  createSessionRouteContext,
  createSessionRouteRow,
  installShortSessionResolver,
  sessionRouteListResult,
} from "./route-resolution.test-support.ts";

function warmRoute(scope: "per-sender" | "global" = "per-sender") {
  const fixture = createSessionRouteContext();
  const { context } = fixture;
  const connectedClient = context.gateway.snapshot.client;
  const listeners = new Set<Parameters<ApplicationContext["gateway"]["subscribe"]>[0]>();
  context.gateway.snapshot.phase = "connecting";
  context.gateway.snapshot.client = null;
  context.gateway.subscribe = vi.fn((listener) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  });
  context.agents.state.agentsList = {
    defaultId: "roboclaw",
    mainKey: "workspace",
    scope,
    agents: [{ id: "roboclaw" }],
  };
  context.agents.state.agentsListCached = true;
  const cache = createDeferred();
  context.sessions.whenCachedRosterSettled = vi.fn(() => cache.promise);
  return {
    ...fixture,
    cache,
    connect(this: void) {
      context.gateway.snapshot.phase = "connected";
      context.gateway.snapshot.client = connectedClient;
      for (const listener of listeners) {
        listener(context.gateway.snapshot);
      }
    },
    installResolver: (rows: GatewaySessionRow[]) => {
      context.gateway.snapshot.client = connectedClient;
      const request = installShortSessionResolver(context, rows);
      context.gateway.snapshot.client = null;
      return request;
    },
  };
}

describe("cached session route startup", () => {
  it("resolves an explicit main route before connecting with per-sender defaults", async () => {
    const { context, request } = warmRoute();

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/roboclaw", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({ kind: "session", sessionKey: "agent:roboclaw:workspace" });

    expect(context.gateway.subscribe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it("keeps a global main route waiting for hello", async () => {
    const { context, connect } = warmRoute("global");
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);

    await vi.waitFor(() => expect(context.gateway.subscribe).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(expect.objectContaining({ kind: "session" }));
  });

  it("resolves a global-scope literal route once hello makes its defaults authoritative", async () => {
    const { context, connect, installResolver } = warmRoute("global");
    const row = createSessionRouteRow({ key: "agent:roboclaw:thread" });
    const request = installResolver([row]);
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/thread", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);

    await vi.waitFor(() => expect(context.gateway.subscribe).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    connect();
    await pending;
    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "session", sessionKey: row.key }),
    );
    expect(request).toHaveBeenCalledOnce();
  });

  it("waits for the cached roster and resolves a unique short route before hello", async () => {
    const { context, cache, request } = warmRoute();
    const row = createSessionRouteRow({ displayName: "Cached conversation" });
    const completed = vi.fn();
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/roboclaw/cached-conversation-12345678", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    ).then(completed);

    await vi.waitFor(() => expect(context.sessions.whenCachedRosterSettled).toHaveBeenCalledOnce());
    expect(completed).not.toHaveBeenCalled();
    context.sessions.state.result = sessionRouteListResult([row]);
    context.sessions.state.resultCached = true;
    cache.resolve();
    await pending;

    expect(completed).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "session",
        sessionKey: row.key,
      }),
    );
    expect(context.gateway.subscribe).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });

  it.each(["missing", "ambiguous", "global", "preference"] as const)(
    "keeps %s cached short resolution on the Gateway path",
    async (scenario) => {
      const { context, cache, connect, installResolver } = warmRoute(
        scenario === "global" ? "global" : "per-sender",
      );
      const row = createSessionRouteRow({ displayName: "Cached conversation" });
      const duplicate = createSessionRouteRow({
        key: "agent:roboclaw:thread:12345678-0aaa-4000-8000-000000000001",
        displayName: "Cached conversation",
      });
      context.sessions.state.result = sessionRouteListResult(
        scenario === "missing" ? [] : scenario === "ambiguous" ? [row, duplicate] : [row],
      );
      const request = installResolver([row]);
      cache.resolve();
      const completed = vi.fn();
      const pending = loadChatRoute(
        context,
        {
          pathname: "/chat/roboclaw/cached-conversation-12345678",
          search: scenario === "preference" ? `?${SESSION_FACE_PREFERENCE_PARAM}=1` : "",
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ).then(completed);

      await vi.waitFor(() => expect(context.gateway.subscribe).toHaveBeenCalled());
      expect(completed).not.toHaveBeenCalled();
      expect(request).not.toHaveBeenCalled();
      connect();
      await pending;
      expect(completed).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: "session",
          sessionKey: row.key,
        }),
      );
      expect(request).toHaveBeenCalledOnce();
    },
  );
});
