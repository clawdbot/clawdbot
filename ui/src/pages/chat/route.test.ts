// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { SessionsResolveResult } from "../../../../packages/gateway-protocol/src/index.js";
import type { GatewaySessionRow } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute } from "./route-loader.ts";
import { pages } from "./route.ts";

const keyUuid = "12345678-90ab-cdef-1234-567890abcdef";
const sessionKey = `agent:main:dashboard:${keyUuid}`;

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: sessionKey,
    kind: "direct",
    updatedAt: 1,
    displayName: "Deploy Monitor",
    sessionId: "fedcba98-7654-3210-fedc-ba9876543210",
    ...overrides,
  };
}

function contextFor(resolution: SessionsResolveResult = { ok: false }, mainKey = "main") {
  const request = vi.fn(async (method: string, _params: Record<string, unknown>) => {
    if (method === "sessions.resolve" || method === "chat.startup") {
      return method === "chat.startup" ? { resolution, messages: [] } : resolution;
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  const client = { request };
  const list = vi.fn();
  const context = {
    basePath: "",
    router: { getState: () => ({ matches: [], pendingMatches: [] }), subscribe: () => () => {} },
    gateway: {
      snapshot: { phase: "connected", client, hello: null },
      subscribe: vi.fn(() => () => undefined),
      subscribeEvents: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { mainKey } } },
    sessions: { list, state: { result: null }, whenCachedRosterSettled: async () => undefined },
  } as unknown as ApplicationContext;
  return { context, list, request };
}

describe("loadChatRoute", () => {
  it("leaves a bare namespace unresolved instead of inventing a main session", async () => {
    const { context, list } = contextFor({ ok: false }, "workspace");
    const loaded = await loadChatRoute(
      context,
      { pathname: "/chat", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );

    expect(loaded).toEqual({ type: "notFound", data: { routeId: "chat" } });
    expect(list).not.toHaveBeenCalled();
  });

  it("survives sessionId rotation and canonicalizes decorative short-form segments", async () => {
    const { context, list, request } = contextFor({ ok: true, ...row(), agentId: "main" });
    const signal = new AbortController().signal;
    const redirected = await loadChatRoute(
      context,
      { pathname: "/chat/main/not-the-name-12345678", search: "?draft=ship", hash: "" },
      "chat",
      signal,
    );
    expect(redirected).toEqual({
      kind: "session",
      sessionKey,
      agentId: "main",
      draft: "ship",
      face: "chat",
      canonicalLocation: {
        pathname: "/chat/main/deploy-monitor-12345678",
        search: "?draft=ship",
        hash: "",
      },
      canonicalLocationSource: {
        pathname: "/chat/main/not-the-name-12345678",
        search: "?draft=ship",
        hash: "",
      },
    });

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/deploy-monitor-12345678", search: "?draft=ship", hash: "" },
        "chat",
        signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey,
      agentId: "main",
      draft: "ship",
      face: "chat",
    });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledOnce();
  });

  it("round-trips literal channel, peer, and cron keys without searching", async () => {
    const { context, list } = contextFor();
    for (const [pathname, expectedKey] of [
      ["/chat/main/telegram/12345", "agent:main:telegram:12345"],
      ["/chat/ops/signal/direct/%2B15551212", "agent:ops:signal:direct:+15551212"],
      ["/chat/main/cron/nightly/run/8821", "agent:main:cron:nightly:run:8821"],
    ] as const) {
      await expect(
        loadChatRoute(
          context,
          { pathname, search: "", hash: "" },
          "chat",
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        kind: "session",
        sessionKey: expectedKey,
        draft: undefined,
        face: "chat",
      });
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("passes longer disambiguation prefixes directly to the gateway resolver", async () => {
    const target = row({ key: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001" });
    const { context, list, request } = contextFor({ ok: true, ...target, agentId: "main" });
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/deploy-monitor-123456780a", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: target.key,
      agentId: "main",
      draft: undefined,
      face: "chat",
      shortId: "123456780a",
    });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "chat.startup", {
      shortId: "123456780a",
      slugHint: "deploy-monitor",
      agentId: "main",
      limit: 80,
      maxBytes: 256 * 1024,
    });
  });

  it("builds distinct working links for ambiguous prefixes", async () => {
    const rows = [
      row({ key: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001" }),
      row({
        key: "agent:work:dashboard:12345678-0bbb-4000-8000-000000000002",
        displayName: "Deploy Monitor Two",
      }),
    ];
    const { context, request } = contextFor({
      ok: false,
      candidates: rows.map((session) => ({
        key: session.key,
        agentId: session.key.split(":")[1]!,
        displayName: session.displayName ?? undefined,
        boardFace: session.boardFace ?? undefined,
      })),
    });
    const ambiguous = await loadChatRoute(
      context,
      {
        pathname: "/dashboard/ignored/deploy-12345678",
        search: "?draft=ship&__openclawComposerFocus=1",
        hash: "",
      },
      "dashboard",
      new AbortController().signal,
    );
    expect(ambiguous).toMatchObject({ kind: "ambiguous", truncated: false });
    if (!("kind" in ambiguous) || ambiguous.kind !== "ambiguous") {
      throw new Error("expected an ambiguous route");
    }
    expect(ambiguous.candidates.map((candidate) => candidate.href)).toEqual([
      "/dashboard/main/deploy-monitor-123456780a?draft=ship&__openclawComposerFocus=1",
      "/dashboard/work/deploy-monitor-two-123456780b?draft=ship&__openclawComposerFocus=1",
    ]);

    for (const [candidate, expectedRow] of ambiguous.candidates.map(
      (entry, index) => [entry, rows[index]] as const,
    )) {
      request.mockResolvedValueOnce({ ok: true, ...expectedRow!, agentId: candidate.agentId });
      await expect(
        loadChatRoute(
          context,
          {
            pathname: new URL(candidate.href, "https://control.test").pathname,
            search: new URL(candidate.href, "https://control.test").search,
            hash: "",
          },
          "dashboard",
          new AbortController().signal,
        ),
      ).resolves.toEqual({
        kind: "session",
        sessionKey: expectedRow?.key,
        agentId: candidate.agentId,
        draft: "ship",
        focusComposer: true,
        face: "dashboard",
        shortId: candidate.idPrefix,
      });
    }
  });

  it("loads an agent main session without a search request", async () => {
    const { context, list } = contextFor();
    await expect(
      loadChatRoute(
        context,
        { pathname: "/dashboard/work", search: "", hash: "" },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:work:main",
      draft: undefined,
      face: "dashboard",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("carries expanded dashboard presentation into route data", async () => {
    const { context } = contextFor();
    await expect(
      loadChatRoute(
        context,
        { pathname: "/dashboard/work", search: "?dashboard=expanded", hash: "" },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:work:main",
      face: "dashboard",
      dashboardExpanded: true,
    });
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/work", search: "?dashboard=expanded", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:work:main",
      face: "chat",
      dashboardExpanded: true,
    });
  });

  it("waits for configured session defaults before resolving an agent main route", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const context = {
      basePath: "",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/research", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:research:workspace",
      draft: undefined,
      face: "chat",
    });
  });

  it("treats a configured main key as a reserved literal", async () => {
    const { context, list } = contextFor({ ok: false }, "workspace");
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/workspace", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:main:workspace",
      draft: undefined,
      face: "chat",
      canonicalLocation: { pathname: "/chat/main", search: "", hash: "" },
      canonicalLocationSource: { pathname: "/chat/main/workspace", search: "", hash: "" },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("canonicalizes a literal configured-main route when defaults are warm", async () => {
    const { context, list } = contextFor({ ok: false }, "workspace");
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/research/workspace", search: "?draft=ship", hash: "#pane" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:research:workspace",
      draft: "ship",
      face: "chat",
      canonicalLocation: {
        pathname: "/chat/research",
        search: "?draft=ship",
        hash: "#pane",
      },
      canonicalLocationSource: {
        pathname: "/chat/research/workspace",
        search: "?draft=ship",
        hash: "#pane",
      },
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("reclassifies a slug-shaped path after cold defaults reveal the main key", async () => {
    type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
    let listener: GatewayListener | null = null;
    let snapshot = {
      phase: "connecting",
      client: null,
      hello: null,
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const context = {
      basePath: "",
      gateway: {
        get snapshot() {
          return snapshot;
        },
        subscribe: (next: GatewayListener) => {
          listener = next;
          return () => undefined;
        },
      },
      agents: { state: { agentsList: null } },
    } as unknown as ApplicationContext;
    const pending = loadChatRoute(
      context,
      { pathname: "/chat/research/workspace", search: "", hash: "" },
      "chat",
      new AbortController().signal,
    );
    let settled = false;
    void pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    snapshot = {
      phase: "connected",
      client: {},
      hello: { snapshot: { sessionDefaults: { mainKey: "workspace" } } },
    } as unknown as ApplicationContext["gateway"]["snapshot"];
    const connectedListener = listener as GatewayListener | null;
    if (!connectedListener) {
      throw new Error("expected gateway readiness subscription");
    }
    connectedListener(snapshot);

    await expect(pending).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:research:workspace",
      draft: undefined,
      face: "chat",
      canonicalLocation: { pathname: "/chat/research", search: "", hash: "" },
      canonicalLocationSource: {
        pathname: "/chat/research/workspace",
        search: "",
        hash: "",
      },
    });
  });

  it("canonicalizes a literal configured-main route after cold defaults arrive", async () => {
    for (const [pathname, targetSessionKey, mainKey, expectedCanonicalLocation] of [
      [
        "/chat/research/team/primary",
        "agent:research:team:primary",
        "team:primary",
        { pathname: "/chat/research", search: "", hash: "" },
      ],
      ["/chat/research/main", "agent:research:main", "workspace", null],
    ] as const) {
      type GatewayListener = Parameters<ApplicationContext["gateway"]["subscribe"]>[0];
      let listener: GatewayListener | null = null;
      let snapshot = {
        phase: "connecting",
        client: null,
        hello: null,
      } as unknown as ApplicationContext["gateway"]["snapshot"];
      const context = {
        basePath: "",
        gateway: {
          get snapshot() {
            return snapshot;
          },
          subscribe: (next: GatewayListener) => {
            listener = next;
            return () => undefined;
          },
        },
        agents: { state: { agentsList: null } },
      } as unknown as ApplicationContext;
      const loaded = await loadChatRoute(
        context,
        { pathname, search: "", hash: "" },
        "chat",
        new AbortController().signal,
      );
      expect(loaded).toMatchObject({
        kind: "session",
        sessionKey: targetSessionKey,
        face: "chat",
      });
      if (!("kind" in loaded) || loaded.kind !== "session" || !loaded.canonicalLocationReady) {
        throw new Error("expected deferred main-session canonicalization");
      }

      snapshot = {
        phase: "connected",
        client: {},
        hello: { snapshot: { sessionDefaults: { mainKey } } },
      } as unknown as ApplicationContext["gateway"]["snapshot"];
      const connectedListener = listener as GatewayListener | null;
      if (!connectedListener) {
        throw new Error("expected gateway readiness subscription");
      }
      connectedListener(snapshot);

      await expect(loaded.canonicalLocationReady).resolves.toEqual(expectedCanonicalLocation);
    }
  });

  it("loads a specific synthetic catalog thread from its URL target", async () => {
    const { context, list } = contextFor();
    await expect(
      loadChatRoute(
        context,
        {
          pathname: "/chat/main",
          search: "?catalog=claude&host=gateway%3Alocal&thread=thread-2",
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:main:catalog:claude:gateway%3Alocal:thread-2",
      agentId: "main",
      draft: undefined,
      face: "chat",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("preserves the path agent for synthetic catalog sessions", async () => {
    const { context } = contextFor();
    await expect(
      loadChatRoute(
        context,
        {
          pathname: "/chat/research",
          search: "?catalog=claude&host=gateway%3Alocal&thread=thread-2",
          hash: "",
        },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "session",
      sessionKey: "agent:research:catalog:claude:gateway%3Alocal:thread-2",
      agentId: "research",
    });
  });

  it("loads synthetic catalog sessions in the dashboard namespace", async () => {
    const { context } = contextFor();
    await expect(
      loadChatRoute(
        context,
        {
          pathname: "/dashboard/research",
          search: "?catalog=claude&host=gateway%3Alocal&thread=thread-2",
          hash: "",
        },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "session",
      sessionKey: "agent:research:catalog:claude:gateway%3Alocal:thread-2",
      agentId: "research",
      draft: undefined,
      face: "dashboard",
    });
  });
});

describe("session route cache ownership", () => {
  it.each(pages)("isolates $id loader results across connection owners", (page) => {
    const { context } = contextFor();
    let snapshot = context.gateway.snapshot;
    let revision = 0;
    const gateway = {
      ...context.gateway,
      get snapshot() {
        return snapshot;
      },
      get connectionRevision() {
        return revision;
      },
    };
    const scopedContext = { ...context, gateway };
    const location = { pathname: `/${page.id}/main`, search: "", hash: "" };
    const cacheKey = () => page.loaderDeps!(scopedContext, location);
    const initial = cacheKey();

    snapshot = { ...snapshot, selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);
    snapshot = { ...snapshot, phase: "reconnecting", selfUser: null };
    expect(cacheKey()).toBe(initial);
    snapshot = { ...snapshot, phase: "connected", selfUser: { id: "first-user" } };
    expect(cacheKey()).toBe(initial);

    snapshot = { ...snapshot, selfUser: { id: "second-user" } };
    const replacementUser = cacheKey();
    expect(replacementUser).not.toBe(initial);
    revision += 1;
    const replacementCredentials = cacheKey();
    expect(replacementCredentials).not.toBe(replacementUser);
    expect(page.loaderDeps!({ ...scopedContext, gateway: { ...gateway } }, location)).not.toBe(
      replacementCredentials,
    );
  });
});
