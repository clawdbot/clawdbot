import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  registerInternalHook,
  triggerInternalHook,
  type InternalHookEvent,
} from "./internal-hooks.js";

type ActionCase = {
  label: string;
  key: string;
  action: "received" | "transcribed" | "preprocessed" | "sent";
  context: Record<string, unknown>;
  assertContext: (context: Record<string, unknown>) => void;
};

const actionCases: ActionCase[] = [
  {
    label: "message:received",
    key: "message:received",
    action: "received",
    context: {
      from: "signal:+15551234567",
      to: "bot:+15559876543",
      content: "Test message",
      channelId: "signal",
      conversationId: "conv-abc",
      messageId: "msg-xyz",
      senderId: "sender-1",
      senderName: "Test User",
      senderUsername: "testuser",
      senderE164: "+15551234567",
      provider: "signal",
      surface: "signal",
      threadId: "thread-1",
      originatingChannel: "signal",
      originatingTo: "bot:+15559876543",
      timestamp: 1707600000,
    },
    assertContext: (context) => {
      expect(context.content).toBe("Test message");
      expect(context.channelId).toBe("signal");
      expect(context.senderE164).toBe("+15551234567");
      expect(context.threadId).toBe("thread-1");
    },
  },
  {
    label: "message:transcribed",
    key: "message:transcribed",
    action: "transcribed",
    context: {
      body: "🎤 [Audio]",
      bodyForAgent: "[Audio] Transcript: Hello from voice",
      transcript: "Hello from voice",
      channelId: "telegram",
      mediaType: "audio/ogg",
    },
    assertContext: (context) => {
      expect(context.body).toBe("🎤 [Audio]");
      expect(context.bodyForAgent).toContain("Transcript:");
      expect(context.transcript).toBe("Hello from voice");
      expect(context.mediaType).toBe("audio/ogg");
    },
  },
  {
    label: "message:preprocessed",
    key: "message:preprocessed",
    action: "preprocessed",
    context: {
      body: "🎤 [Audio]",
      bodyForAgent: "[Audio] Transcript: Check https://example.com\n[Link summary: Example site]",
      transcript: "Check https://example.com",
      channelId: "telegram",
      mediaType: "audio/ogg",
      isGroup: false,
    },
    assertContext: (context) => {
      expect(context.transcript).toBe("Check https://example.com");
      expect(String(context.bodyForAgent)).toContain("Link summary");
      expect(String(context.bodyForAgent)).toContain("Transcript:");
    },
  },
  {
    label: "message:sent",
    key: "message:sent",
    action: "sent",
    context: {
      from: "bot:456",
      to: "user:123",
      content: "Reply text",
      channelId: "discord",
      conversationId: "channel:C123",
      provider: "discord",
      surface: "discord",
      threadId: "thread-abc",
      originatingChannel: "discord",
      originatingTo: "channel:C123",
    },
    assertContext: (context) => {
      expect(context.content).toBe("Reply text");
      expect(context.channelId).toBe("discord");
      expect(context.conversationId).toBe("channel:C123");
      expect(context.threadId).toBe("thread-abc");
    },
  },
];

function requireHookEvent(handler: ReturnType<typeof vi.fn>): InternalHookEvent {
  const call = handler.mock.calls[0];
  if (!call) {
    throw new Error("expected hook handler call");
  }
  return call[0] as InternalHookEvent;
}

describe("message hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("action handlers", () => {
    for (const testCase of actionCases) {
      it(`triggers handler for ${testCase.label}`, async () => {
        const handler = vi.fn();
        registerInternalHook(testCase.key, handler);

        await triggerInternalHook(
          createInternalHookEvent("message", testCase.action, "session-1", testCase.context),
        );

        expect(handler).toHaveBeenCalledOnce();
        const event = requireHookEvent(handler);
        expect(event.type).toBe("message");
        expect(event.action).toBe(testCase.action);
        testCase.assertContext(event.context);
      });
    }

    it("does not trigger action-specific handlers for other actions", async () => {
      const sentHandler = vi.fn();
      registerInternalHook("message:sent", sentHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "session-1", { content: "hello" }),
      );

      expect(sentHandler).not.toHaveBeenCalled();
    });
  });

  describe("general handler", () => {
    it("receives full message lifecycle in order", async () => {
      const events: InternalHookEvent[] = [];
      registerInternalHook("message", (event) => {
        events.push(event);
      });

      const lifecycleFixtures: Array<{
        action: "received" | "transcribed" | "preprocessed" | "sent";
        context: Record<string, unknown>;
      }> = [
        { action: "received", context: { content: "hi" } },
        { action: "transcribed", context: { transcript: "hello" } },
        { action: "preprocessed", context: { body: "hello", bodyForAgent: "hello" } },
        { action: "sent", context: { content: "reply" } },
      ];

      for (const fixture of lifecycleFixtures) {
        await triggerInternalHook(
          createInternalHookEvent("message", fixture.action, "s1", fixture.context),
        );
      }

      expect(events.map((event) => event.action)).toEqual([
        "received",
        "transcribed",
        "preprocessed",
        "sent",
      ]);
    });

    it("triggers both general and specific handlers", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();
      registerInternalHook("message", generalHandler);
      registerInternalHook("message:received", specificHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "test" }),
      );

      expect(generalHandler).toHaveBeenCalledOnce();
      expect(specificHandler).toHaveBeenCalledOnce();
    });
  });

  describe("error isolation", () => {
    it("does not propagate handler errors", async () => {
      const badHandler = vi.fn(() => {
        throw new Error("Hook exploded");
      });
      registerInternalHook("message:received", badHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "test" }),
      );
      expect(badHandler).toHaveBeenCalledOnce();
    });

    it("continues with later handlers when one fails", async () => {
      const failHandler = vi.fn(() => {
        throw new Error("First handler fails");
      });
      const successHandler = vi.fn();
      registerInternalHook("message:received", failHandler);
      registerInternalHook("message:received", successHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "test" }),
      );

      expect(failHandler).toHaveBeenCalledOnce();
      expect(successHandler).toHaveBeenCalledOnce();
    });

    it("isolates async handler errors", async () => {
      const asyncFailHandler = vi.fn(async () => {
        throw new Error("Async hook failed");
      });
      registerInternalHook("message:sent", asyncFailHandler);

      await triggerInternalHook(
        createInternalHookEvent("message", "sent", "s1", { content: "reply" }),
      );
      expect(asyncFailHandler).toHaveBeenCalledOnce();
    });
  });

  describe("event structure", () => {
    it("includes timestamps on message events", async () => {
      const handler = vi.fn();
      registerInternalHook("message", handler);

      const before = new Date();
      await triggerInternalHook(
        createInternalHookEvent("message", "received", "s1", { content: "hi" }),
      );
      const after = new Date();

      const event = requireHookEvent(handler);
      expect(event.timestamp).toBeInstanceOf(Date);
      expect(event.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
      expect(event.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
    });

    it("preserves mutable messages and sessionKey", async () => {
      const events: InternalHookEvent[] = [];
      registerInternalHook("message", (event) => {
        event.messages.push("Echo");
        events.push(event);
      });

      const sessionKey = "agent:main:telegram:abc";
      const received = createInternalHookEvent("message", "received", sessionKey, {
        content: "hi",
      });
      await triggerInternalHook(received);
      await triggerInternalHook(
        createInternalHookEvent("message", "sent", sessionKey, { content: "reply" }),
      );

      expect(received.messages).toContain("Echo");
      expect(events[0]?.sessionKey).toBe(sessionKey);
      expect(events[1]?.sessionKey).toBe(sessionKey);
    });
  });
});
