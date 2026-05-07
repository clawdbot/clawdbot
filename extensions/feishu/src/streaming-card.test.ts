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
  hasNote: boolean;
};

function setStreamingSessionInternals(
  session: FeishuStreamingSession,
  values: {
    state: StreamingSessionState;
    lastUpdateTime?: number;
  },
) {
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

  function mockFetches(updateBodies: string[]) {
    fetchWithSsrFGuardMock.mockImplementation(
      async ({ url, init }: { url: string; init?: { body?: string } }) => {
        const release = vi.fn(async () => {});
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
          updateBodies.push(init?.body ?? "");
        }
        return {
          response: {
            ok: true,
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
        hasNote: false,
      },
      lastUpdateTime: 1_000,
    });

    await session.update("hello small");
    expect(updateBodies).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(160);

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toMatchObject({
      content: "hello small",
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
        hasNote: false,
      },
      lastUpdateTime: 2_000,
    });

    await session.update("hello!");

    expect(updateBodies).toHaveLength(1);
    expect(JSON.parse(updateBodies[0] ?? "{}")).toMatchObject({
      content: "hello!",
    });
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
