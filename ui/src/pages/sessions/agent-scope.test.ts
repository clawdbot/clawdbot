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
});
