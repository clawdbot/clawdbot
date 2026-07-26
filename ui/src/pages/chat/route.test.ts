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
  const client = {};
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
  return { context, list };
}

describe("loadChatRoute", () => {
  it("survives sessionId rotation and canonicalizes decorative short-form segments", async () => {
    const { context, list } = contextFor(result([row()]));
    list
      .mockResolvedValueOnce(result([row({ sessionId: "before-compaction" })]))
      .mockResolvedValueOnce(result([row({ sessionId: "after-compaction" })]));
    const signal = new AbortController().signal;
    const redirected = await loadChatRoute(
      context,
      { pathname: "/chat/wrong/not-the-name-12345678", search: "?draft=ship", hash: "" },
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
    });

    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/deploy-monitor-12345678", search: "?draft=ship", hash: "" },
        "chat",
        signal,
      ),
    ).resolves.toEqual({ kind: "session", sessionKey, draft: "ship", face: "chat" });
    expect(list).toHaveBeenCalledTimes(2);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ search: "12345678", limit: 20, archivedFilter: "all" }),
    );
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

  it("queries the full supplied prefix so longer disambiguation links can resolve", async () => {
    const target = row({ key: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001" });
    const { context, list } = contextFor(result([target]));
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
    });
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ search: "123456780a" }));
    expect(list).not.toHaveBeenCalledWith(expect.objectContaining({ search: "12345678" }));
  });

  it("stops prefix pagination at the fixed bound and reports an incomplete result", async () => {
    const target = row({ key: "agent:main:dashboard:12345678-0aaa-4000-8000-000000000001" });
    const { context, list } = contextFor(result([]));
    for (let page = 0; page < 5; page += 1) {
      list.mockResolvedValueOnce(
        result(page === 0 ? [target] : [], {
          hasMore: true,
          nextOffset: (page + 1) * 20,
          offset: page * 20,
        }),
      );
    }
    await expect(
      loadChatRoute(
        context,
        { pathname: "/dashboard/main/deploy-12345678", search: "", hash: "" },
        "dashboard",
        new AbortController().signal,
      ),
    ).resolves.toMatchObject({
      kind: "ambiguous",
      shortId: "12345678",
      truncated: true,
      candidates: [{ href: expect.stringContaining("123456780aaa40008000000000000001") }],
    });
    expect(list).toHaveBeenCalledTimes(5);
    expect(list.mock.calls.map(([options]) => options?.offset)).toEqual([
      undefined,
      20,
      40,
      60,
      80,
    ]);
  });

  it("does not reinterpret a bounded incomplete search with zero matches as literal", async () => {
    const { context, list } = contextFor(result([]));
    for (let page = 0; page < 5; page += 1) {
      list.mockResolvedValueOnce(
        result([], {
          hasMore: true,
          nextOffset: (page + 1) * 20,
          offset: page * 20,
        }),
      );
    }
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/deadbeef", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).resolves.toEqual({
      kind: "ambiguous",
      shortId: "deadbeef",
      candidates: [],
      truncated: true,
      face: "chat",
    });
    expect(list).toHaveBeenCalledTimes(5);
  });

  it("stops after one unavailable session-list result", async () => {
    const { context, list } = contextFor(null);
    await expect(
      loadChatRoute(
        context,
        { pathname: "/chat/main/deadbeef", search: "", hash: "" },
        "chat",
        new AbortController().signal,
      ),
    ).rejects.toThrow("Session list unavailable while resolving URL");
    expect(list).toHaveBeenCalledTimes(1);
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
      { pathname: "/dashboard/ignored/deploy-12345678", search: "?draft=ship", hash: "" },
      "dashboard",
      new AbortController().signal,
    );
    expect(ambiguous).toMatchObject({ kind: "ambiguous", truncated: false });
    if (!("kind" in ambiguous) || ambiguous.kind !== "ambiguous") {
      throw new Error("expected an ambiguous route");
    }
    expect(ambiguous.candidates.map((candidate) => candidate.href)).toEqual([
      "/dashboard/main/deploy-monitor-123456780a?draft=ship",
      "/dashboard/work/deploy-monitor-two-123456780b?draft=ship",
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
        face: "dashboard",
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
    });
    expect(list).not.toHaveBeenCalled();
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
      sessionKey: "catalog:claude:gateway%3Alocal:thread-2",
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
      sessionKey: "catalog:claude:gateway%3Alocal:thread-2",
      agentId: "research",
    });
  });
});
