// Internal hook tests cover dispatch for command, session, agent, and gateway hooks.
import { performance } from "node:perf_hooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { resetPluginRuntimeStateForTest, setActivePluginRegistry } from "../plugins/runtime.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import {
  clearInternalHooks,
  createInternalHookEvent,
  getRegisteredEventKeys,
  isAgentBootstrapEvent,
  isGatewayStartupEvent,
  registerInternalHook,
  setInternalHooksEnabled,
  triggerInternalHook,
  unregisterInternalHook,
  type AgentBootstrapHookContext,
  type GatewayStartupHookContext,
  type MessageReceivedHookContext,
  type MessageSentHookContext,
} from "./internal-hooks.js";

const INTERNAL_HOOK_HANDLERS_KEY = Symbol.for("openclaw.internalHookHandlers");
const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
  error: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "internal-hooks",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggerMocks.warn,
    error: loggerMocks.error,
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

describe("hooks", () => {
  beforeEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    vi.restoreAllMocks();
    loggerMocks.warn.mockClear();
    loggerMocks.error.mockClear();
  });

  afterEach(() => {
    clearInternalHooks();
    setInternalHooksEnabled(true);
    resetPluginRuntimeStateForTest();
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
        await Promise.resolve();
      });

      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should catch and log errors from handlers", async () => {
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
    });

    it("resolves when no handlers are registered", async () => {
      const event = createInternalHookEvent("command", "new", "test-session");
      await expect(triggerInternalHook(event)).resolves.toBeUndefined();
    });

    it("skips hook execution when internal hooks are disabled", async () => {
      const handler = vi.fn();
      registerInternalHook("command:new", handler);
      setInternalHooksEnabled(false);

      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));

      expect(handler).not.toHaveBeenCalled();
    });

    it("stores handlers in the global singleton registry", async () => {
      const globalHooks = resolveGlobalSingleton<Map<string, Array<(event: unknown) => unknown>>>(
        INTERNAL_HOOK_HANDLERS_KEY,
        () => new Map<string, Array<(event: unknown) => unknown>>(),
      );
      const handler = vi.fn();
      registerInternalHook("command:new", handler);

      const event = createInternalHookEvent("command", "new", "test-session");
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
      expect(globalHooks.has("command:new")).toBe(true);

      const injectedHandler = vi.fn();
      globalHooks.set("command:new", [injectedHandler]);
      await triggerInternalHook(event);
      expect(injectedHandler).toHaveBeenCalledWith(event);
    });

    it("executes all handlers in order when yielding between handlers", async () => {
      const calls: string[] = [];
      registerInternalHook("command:new", () => {
        calls.push("first");
      });
      registerInternalHook("command:new", () => {
        calls.push("second");
      });

      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"), {
        yieldBetweenHandlers: true,
      });

      expect(calls).toStrictEqual(["first", "second"]);
    });

    it("reports handler timing with handler indexes", async () => {
      vi.spyOn(performance, "now")
        .mockReturnValueOnce(10)
        .mockReturnValueOnce(25)
        .mockReturnValueOnce(30)
        .mockReturnValueOnce(45);
      registerInternalHook("command:new", () => {});
      registerInternalHook("command:new", () => {});
      const timings: Array<{ index: number; durationMs: number }> = [];

      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"), {
        onHandlerTiming: (info) => timings.push(info),
      });

      expect(timings).toStrictEqual([
        { index: 0, durationMs: 15 },
        { index: 1, durationMs: 15 },
      ]);
    });

    it("logs a warning for slow handlers", async () => {
      vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValueOnce(501);
      registerInternalHook("command:new", () => {});

      await triggerInternalHook(createInternalHookEvent("command", "new", "test-session"));

      expect(loggerMocks.warn).toHaveBeenCalledWith(
        "Slow hook handler [command:new] index=0 durationMs=501.0",
      );
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

      expect(event.context).toStrictEqual({});
    });
  });

  describe("isAgentBootstrapEvent", () => {
    it.each([
      {
        name: "returns true for agent:bootstrap events with expected context",
        event: createInternalHookEvent("agent", "bootstrap", "test-session", {
          workspaceDir: "/tmp",
          bootstrapFiles: [],
        } satisfies AgentBootstrapHookContext),
        expected: true,
      },
      {
        name: "returns false for non-bootstrap events",
        event: createInternalHookEvent("command", "new", "test-session"),
        expected: false,
      },
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isAgentBootstrapEvent(event)).toBe(expected);
    });
  });

  describe("isGatewayStartupEvent", () => {
    it.each([
      {
        name: "returns true for gateway:startup events with expected context",
        event: createInternalHookEvent("gateway", "startup", "gateway:startup", {
          cfg: {},
        } satisfies GatewayStartupHookContext),
        expected: true,
      },
      {
        name: "returns false for non-startup gateway events",
        event: createInternalHookEvent("gateway", "shutdown", "gateway:shutdown", {}),
        expected: false,
      },
    ] satisfies Array<{
      name: string;
      event: ReturnType<typeof createInternalHookEvent>;
      expected: boolean;
    }>)("$name", ({ event, expected }) => {
      expect(isGatewayStartupEvent(event)).toBe(expected);
    });
  });

  describe("message hooks", () => {
    it("should trigger message:received handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("message:received", handler);

      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello world",
        channelId: "whatsapp",
        conversationId: "chat-123",
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger message:sent handlers", async () => {
      const handler = vi.fn();
      registerInternalHook("message:sent", handler);

      const context: MessageSentHookContext = {
        to: "+1234567890",
        content: "Hello world",
        success: true,
        channelId: "telegram",
        messageId: "msg-123",
      };
      const event = createInternalHookEvent("message", "sent", "test-session", context);
      await triggerInternalHook(event);

      expect(handler).toHaveBeenCalledWith(event);
    });

    it("should trigger general message handlers for both received and sent", async () => {
      const handler = vi.fn();
      registerInternalHook("message", handler);

      const receivedContext: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello",
        channelId: "whatsapp",
      };
      const receivedEvent = createInternalHookEvent(
        "message",
        "received",
        "test-session",
        receivedContext,
      );
      await triggerInternalHook(receivedEvent);

      const sentContext: MessageSentHookContext = {
        to: "+1234567890",
        content: "World",
        success: true,
        channelId: "whatsapp",
      };
      const sentEvent = createInternalHookEvent("message", "sent", "test-session", sentContext);
      await triggerInternalHook(sentEvent);

      expect(handler).toHaveBeenCalledTimes(2);
      expect(handler).toHaveBeenNthCalledWith(1, receivedEvent);
      expect(handler).toHaveBeenNthCalledWith(2, sentEvent);
    });

    it("should handle hook errors without breaking message processing", async () => {
      const errorHandler = vi.fn(() => {
        throw new Error("Hook failed");
      });
      const successHandler = vi.fn();

      registerInternalHook("message:received", errorHandler);
      registerInternalHook("message:received", successHandler);

      const context: MessageReceivedHookContext = {
        from: "+1234567890",
        content: "Hello",
        channelId: "whatsapp",
      };
      const event = createInternalHookEvent("message", "received", "test-session", context);
      await triggerInternalHook(event);

      // Both handlers were called
      expect(errorHandler).toHaveBeenCalled();
      expect(successHandler).toHaveBeenCalled();
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
      expect(keys).toStrictEqual([]);
    });
  });

  describe("clearInternalHooks", () => {
    it("should remove all registered handlers", () => {
      registerInternalHook("command:new", vi.fn());
      registerInternalHook("command:stop", vi.fn());

      clearInternalHooks();

      const keys = getRegisteredEventKeys();
      expect(keys).toStrictEqual([]);
    });

    it("removes legacy hooks from the active plugin registry", () => {
      const active = createEmptyPluginRegistry();
      active.legacyInternalHooks.push({
        pluginId: "active-plugin",
        name: "active-plugin",
        event: "command:stop",
        handler: vi.fn(),
      });
      setActivePluginRegistry(active);

      clearInternalHooks();

      expect(active.legacyInternalHooks).toStrictEqual([]);
      expect(getRegisteredEventKeys()).toStrictEqual([]);
    });
  });
});
