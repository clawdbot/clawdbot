import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { GatewaySessionRow, SessionsListResult } from "../../api/types.ts";
import { searchVisibleSessionTranscripts } from "./agent-scope.ts";

describe("searchVisibleSessionTranscripts", () => {
  it("batches every visible session within the protocol key limit", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ results: [] }));
    const sessions = Array.from(
      { length: 201 },
      (_, index) => ({ key: `agent:main:session-${index}` }) as GatewaySessionRow,
    );

    await searchVisibleSessionTranscripts({
      client: { request } as unknown as GatewayBrowserClient,
      query: "needle",
      result: { count: sessions.length, sessions } as SessionsListResult,
      listSessions: vi.fn(),
      listOptions: {},
      resolveAgentId: () => "main",
    });

    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ sessionKeys: sessions.slice(0, 200).map((row) => row.key) }),
    );
    expect(request.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ sessionKeys: [sessions[200]?.key] }),
    );
  });

  it("loads every session-list page before searching transcripts", async () => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ results: [] }));
    const firstPage = Array.from(
      { length: 200 },
      (_, index) => ({ key: `agent:main:session-${index}` }) as GatewaySessionRow,
    );
    const secondPage = Array.from(
      { length: 200 },
      (_, index) => ({ key: `agent:main:session-${index + 200}` }) as GatewaySessionRow,
    );
    const lastSession = { key: "agent:main:session-400" } as GatewaySessionRow;
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        count: secondPage.length,
        sessions: secondPage,
        hasMore: true,
      } as SessionsListResult)
      .mockResolvedValueOnce({
        count: 1,
        sessions: [lastSession],
        hasMore: false,
      } as SessionsListResult);

    await searchVisibleSessionTranscripts({
      client: { request } as unknown as GatewayBrowserClient,
      query: "needle",
      result: {
        count: firstPage.length,
        sessions: firstPage,
        hasMore: true,
      } as SessionsListResult,
      listSessions,
      listOptions: { activeMinutes: 60, agentId: "main" },
      resolveAgentId: () => "main",
    });

    expect(listSessions).toHaveBeenNthCalledWith(1, {
      activeMinutes: 60,
      agentId: "main",
      limit: 200,
      offset: 200,
    });
    expect(listSessions).toHaveBeenNthCalledWith(2, {
      activeMinutes: 60,
      agentId: "main",
      limit: 200,
      offset: 400,
    });
    expect(request).toHaveBeenCalledTimes(3);
    expect(request.mock.calls[2]?.[1]).toEqual(
      expect.objectContaining({ sessionKeys: [lastSession.key] }),
    );
  });

  it("recovers a moving thread when a later page omits the authoritative total", async () => {
    const first = { key: "agent:main:first" } as GatewaySessionRow;
    const moved = { key: "agent:main:moved" } as GatewaySessionRow;
    const missed = { key: "agent:main:missed" } as GatewaySessionRow;
    const request = vi.fn(async (_method: string, params: { sessionKeys: string[] }) => ({
      results: params.sessionKeys.includes(missed.key)
        ? [
            {
              sessionKey: missed.key,
              sessionId: "missed",
              messageId: "message-missed",
              role: "assistant" as const,
              timestamp: 1,
              snippet: "the missing launch code",
              score: 1,
            },
          ]
        : [],
    }));
    const listSessions = vi
      .fn()
      .mockResolvedValueOnce({
        count: 1,
        sessions: [moved],
        offset: 2,
        hasMore: false,
      } as SessionsListResult)
      .mockResolvedValueOnce({
        count: 2,
        totalCount: 3,
        sessions: [first, missed],
        offset: 0,
        nextOffset: 2,
        hasMore: true,
      } as SessionsListResult)
      .mockResolvedValueOnce({
        count: 1,
        totalCount: 3,
        sessions: [moved],
        offset: 2,
        hasMore: false,
      } as SessionsListResult);

    const found = await searchVisibleSessionTranscripts({
      client: { request } as unknown as GatewayBrowserClient,
      query: "launch code",
      result: {
        count: 2,
        totalCount: 3,
        sessions: [first, moved],
        nextOffset: 2,
        hasMore: true,
      } as SessionsListResult,
      listSessions,
      listOptions: { agentId: "main" },
      resolveAgentId: () => "main",
    });

    expect(found.results.map((result) => result.sessionKey)).toEqual([missed.key]);
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].sessionKeys).toEqual([first.key, moved.key, missed.key]);
    expect(listSessions.mock.calls.map(([options]) => options.offset)).toEqual([2, 0, 2]);
  });

  it.each([
    {
      label: "a later session page cannot be loaded",
      page: null,
      error: /load.*session|session.*load/i,
    },
    {
      label: "a later session page does not advance its cursor",
      page: {
        ts: 1,
        path: "",
        count: 0,
        defaults: { modelProvider: null, model: null, contextTokens: null },
        sessions: [],
        hasMore: true,
        nextOffset: 1,
      } satisfies SessionsListResult,
      error: /session.*advance|pagination.*advance/i,
    },
  ])("fails transcript search when $label", async ({ page, error }) => {
    const request = vi.fn(async (_method: string, _params: unknown) => ({ results: [] }));
    const listSessions = vi.fn().mockResolvedValueOnce(page);

    await expect(
      searchVisibleSessionTranscripts({
        client: { request } as unknown as GatewayBrowserClient,
        query: "needle",
        result: {
          ts: 1,
          path: "",
          count: 1,
          defaults: { modelProvider: null, model: null, contextTokens: null },
          sessions: [{ key: "agent:main:session-0", kind: "direct", updatedAt: 1 }],
          hasMore: true,
          nextOffset: 1,
        } satisfies SessionsListResult,
        listSessions,
        listOptions: { agentId: "main" },
        resolveAgentId: () => "main",
      }),
    ).rejects.toThrow(error);

    expect(listSessions).toHaveBeenCalledWith({ agentId: "main", limit: 200, offset: 1 });
    expect(request).not.toHaveBeenCalled();
  });
});
