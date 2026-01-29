import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isMessageReceivedEvent,
  registerInternalHook,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type InternalHookEvent,
  type MessageReceivedHookContext,
} from "./internal-hooks.js";

describe("hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
  });

  afterEach(() => {
    clearInternalHooks();
  });

  describe("registerInternalHook", () => {
    it("should register a hook handler", () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });

    it("should allow multiple handlers for the same event", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerInternalHook("command:new", handler1);
      registerInternalHook("command:new", handler2);

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
    });
  });

  describe("unregisterInternalHook", () => {
    it("should unregister a specific handler", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      registerInternalHook("command:new", handler1);
      registerInternalHook("command:new", handler2);

      unregisterInternalHook("command:new", handler1);

      const event = createInternalHookEvent("command", "new", "test-session");
      void triggerInternalHook(event);

      expect(handler1).not.toHaveBeenCalled();
      expect(handler2).toHaveBeenCalled();
    });

    it("should clean up empty handler arrays", () => {
      const handler = vi.fn();

      registerInternalHook("command:new", handler);
      unregisterInternalHook("command:new", handler);

      const keys = getRegisteredEventKeys();
      expect(keys).not.toContain("command:new");
    });
  });

  describe("triggerInternalHook", () => {
    it("should trigger handlers for general event type", async () => {
      const handler = vi.fn();
      registerInternalHook("command", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger handlers for specific event action", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger both general and specific handlers", async () => {
      const generalHandler = vi.fn();
      const specificHandler = vi.fn();

      registerInternalHook("command", generalHandler);
      registerInternalHook("command:new", specificHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(generalHandler).toHaveBeenCalledWith(event);
      expect(specificHandler).toHaveBeenCalledWith(event);
    });

    it("should handle async handlers", async () => {
      const handler = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });

      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should catch and log errors from handlers", async () => {
      const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
      const errorHandler = vi.fn(() => {
        throw new Error("Handler failed");
      });
      const successHandler = vi.fn();

      registerInternalHook("command:new", errorHandler);
      registerInternalHook("command:new", successHandler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
      expect(consoleError).toHaveBeenCalledWith(
        expect.stringContaining("Hook error"),
        expect.stringContaining("Handler failed"),
      );

      consoleError.mockRestore();
    });

    it("should not throw if no handlers are registered", async () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      await expect(triggerInternalHook(event)).resolves.not.toThrow();
    });
  });

  describe("createInternalHookEvent", () => {
    it("should create a properly formatted event", () => {
      const event = createInternalHookEvent("command", "new", "test-session", {
        foo: "bar",
      });

      expect(event.type).toBe("command");
      expect(event.action).toBe("new");
      expect(event.sessionKey).toBe("test-session");
      expect(event.context).toEqual({ foo: "bar" });
      expect(event.timestamp).toBeInstanceOf(Date);
    });

    it("should use empty context if not provided", () => {
      const event = createInternalHookEvent("command", "new", "test-session");

      expect(event.context).toEqual({});
    });
  });

  describe("isAgentBootstrapEvent", () => {
    it("returns true for agent:bootstrap events with expected context", () => {
      const context: AgentBootstrapHookContext = {
        workspaceDir: "/tmp",
        bootstrapFiles: [],
      };
      const event = createInternalHookEvent("agent", "bootstrap", "test-session", context);
      expect(isAgentBootstrapEvent(event)).toBe(true);
    });

    it("returns false for non-bootstrap events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isAgentBootstrapEvent(event)).toBe(false);
    });
  });

  describe("isMessageReceivedEvent", () => {
    it("returns true for message:received events with expected context", () => {
      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello world",
        timestamp: Date.now(),
        channelId: "whatsapp",
        accountId: "default",
        conversationId: "chat-123",
        metadata: {
          to: "bot",
          provider: "whatsapp",
          surface: "whatsapp",
          senderId: "user-1",
          senderName: "Test User",
        },
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      expect(isMessageReceivedEvent(event)).toBe(true);
    });

    it("returns false for non-message events", () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      expect(isMessageReceivedEvent(event)).toBe(false);
    });

    it("returns false for message events with different action", () => {
      const event = createInternalHookEvent("message", "sent", "test-session", {
        from: "user",
        content: "hello",
        channelId: "telegram",
      });
      expect(isMessageReceivedEvent(event)).toBe(false);
    });

    it("returns false for message:received with missing required fields", () => {
      const event = createInternalHookEvent("message", "received", "test-session", {
        from: "user",
        // missing content and channelId
      });
      expect(isMessageReceivedEvent(event)).toBe(false);
    });
  });

  describe("getRegisteredEventKeys", () => {
    it("should return all registered event keys", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());
      registerInternalHook("session:start", vi.fn());

      const keys = getRegisteredEventKeys();
      expect(keys).toContain("command:new");
      expect(keys).toContain("command:stop");
      expect(keys).toContain("session:start");
    });

    it("should return empty array when no handlers are registered", () => {
      const keys = getRegisteredEventKeys();
      expect(keys).toEqual([]);
    });
  });

  describe("clearInternalHooks", () => {
    it("should remove all registered handlers", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());

      clearInternalHooks();

      const keys = getRegisteredEventKeys();
      expect(keys).toEqual([]);
    });
  });

  describe("integration", () => {
    it("should handle a complete hook lifecycle", async () => {
      const results: InternalHookEvent[] = [];
      const handler = vi.fn((event: InternalHookEvent) => {
        results.push(event);
      });

      // Register
      registerInternalHook("command:new", handler);

      // Trigger
      const event1 = createInternalHookEvent("command", "new", "session-1");
      await triggerInternalHook(event1);

      const event2 = createInternalHookEvent("command", "new", "session-2");
      await triggerInternalHook(event2);

      // Verify
      expect(results).toHaveLength(2);
      expect(results[0].sessionKey).toBe("session-1");
      expect(results[1].sessionKey).toBe("session-2");

      // Unregister
      unregisterInternalHook("command:new", handler);

      // Trigger again - should not call handler
      const event3 = createInternalHookEvent("command", "new", "session-3");
      await triggerInternalHook(event3);

      expect(results).toHaveLength(2);
    });

    it("should trigger message:received hooks with full context", async () => {
      const receivedEvents: InternalHookEvent[] = [];
      const generalHandler = vi.fn((event: InternalHookEvent) => {
        receivedEvents.push(event);
      });
      const specificHandler = vi.fn((event: InternalHookEvent) => {
        receivedEvents.push(event);
      });

      // Register for both general and specific
      registerInternalHook("message", generalHandler);
      registerInternalHook("message:received", specificHandler);

      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Test message",
        timestamp: 1706300000000,
        channelId: "telegram",
        conversationId: "chat-456",
        metadata: {
          provider: "telegram",
          surface: "telegram",
          senderId: "user-123",
        },
      };

      const event = createInternalHookEvent("message", "received", "agent:main:telegram", context);
      await triggerInternalHook(event);

      // Both handlers should fire
      expect(generalHandler).toHaveBeenCalledTimes(1);
      expect(specificHandler).toHaveBeenCalledTimes(1);
      expect(receivedEvents).toHaveLength(2);
      expect(receivedEvents[0].context).toEqual(context);
      expect(receivedEvents[0].sessionKey).toBe("agent:main:telegram");
    });
  });
});
