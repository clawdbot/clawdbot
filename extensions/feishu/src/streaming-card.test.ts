import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithSsrFGuardMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
}));

import {
  FeishuStreamingSession,
  mergeStreamingText,
  resolveStreamingCardSendMode,
} from "./streaming-card.js";

type StreamingSessionState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
};

function setStreamingSessionInternals(
  session: FeishuStreamingSession,
  values: {
    state: StreamingSessionState;
    lastUpdateTime?: number;
  },
): void {
  const internals = session as unknown as {
    state: StreamingSessionState;
    lastUpdateTime: number;
  };
  internals.state = values.state;
  if (values.lastUpdateTime !== undefined) {
    internals.lastUpdateTime = values.lastUpdateTime;
  }
}

describe("FeishuStreamingSession", () => {
  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.resetModules();
  });

  beforeEach(() => {
    vi.useRealTimers();
    fetchWithSsrFGuardMock.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function mockFetches(
    updateBodies: string[],
    failedContentUpdateIndexes: ReadonlySet<number> = new Set<number>(),
    replaceBodies: string[] = [],
    failedContentUpdateStatuses: ReadonlyMap<number, number> = new Map<number, number>(),
    failedReplaceStatuses: ReadonlyMap<number, number> = new Map<number, number>(),
  ): void {
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ url, init }: { url: string; init?: { body?: string } }) => {
        const release = vi.fn(async () => {});
        let ok = true;
        let status = 200;
        if (url.includes("/auth/")) {
          return {
            response: {
              ok: true,
              json: async () => ({
                code: 0,
                msg: "ok",
                tenant_access_token: "token",
                expire: 7200,
              }),
            },
            release,
          };
        }
        if (url.includes("/elements/content/content")) {
          const updateIndex = updateBodies.length;
          updateBodies.push(init?.body ?? "");
          if (failedContentUpdateIndexes.has(updateIndex)) {
            throw new Error(`content update ${updateIndex} failed`);
          }
          const failedStatus = failedContentUpdateStatuses.get(updateIndex);
          if (failedStatus !== undefined) {
            ok = false;
            status = failedStatus;
          }
        } else if (url.includes("/elements/content")) {
          const replaceIndex = replaceBodies.length;
          replaceBodies.push(init?.body ?? "");
          const failedStatus = failedReplaceStatuses.get(replaceIndex);
          if (failedStatus !== undefined) {
            ok = false;
            status = failedStatus;
          }
        }
        return {
          response: {
            ok,
            status,
            json: async () => ({ code: 0, msg: "ok" }),
          },
          release,
        };
      },
    );
  }

  it("flushes throttled pending text after the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const updateBodies: string[] = [];
    mockFetches(updateBodies);

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_pending_flush",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_1",
        messageId: "om_1",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 1_000,
    });

    await session.update("hello small");
    expect(updateBodies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(160);

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: " small",
      sequence: 2,
      uuid: "s_card_1_2",
    });
  });

  it("pushes natural-boundary updates immediately inside the throttle window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(2_000);
    const updateBodies: string[] = [];
    mockFetches(updateBodies);

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_boundary_flush",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_2",
        messageId: "om_2",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello!");

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: "!",
      sequence: 2,
      uuid: "s_card_2_2",
    });
  });

  it("retries unsent suffix content after a failed delta update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_000);
    const updateBodies: string[] = [];
    mockFetches(updateBodies, new Set([0]));

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_failed_delta_retry",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_3",
        messageId: "om_3",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello world");
    await session.update("hello world!");

    expect(updateBodies).toHaveLength(2);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: " world",
      sequence: 2,
      uuid: "s_card_3_2",
    });
    expect(JSON.parse(updateBodies[1] ?? "{}")).toEqual({
      content: " world!",
      sequence: 3,
      uuid: "s_card_3_3",
    });
  });

  it("retries unsent suffix content after a non-OK delta update", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(3_500);
    const updateBodies: string[] = [];
    mockFetches(updateBodies, new Set<number>(), [], new Map([[0, 429]]));

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_non_ok_delta_retry",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_5",
        messageId: "om_5",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello world");
    await session.update("hello world!");

    expect(updateBodies).toHaveLength(2);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toEqual({
      content: " world",
      sequence: 2,
      uuid: "s_card_5_2",
    });
    expect(JSON.parse(updateBodies[1] ?? "{}")).toEqual({
      content: " world!",
      sequence: 3,
      uuid: "s_card_5_3",
    });
  });

  it("replaces content when final text removes transient streamed status", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    mockFetches(updateBodies, new Set<number>(), replaceBodies);

    const session = new FeishuStreamingSession({} as never, {
      appId: "app_final_rewrite",
      appSecret: "secret",
    });
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_4",
        messageId: "om_4",
        sequence: 1,
        currentText: "🔎 Web Search\n\nfinal answer",
        sentText: "🔎 Web Search\n\nfinal answer",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await session.close("final answer");

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    const replacePayload = JSON.parse(replaceBodies[0] ?? "{}") as {
      element?: string;
      sequence?: number;
      uuid?: string;
    };
    expect({
      ...replacePayload,
      element: JSON.parse(replacePayload.element ?? "{}"),
    }).toEqual({
      element: {
        tag: "markdown",
        content: "final answer",
        element_id: "content",
      },
      sequence: 2,
      uuid: "r_card_4_2",
    });
  });

  it("logs a final replacement failure when CardKit returns non-OK", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_500);
    const updateBodies: string[] = [];
    const replaceBodies: string[] = [];
    mockFetches(
      updateBodies,
      new Set<number>(),
      replaceBodies,
      new Map<number, number>(),
      new Map([[0, 500]]),
    );
    const log = vi.fn();

    const session = new FeishuStreamingSession(
      {} as never,
      {
        appId: "app_final_rewrite_non_ok",
        appSecret: "secret",
      },
      log,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_6",
        messageId: "om_6",
        sequence: 1,
        currentText: "working\n\nfinal answer",
        sentText: "working\n\nfinal answer",
        hasNote: false,
      },
      lastUpdateTime: 3_000,
    });

    await session.close("final answer");

    expect(updateBodies).toHaveLength(0);
    expect(replaceBodies).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(
      "Final replace failed: Error: Replace card content failed with HTTP 500",
    );
  });
});

describe("mergeStreamingText", () => {
  it("prefers the latest full text when it already includes prior text", () => {
    expect(mergeStreamingText("hello", "hello world")).toBe("hello world");
  });

  it("keeps previous text when the next partial is empty or redundant", () => {
    expect(mergeStreamingText("hello", "")).toBe("hello");
    expect(mergeStreamingText("hello world", "hello")).toBe("hello world");
  });

  it("appends fragmented chunks without injecting newlines", () => {
    expect(mergeStreamingText("hello wor", "ld")).toBe("hello world");
    expect(mergeStreamingText("line1", "line2")).toBe("line1line2");
  });

  it("merges overlap between adjacent partial snapshots", () => {
    expect(mergeStreamingText("好的，让我", "让我再读取一遍")).toBe("好的，让我再读取一遍");
    expect(mergeStreamingText("revision_id: 552", "2，一点变化都没有")).toBe(
      "revision_id: 552，一点变化都没有",
    );
    expect(mergeStreamingText("abc", "cabc")).toBe("cabc");
  });
});

describe("resolveStreamingCardSendMode", () => {
  it("prefers message.reply when reply target and root id both exist", () => {
    expect(
      resolveStreamingCardSendMode({
        replyToMessageId: "om_parent",
        rootId: "om_topic_root",
      }),
    ).toBe("reply");
  });

  it("falls back to root create when reply target is absent", () => {
    expect(
      resolveStreamingCardSendMode({
        rootId: "om_topic_root",
      }),
    ).toBe("root_create");
  });

  it("uses create mode when no reply routing fields are provided", () => {
    expect(resolveStreamingCardSendMode()).toBe("create");
    expect(
      resolveStreamingCardSendMode({
        replyInThread: true,
      }),
    ).toBe("create");
  });
});
