import { withServer } from "openclaw/plugin-sdk/test-env";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginRuntime } from "../runtime-api.js";
import {
  createLifecycleMonitorSetup,
  createTextUpdate,
  postWebhookReplay,
  settleAsyncWork,
} from "./test-support/lifecycle-test-support.js";
import {
  resetLifecycleTestState,
  sendMessageMock,
  setLifecycleRuntimeCore,
  startWebhookLifecycleMonitor,
} from "./test-support/monitor-mocks-test-support.js";

describe("Zalo reply-once lifecycle", () => {
  const finalizeInboundContextMock = vi.fn((ctx: Record<string, unknown>) => ctx);
  const recordInboundSessionMock = vi.fn(
    async (_input: { sessionKey?: string; ctx?: Record<string, unknown> }) => undefined,
  );
  const resolveAgentRouteMock = vi.fn(() => ({
    agentId: "main",
    channel: "zalo",
    accountId: "acct-zalo-lifecycle",
    sessionKey: "agent:main:zalo:direct:dm-chat-1",
    mainSessionKey: "agent:main:main",
    matchedBy: "default",
  }));
  const dispatchReplyWithBufferedBlockDispatcherMock = vi.fn();

  beforeEach(async () => {
    await resetLifecycleTestState();
    setLifecycleRuntimeCore({
      routing: {
        resolveAgentRoute:
          resolveAgentRouteMock as unknown as PluginRuntime["channel"]["routing"]["resolveAgentRoute"],
      },
      reply: {
        finalizeInboundContext:
          finalizeInboundContextMock as unknown as PluginRuntime["channel"]["reply"]["finalizeInboundContext"],
        dispatchReplyWithBufferedBlockDispatcher:
          dispatchReplyWithBufferedBlockDispatcherMock as unknown as PluginRuntime["channel"]["reply"]["dispatchReplyWithBufferedBlockDispatcher"],
      },
      session: {
        recordInboundSession:
          recordInboundSessionMock as unknown as PluginRuntime["channel"]["session"]["recordInboundSession"],
      },
    });
  });

  afterAll(async () => {
    await resetLifecycleTestState();
  });

  function createReplyOnceMonitorSetup() {
    return createLifecycleMonitorSetup({
      accountId: "acct-zalo-lifecycle",
      dmPolicy: "open",
    });
  }

  function requireRecordInboundSessionArgs() {
    const [call] = recordInboundSessionMock.mock.calls;
    if (!call) {
      throw new Error("expected inbound session record call");
    }
    const [recordArgs] = call;
    return recordArgs;
  }

  it("routes one accepted webhook event to one visible reply across duplicate replay", async () => {
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        await dispatcherOptions.deliver({ text: "zalo reply once" });
      },
    );

    const monitor = await startWebhookLifecycleMonitor({
      ...createReplyOnceMonitorSetup(),
      cacheKey: "zalo-reply-once-lifecycle",
    });

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createTextUpdate({
              messageId: `zalo-replay-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
              chatId: "dm-chat-1",
            }),
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(recordInboundSessionMock).toHaveBeenCalledTimes(1);
      const recordArgs = requireRecordInboundSessionArgs();
      expect(recordArgs?.sessionKey).toBe("agent:main:zalo:direct:dm-chat-1");
      expect(recordArgs?.ctx?.AccountId).toBe("acct-zalo-lifecycle");
      expect(recordArgs?.ctx?.SessionKey).toBe("agent:main:zalo:direct:dm-chat-1");
      expect(recordArgs?.ctx?.From).toBe("zalo:user-1");
      expect(recordArgs?.ctx?.To).toBe("zalo:dm-chat-1");
      expect(recordArgs?.ctx?.MessageSid).toContain("zalo-replay-");
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      const [sendToken, sendPayload, sendOptions] = sendMessageMock.mock.calls.at(0) as [
        string,
        { chat_id?: string; text?: string },
        unknown,
      ];
      expect(sendToken).toBe("zalo-token");
      expect(sendPayload.chat_id).toBe("dm-chat-1");
      expect(sendPayload.text).toBe("zalo reply once");
      expect(sendOptions).toBeUndefined();
    } finally {
      await monitor.stop();
    }
  });

  it("does not emit a second visible reply when replay arrives after a post-send failure", async () => {
    let dispatchAttempts = 0;
    dispatchReplyWithBufferedBlockDispatcherMock.mockImplementation(
      async ({ dispatcherOptions }) => {
        dispatchAttempts += 1;
        await dispatcherOptions.deliver({ text: "zalo reply after failure" });
        if (dispatchAttempts === 1) {
          throw new Error("post-send failure");
        }
      },
    );

    const monitor = await startWebhookLifecycleMonitor({
      ...createReplyOnceMonitorSetup(),
      cacheKey: "zalo-reply-once-lifecycle",
    });

    try {
      await withServer(
        (req, res) => monitor.route.handler(req, res),
        async (baseUrl) => {
          const { first, replay } = await postWebhookReplay({
            baseUrl,
            path: "/hooks/zalo",
            secret: "supersecret",
            payload: createTextUpdate({
              messageId: `zalo-retry-${Date.now()}`,
              userId: "user-1",
              userName: "User One",
              chatId: "dm-chat-1",
            }),
            settleBeforeReplay: true,
          });

          expect(first.status).toBe(200);
          expect(replay.status).toBe(200);
          await settleAsyncWork();
        },
      );

      expect(dispatchReplyWithBufferedBlockDispatcherMock).toHaveBeenCalledTimes(1);
      expect(sendMessageMock).toHaveBeenCalledTimes(1);
      expect(monitor.runtime.error).toHaveBeenCalledWith(
        "[acct-zalo-lifecycle] Zalo webhook failed: Error: post-send failure",
      );
    } finally {
      await monitor.stop();
    }
  });
});
