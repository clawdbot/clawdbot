// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import type { ApplicationContext } from "../../app/context.ts";
import { loadChatRoute, resolveSessionPrefix } from "./route.ts";

const sessionId = "12345678-90ab-cdef-1234-567890abcdef";

function row(overrides: Partial<GatewaySessionRow> = {}): GatewaySessionRow {
  return {
    key: `agent:main:dashboard:${sessionId}`,
    kind: "direct",
    updatedAt: 1,
    displayName: "Deploy Monitor",
    sessionId,
    ...overrides,
  };
}

function result(
  sessions: GatewaySessionRow[],
  options: { hasMore?: boolean } = {},
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

function contextFor(listResult: SessionsListResult) {
  const client = {};
  const list = vi.fn(async () => listResult);
  const context = {
    basePath: "",
    gateway: {
      snapshot: { phase: "connected", client, hello: null },
      subscribe: vi.fn(() => () => undefined),
    },
    agents: { state: { agentsList: { mainKey: "main" } } },
    sessions: { list },
  } as unknown as ApplicationContext;
  return { context, list };
}

describe("resolveSessionPrefix", () => {
  it("returns unique, ambiguous, and not-found outcomes", () => {
    expect(resolveSessionPrefix(result([row()]), "12345678")).toMatchObject({ kind: "unique" });
    expect(
      resolveSessionPrefix(
        result([
          row(),
          row({
            key: "agent:work:dashboard:12345678-ffff-ffff-ffff-ffffffffffff",
            sessionId: "12345678-ffff-ffff-ffff-ffffffffffff",
          }),
        ]),
        "12345678",
      ),
    ).toMatchObject({ kind: "ambiguous", truncated: false });
    expect(resolveSessionPrefix(result([]), "12345678")).toEqual({ kind: "not-found" });
  });

  it("drops substring matches that do not start the UUID", () => {
    expect(
      resolveSessionPrefix(
        result([
          row({
            sessionId: "aaaaaaaa-1234-5678-90ab-cdef12345678",
          }),
        ]),
        "12345678",
      ),
    ).toEqual({ kind: "not-found" });
  });

  it("treats a truncated search response as ambiguous", () => {
    expect(resolveSessionPrefix(result([row()], { hasMore: true }), "12345678")).toMatchObject({
      kind: "ambiguous",
      truncated: true,
    });
  });
});

describe("loadChatRoute", () => {
  it("ignores decorative agent and slug segments, then replaces with the canonical path", async () => {
    const { context, list } = contextFor(result([row()]));
    const signal = new AbortController().signal;
    const redirected = await loadChatRoute(
      context,
      {
        pathname: "/chat/wrong/not-the-name-12345678",
        search: "?draft=ship",
        hash: "",
      },
      "chat",
      signal,
    );
    expect(redirected).toEqual({
      kind: "session",
      sessionKey: `agent:main:dashboard:${sessionId}`,
      draft: "ship",
      face: "chat",
      canonicalLocation: {
        pathname: "/chat/main/deploy-monitor-12345678",
        search: "?draft=ship",
        hash: "",
      },
    });

    const loaded = await loadChatRoute(
      context,
      {
        pathname: "/chat/main/deploy-monitor-12345678",
        search: "?draft=ship",
        hash: "",
      },
      "chat",
      signal,
    );
    expect(loaded).toEqual({
      kind: "session",
      sessionKey: `agent:main:dashboard:${sessionId}`,
      draft: "ship",
      face: "chat",
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith(
      expect.objectContaining({ search: "12345678", limit: 20, archivedFilter: "all" }),
    );
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
});
