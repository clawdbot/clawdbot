// Telegram tests cover audit plugin behavior.
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

let collectTelegramUnmentionedGroupIds: typeof import("./audit.js").collectTelegramUnmentionedGroupIds;
let auditTelegramGroupMembership: typeof import("./audit.js").auditTelegramGroupMembership;
const fetchWithTimeoutMock = vi.hoisted(() => vi.fn());
const resolveTelegramFetchMock = vi.hoisted(() => vi.fn(() => fetchWithTimeoutMock));
const resolveTelegramApiBaseMock = vi.hoisted(() => vi.fn(() => "https://api.telegram.org"));

vi.mock("openclaw/plugin-sdk/text-utility-runtime", () => ({
  fetchWithTimeout: fetchWithTimeoutMock,
}));

vi.mock("openclaw/plugin-sdk/string-coerce-runtime", () => ({
  isRecord: (value: unknown): value is Record<string, unknown> =>
    typeof value === "object" && value !== null,
  normalizeOptionalString: (value: unknown) => {
    if (typeof value !== "string") {
      return undefined;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : undefined;
  },
}));

function mockGetChatMemberStatus(status: string) {
  fetchWithTimeoutMock.mockResolvedValueOnce(
    new Response(JSON.stringify({ ok: true, result: { status } }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function auditSingleGroup() {
  return auditTelegramGroupMembership({
    token: "t",
    botId: 123,
    groupIds: ["-1001"],
    timeoutMs: 5000,
  });
}

function makeStallingJsonResponse(payload: unknown, cancel: (reason?: unknown) => void): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));
      },
      cancel,
    }),
    {
      status: 200,
      headers: { "content-type": "application/json" },
    },
  );
}

describe("telegram audit", () => {
  beforeAll(async () => {
    vi.doMock("./fetch.js", () => ({
      resolveTelegramApiBase: resolveTelegramApiBaseMock,
      resolveTelegramFetch: resolveTelegramFetchMock,
    }));
    ({ collectTelegramUnmentionedGroupIds, auditTelegramGroupMembership } =
      await import("./audit.js"));
  });

  beforeEach(() => {
    fetchWithTimeoutMock.mockReset();
    resolveTelegramFetchMock.mockClear();
    resolveTelegramApiBaseMock.mockClear();
  });

  it("collects unmentioned numeric group ids and flags wildcard", () => {
    const res = collectTelegramUnmentionedGroupIds({
      "*": { requireMention: false },
      "-1001": { requireMention: false },
      "@group": { requireMention: false },
      "-1002": { requireMention: true },
      "-1003": { requireMention: false, enabled: false },
    });
    expect(res.hasWildcardUnmentionedGroups).toBe(true);
    expect(res.groupIds).toEqual(["-1001"]);
    expect(res.unresolvedGroups).toBe(1);
  });

  it("audits membership via getChatMember", async () => {
    mockGetChatMemberStatus("member");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(true);
    expect(res.groups[0]?.chatId).toBe("-1001");
    expect(res.groups[0]?.status).toBe("member");
    expect(resolveTelegramFetchMock).toHaveBeenCalled();
  });

  it("reports bot not in group when status is left", async () => {
    mockGetChatMemberStatus("left");
    const res = await auditSingleGroup();
    expect(res.ok).toBe(false);
    expect(res.groups[0]?.ok).toBe(false);
    expect(res.groups[0]?.status).toBe("left");
  });

  it("reports stalled getChatMember response bodies quickly", async () => {
    const cancel = vi.fn();
    fetchWithTimeoutMock.mockResolvedValueOnce(
      makeStallingJsonResponse({ ok: true, result: { status: "member" } }, cancel),
    );

    vi.useFakeTimers();
    try {
      const auditPromise = auditTelegramGroupMembership({
        token: "t",
        botId: 123,
        groupIds: ["-1001"],
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(60);

      const res = await auditPromise;
      expect(res.ok).toBe(false);
      expect(res.groups[0]?.ok).toBe(false);
      expect(res.groups[0]?.error).toBe("Telegram membership audit response body stalled for 25ms");
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(cancel.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shares one timeout budget across sequential membership checks", async () => {
    const cancel = vi.fn();
    fetchWithTimeoutMock
      .mockImplementationOnce(
        async () =>
          await new Promise<Response>((resolve) => {
            setTimeout(() => {
              resolve(
                new Response(JSON.stringify({ ok: true, result: { status: "member" } }), {
                  status: 200,
                }),
              );
            }, 40);
          }),
      )
      .mockResolvedValueOnce(
        makeStallingJsonResponse({ ok: true, result: { status: "member" } }, cancel),
      );

    vi.useFakeTimers();
    try {
      const auditPromise = auditTelegramGroupMembership({
        token: "t",
        botId: 123,
        groupIds: ["-1001", "-1002"],
        timeoutMs: 50,
      });
      await vi.advanceTimersByTimeAsync(60);

      const result = await auditPromise;
      expect(result.groups[0]?.ok).toBe(true);
      expect(result.groups[1]?.error).toBe(
        "Telegram membership audit response body stalled for 5ms",
      );
      expect(fetchWithTimeoutMock).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining("chat_id=-1002"),
        {},
        10,
        fetchWithTimeoutMock,
      );
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
