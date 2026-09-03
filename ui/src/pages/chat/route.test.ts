// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute } from "./route-loader.ts";

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

function result(
  sessions: GatewaySessionRow[],
  options: Pick<SessionsListResult, "hasMore" | "nextOffset" | "offset"> = {},
): SessionsListResult {
  return {
    ts: 1,
    path: "sessions.json",
    count: sessions.length,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions,
    ...options,
  };
}

function contextFor(listResult: SessionsListResult | null, mainKey = "main") {
  const request = vi.fn(async (method: string, params: Record<string, unknown>) => {
    if (method === "sessions.resolve") {
      const shortId = typeof params.shortId === "string" ? params.shortId.toLowerCase() : "";
      const matches =
        listResult?.sessions.filter((session) =>
          session.key.toLowerCase().replaceAll("-", "").includes(shortId),
        ) ?? [];
      return matches.length === 1 && matches[0]
        ? {
            ok: true,
            key: matches[0].key,
            agentId: matches[0].agentId ?? matches[0].key.split(":")[1],
            displayName: matches[0].displayName,
            boardFace: matches[0].boardFace,
          }
        : {
            ok: false,
            ...(matches.length > 1
              ? {
                  candidates: matches.map((session) => ({
                    key: session.key,
                    agentId: session.agentId ?? session.key.split(":")[1],
                    displayName: session.displayName,
                    boardFace: session.boardFace,
                  })),
                }
              : {}),
          };
    }
    throw new Error(`Unexpected gateway request: ${method}`);
  });
  const client = { request };
  const list = vi.fn(async (_options?: { offset?: number; search?: string }) => listResult);
  const context = {
    basePath: "",
    gateway: {
      snapshot: { phase: "connected", client, hello: null },
      subscribe: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { mainKey } } },
    sessions: { list },
  } as unknown as ApplicationContext;
  return { context, list, request };
}

describe("loadChatRoute", () => {
  it("leaves a bare namespace unresolved instead of inventing a main session", async () => {
    const { context, list } = contextFor(result([]), "workspace");
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
    const { context, list, request } = contextFor(result([row()]));
    request.mockImplementation(async (method) => {
      if (method === "sessions.resolve") {
        return {
          ok: true,
          key: sessionKey,
          agentId: "main",
          displayName: "Deploy Monitor",
          boardFace: undefined,
        };
      }
      throw new Error(`Unexpected gateway request: ${method}`);
    });
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
    ).resolves.toEqual({ kind: "session", sessionKey, draft: "ship", face: "chat" });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("round-trips literal channel, peer, and cron keys without searching", async () => {
    const { context, list } = contextFor(result([]));
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
    const { context, list, request } = contextFor(result([target]));
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
      draft: undefined,
      face: "chat",
      shortId: "123456780a",
    });
    expect(list).not.toHaveBeenCalled();
    expect(request).toHaveBeenNthCalledWith(1, "sessions.resolve", {
      shortId: "123456780a",
      slugHint: "deploy-monitor",
      agentId: "main",
      allowMissing: true,
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
    const { context } = contextFor(result(rows));
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
        draft: "ship",
        focusComposer: true,
        face: "dashboard",
        shortId: candidate.idPrefix,
      });
    }
  });

  it("loads an agent main session without a search request", async () => {
    const { context, list } = contextFor(result([]));
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
    const { context, list } = contextFor(result([]), "workspace");
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
    const { context, list } = contextFor(result([]), "workspace");
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
    const { context, list } = contextFor(result([]));
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
    const { context } = contextFor(result([]));
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
    const { context } = contextFor(result([]));
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
