// Tests for dead-stream detection and non-streaming fallback in FeishuStreamingSession.
// Covers issue #139443: after a 200850 idle timeout, 300309 "streaming mode is closed"
// floods logs with ~978 consecutive retries. The fix marks the stream dead after the
// first 300309 and falls back to im.message.patch (non-streaming) at close.

import type { LookupFn } from "openclaw/plugin-sdk/ssrf-runtime";
import { withFetchPreconnect } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { FeishuStreamingFinalizationError, FeishuStreamingSession } from "./streaming-card.js";

type FeishuStreamingFetch = typeof fetch;

const HERMETIC_PUBLIC_LOOKUP_ADDRESS = "93.184.216.34";

const hermeticPublicLookup: LookupFn = async () => [
  { address: HERMETIC_PUBLIC_LOOKUP_ADDRESS, family: 4 },
];

type StreamingFetchDeps = {
  fetchImpl: FeishuStreamingFetch;
  lookupFn: LookupFn;
};

function createMemoryFetch(
  handler: (url: URL, body: string) => Response | Promise<Response>,
): StreamingFetchDeps {
  return {
    fetchImpl: withFetchPreconnect(
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const body = typeof init?.body === "string" ? init.body : "";
        return await handler(url, body);
      }),
    ) as FeishuStreamingFetch,
    lookupFn: hermeticPublicLookup,
  };
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

type StreamingSessionState = {
  cardId: string;
  messageId: string;
  sequence: number;
  currentText: string;
  sentText: string;
  hasNote: boolean;
  header?: { title: string; template?: string };
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

describe("FeishuStreamingSession dead-stream handling", () => {
  it("marks the stream dead after a 300309 update error and skips further updates", async () => {
    const updateBodies: string[] = [];
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/elements/content/content")) {
        updateBodies.push(body);
        // First update: return 300309 to simulate dead stream
        return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_dead_stream", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_dead_stream",
        messageId: "om_dead_stream",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 0,
    });

    // First update — should get 300309 and mark stream dead
    await session.update("hello world");
    expect(updateBodies).toHaveLength(1);

    // Second update — should be skipped (stream is dead)
    await session.update("hello world again");
    await session.update("hello world third time");

    // Still only 1 update attempt — no log flooding
    expect(updateBodies).toHaveLength(1);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Streaming card stream is dead"));
  });

  it("falls back to im.message.patch at close when stream is dead", async () => {
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      // All streaming API calls return 300309
      return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
    });
    const log = vi.fn();

    // Mock the Feishu SDK client with im.message.patch
    const patchMock = vi.fn().mockResolvedValue({ code: 0, msg: "ok" });
    const client = {
      im: {
        message: {
          patch: patchMock,
        },
      },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];

    const session = new FeishuStreamingSession(
      client,
      { appId: "app_dead_close", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_dead_close",
        messageId: "om_dead_close",
        sequence: 1,
        currentText: "partial text",
        sentText: "partial text",
        hasNote: true,
      },
    });

    // Simulate stream already dead (from a prior 300309 during updates)
    (session as unknown as { streamDead: boolean }).streamDead = true;

    const result = await session.closeWithResult("final answer text", {
      note: "model/provider info",
    });

    // Should have used im.message.patch as fallback
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith({
      path: { message_id: "om_dead_close" },
      data: {
        content: expect.stringContaining("final answer text"),
      },
    });

    // Should report visible content sent
    expect(result.visibleReplySent).toBe(true);
    expect(result.content).toBe("final answer text");

    // Should log the non-streaming fallback
    expect(log).toHaveBeenCalledWith(expect.stringContaining("non-streaming fallback"));
  });

  it("throws FeishuStreamingFinalizationError when non-streaming fallback also fails", async () => {
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
    });
    const log = vi.fn();

    const patchMock = vi.fn().mockResolvedValue({ code: 94003, msg: "message not found" });
    const client = {
      im: {
        message: {
          patch: patchMock,
        },
      },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];

    const session = new FeishuStreamingSession(
      client,
      { appId: "app_dead_fallback_fail", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_dead_fallback_fail",
        messageId: "om_dead_fallback_fail",
        sequence: 1,
        currentText: "partial",
        sentText: "partial",
        hasNote: false,
      },
    });

    (session as unknown as { streamDead: boolean }).streamDead = true;

    const error = await session.closeWithResult("final text").catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(FeishuStreamingFinalizationError);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Non-streaming card fallback failed"));
  });

  it("marks stream dead after a 200850 idle timeout on update", async () => {
    const updateBodies: string[] = [];
    const deps = createMemoryFetch((url, body) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (url.pathname.includes("/elements/content/content")) {
        updateBodies.push(body);
        return jsonResponse({ code: 200850, msg: "card streaming timeout" });
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const session = new FeishuStreamingSession(
      {} as never,
      { appId: "app_idle_timeout", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_idle_timeout",
        messageId: "om_idle_timeout",
        sequence: 1,
        currentText: "hello",
        sentText: "hello",
        hasNote: false,
      },
      lastUpdateTime: 0,
    });

    await session.update("hello extended");
    // Only one update attempt — stream is now dead
    expect(updateBodies).toHaveLength(1);

    await session.update("hello extended again");
    expect(updateBodies).toHaveLength(1); // still 1 — no retry flood

    expect(log).toHaveBeenCalledWith(expect.stringContaining("Streaming card stream is dead"));
  });

  it("preserves the card header in the non-streaming fallback content", async () => {
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
    });
    const log = vi.fn();
    const patchMock = vi.fn().mockResolvedValue({ code: 0, msg: "ok" });
    const client = {
      im: { message: { patch: patchMock } },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
    const session = new FeishuStreamingSession(
      client,
      { appId: "app_header", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_header",
        messageId: "om_header",
        sequence: 1,
        currentText: "partial",
        sentText: "partial",
        hasNote: false,
        header: { title: "Agent Run", template: "green" },
      },
    });
    (session as unknown as { streamDead: boolean }).streamDead = true;

    await session.closeWithResult("final text");

    expect(patchMock).toHaveBeenCalledTimes(1);
    const fallbackContent = JSON.parse(patchMock.mock.calls[0]![0]!.data.content as string);
    expect(fallbackContent.header).toEqual({
      title: { tag: "plain_text", content: "Agent Run" },
      template: "green",
    });
    expect(fallbackContent.body.elements[0].content).toBe("final text");
  });

  it("retries via non-streaming fallback when the final write first detects expiration", async () => {
    let updateCallCount = 0;
    const deps = createMemoryFetch((url) => {
      if (url.pathname.includes("/auth/")) {
        return jsonResponse({
          code: 0,
          msg: "ok",
          tenant_access_token: "token",
          expire: 7200,
        });
      }
      if (
        url.pathname.includes("/elements/content/content") ||
        url.pathname.includes("/elements/content")
      ) {
        updateCallCount += 1;
        // The final write detects stream expiration (300309)
        return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
      }
      // CardKit settings PATCH (close streaming mode) — should also fail
      if (url.pathname.includes("/settings")) {
        return jsonResponse({ code: 300309, msg: "streaming mode is closed" });
      }
      return jsonResponse({ code: 0, msg: "ok" });
    });
    const log = vi.fn();
    const patchMock = vi.fn().mockResolvedValue({ code: 0, msg: "ok" });
    const client = {
      im: { message: { patch: patchMock } },
    } as unknown as ConstructorParameters<typeof FeishuStreamingSession>[0];
    const session = new FeishuStreamingSession(
      client,
      { appId: "app_final_expire", appSecret: "secret" },
      log,
      deps,
    );
    setStreamingSessionInternals(session, {
      state: {
        cardId: "card_final_expire",
        messageId: "om_final_expire",
        sequence: 1,
        currentText: "partial text",
        sentText: "partial text",
        hasNote: false,
      },
    });
    // Stream is NOT dead yet — it will die during the final write
    (session as unknown as { streamDead: boolean }).streamDead = false;

    const result = await session.closeWithResult("final answer");

    // The final update attempted a streaming patch and got 300309
    expect(updateCallCount).toBeGreaterThanOrEqual(1);
    // After 300309, streamDead is set and the non-streaming fallback is retried
    expect(patchMock).toHaveBeenCalledTimes(1);
    expect(patchMock).toHaveBeenCalledWith({
      path: { message_id: "om_final_expire" },
      data: { content: expect.stringContaining("final answer") },
    });
    // The final answer should be visible via the fallback
    expect(result.visibleReplySent).toBe(true);
    expect(log).toHaveBeenCalledWith(expect.stringContaining("non-streaming fallback"));
  });
});
