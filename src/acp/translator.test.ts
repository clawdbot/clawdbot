import { describe, expect, it, vi, beforeEach } from "vitest";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { GatewayClient } from "../gateway/client.js";
import { AcpGwAgent } from "./translator.js";
import { clearAllSessions, createSession } from "./session.js";

// Mock AgentSideConnection
function createMockConnection() {
  return {
    sessionUpdate: vi.fn().mockResolvedValue(undefined),
    requestPermission: vi.fn().mockResolvedValue({ outcome: { outcome: "selected", optionId: "allow" } }),
  } as unknown as AgentSideConnection;
}

// Mock GatewayClient
function createMockGateway() {
  return {
    request: vi.fn().mockResolvedValue({}),
    start: vi.fn(),
  } as unknown as GatewayClient;
}

describe("AcpGwAgent", () => {
  let connection: ReturnType<typeof createMockConnection>;
  let gateway: ReturnType<typeof createMockGateway>;
  let agent: AcpGwAgent;

  beforeEach(() => {
    clearAllSessions();
    connection = createMockConnection();
    gateway = createMockGateway();
    agent = new AcpGwAgent(connection, gateway, { verbose: false });
  });

  describe("initialize", () => {
    it("returns protocol version and capabilities", async () => {
      const result = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      expect(result.protocolVersion).toBe(1);
      expect(result.agentCapabilities).toBeDefined();
      expect(result.agentInfo?.name).toBe("clawd-gw");
    });

    it("includes prompt capabilities", async () => {
      const result = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      expect(result.agentCapabilities?.promptCapabilities?.image).toBe(true);
      expect(result.agentCapabilities?.promptCapabilities?.audio).toBe(false);
    });
  });

  describe("newSession", () => {
    it("creates session with unique ID", async () => {
      const result = await agent.newSession({
        cwd: "/test/workspace",
        mcpServers: [],
      });

      expect(result.sessionId).toBeDefined();
      expect(typeof result.sessionId).toBe("string");
      expect(result.sessionId.length).toBeGreaterThan(0);
    });

    it("creates unique sessions", async () => {
      const r1 = await agent.newSession({ cwd: "/path1", mcpServers: [] });
      const r2 = await agent.newSession({ cwd: "/path2", mcpServers: [] });

      expect(r1.sessionId).not.toBe(r2.sessionId);
    });
  });

  describe("authenticate", () => {
    it("returns empty object (no auth required)", async () => {
      const result = await agent.authenticate({
        authMethodId: "none",
        credentials: {},
      });

      expect(result).toEqual({});
    });
  });

  describe("loadSession", () => {
    it("throws not implemented error", async () => {
      await expect(
        agent.loadSession({ sessionId: "test" }),
      ).rejects.toThrow("Session loading not implemented");
    });
  });

  describe("setSessionMode", () => {
    it("throws error for unknown session", async () => {
      await expect(
        agent.setSessionMode({ sessionId: "unknown", modeId: "high" }),
      ).rejects.toThrow("Session unknown not found");
    });

    it("calls gateway sessions.patch for valid session", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      await agent.setSessionMode({ sessionId: session.sessionId, modeId: "high" });
      
      expect(gateway.request).toHaveBeenCalledWith(
        "sessions.patch",
        expect.objectContaining({ thinkingLevel: "high" }),
      );
    });

    it("handles gateway error gracefully", async () => {
      gateway.request = vi.fn().mockRejectedValue(new Error("Gateway error"));
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      // Should not throw, just log
      const result = await agent.setSessionMode({ sessionId: session.sessionId, modeId: "high" });
      expect(result).toEqual({});
    });
  });

  describe("prompt", () => {
    it("throws error for unknown session", async () => {
      await expect(
        agent.prompt({
          sessionId: "unknown",
          prompt: [{ type: "text", text: "hello" }],
        }),
      ).rejects.toThrow("Session unknown not found");
    });

    it("sends prompt to gateway", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      // Set up gateway to resolve after a delay
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {}); // Never resolves - we'll check the call
        }
        return Promise.resolve({});
      });

      // Don't await - just trigger the prompt
      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      // Give it time to make the call
      await new Promise((r) => setTimeout(r, 10));

      expect(gateway.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          message: expect.stringContaining("hello"),
        }),
        expect.anything(),
      );

      // Clean up
      (promptPromise as any).catch?.(() => {});
    });

    it("extracts text from multiple content blocks", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(gateway.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          message: expect.stringContaining("line 1\nline 2"),
        }),
        expect.anything(),
      );

      (promptPromise as any).catch?.(() => {});
    });

    it("extracts image attachments", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [
          { type: "text", text: "look at this" },
          { type: "image", data: "base64data", mimeType: "image/png" },
        ],
      });

      await new Promise((r) => setTimeout(r, 10));

      expect(gateway.request).toHaveBeenCalledWith(
        "chat.send",
        expect.objectContaining({
          attachments: [{ type: "image", mimeType: "image/png", content: "base64data" }],
        }),
        expect.anything(),
      );

      (promptPromise as any).catch?.(() => {});
    });
  });

  describe("cancel", () => {
    it("handles cancel for unknown session", async () => {
      // Should not throw
      await agent.cancel({ sessionId: "unknown" });
    });

    it("calls gateway chat.abort for valid session", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      await agent.cancel({ sessionId: session.sessionId });
      
      expect(gateway.request).toHaveBeenCalledWith(
        "chat.abort",
        expect.objectContaining({ sessionKey: expect.stringContaining("acp:") }),
      );
    });
  });

  describe("handleGatewayDisconnect", () => {
    it("marks agent as disconnected", () => {
      agent.start();
      expect((agent as any).connected).toBe(true);

      agent.handleGatewayDisconnect("test disconnect");
      expect((agent as any).connected).toBe(false);
    });

    it("rejects pending prompts", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {}); // Never resolves
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      // Disconnect should reject the pending prompt
      agent.handleGatewayDisconnect("test disconnect");

      await expect(promptPromise).rejects.toThrow("Gateway disconnected");
    });
  });

  describe("handleGatewayReconnect", () => {
    it("marks agent as connected", () => {
      agent.handleGatewayDisconnect("test");
      expect((agent as any).connected).toBe(false);

      agent.handleGatewayReconnect();
      expect((agent as any).connected).toBe(true);
    });
  });

  describe("updateGateway", () => {
    it("updates gateway reference", () => {
      const newGateway = createMockGateway();
      agent.updateGateway(newGateway);
      expect((agent as any).gateway).toBe(newGateway);
    });
  });

  describe("handleGatewayEvent", () => {
    it("ignores non-agent/chat events", async () => {
      await agent.handleGatewayEvent({
        event: "health",
        payload: { ok: true },
      });
      
      expect(connection.sessionUpdate).not.toHaveBeenCalled();
    });

    it("handles tool start events", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      // Simulate an active run
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      // Get the runId from the session
      const internalSession = (agent as any).pendingPrompts.get(session.sessionId);
      const runId = internalSession?.idempotencyKey;

      // Now send a tool event with matching runId
      // We need to set up the session's activeRunId
      const { setActiveRun } = await import("./session.js");
      setActiveRun(session.sessionId, runId, new AbortController());

      await agent.handleGatewayEvent({
        event: "agent",
        payload: {
          runId,
          stream: "tool",
          data: {
            phase: "start",
            name: "bash",
            toolCallId: "tool-123",
          },
        },
      });

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: session.sessionId,
          update: expect.objectContaining({
            sessionUpdate: "tool_call",
            toolCallId: "tool-123",
            title: "bash",
            status: "running",
          }),
        }),
      );

      (promptPromise as any).catch?.(() => {});
    });

    it("handles tool result events", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      const runId = "test-run-id";
      
      const { setActiveRun } = await import("./session.js");
      setActiveRun(session.sessionId, runId, new AbortController());

      await agent.handleGatewayEvent({
        event: "agent",
        payload: {
          runId,
          stream: "tool",
          data: {
            phase: "result",
            name: "bash",
            toolCallId: "tool-456",
            isError: false,
          },
        },
      });

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "tool_call_update",
            toolCallId: "tool-456",
            status: "completed",
          }),
        }),
      );
    });

    it("handles tool error events", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      const runId = "test-run-id";
      
      const { setActiveRun } = await import("./session.js");
      setActiveRun(session.sessionId, runId, new AbortController());

      await agent.handleGatewayEvent({
        event: "agent",
        payload: {
          runId,
          stream: "tool",
          data: {
            phase: "result",
            name: "bash",
            toolCallId: "tool-789",
            isError: true,
          },
        },
      });

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            status: "error",
          }),
        }),
      );
    });
  });

  describe("handleChatEvent", () => {
    it("handles delta events with text streaming", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      // Set up a pending prompt
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      // Simulate chat delta event
      await agent.handleGatewayEvent({
        event: "chat",
        payload: {
          sessionKey: `acp:${session.sessionId}`,
          state: "delta",
          message: {
            content: [{ type: "text", text: "Hello" }],
          },
        },
      });

      expect(connection.sessionUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          update: expect.objectContaining({
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: "Hello" },
          }),
        }),
      );

      (promptPromise as any).catch?.(() => {});
    });

    it("handles final events and resolves prompt", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      // Simulate final event
      await agent.handleGatewayEvent({
        event: "chat",
        payload: {
          sessionKey: `acp:${session.sessionId}`,
          state: "final",
          message: {
            content: [{ type: "text", text: "Done" }],
          },
        },
      });

      const result = await promptPromise;
      expect(result.stopReason).toBe("end_turn");
    });

    it("handles aborted events", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      await agent.handleGatewayEvent({
        event: "chat",
        payload: {
          sessionKey: `acp:${session.sessionId}`,
          state: "aborted",
        },
      });

      const result = await promptPromise;
      expect(result.stopReason).toBe("cancelled");
    });

    it("deduplicates streaming text", async () => {
      const session = await agent.newSession({ cwd: "/test", mcpServers: [] });
      
      gateway.request = vi.fn().mockImplementation((method) => {
        if (method === "chat.send") {
          return new Promise(() => {});
        }
        return Promise.resolve({});
      });

      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "hello" }],
      });

      await new Promise((r) => setTimeout(r, 10));

      // First delta
      await agent.handleGatewayEvent({
        event: "chat",
        payload: {
          sessionKey: `acp:${session.sessionId}`,
          state: "delta",
          message: { content: [{ type: "text", text: "Hello" }] },
        },
      });

      // Second delta with cumulative text
      await agent.handleGatewayEvent({
        event: "chat",
        payload: {
          sessionKey: `acp:${session.sessionId}`,
          state: "delta",
          message: { content: [{ type: "text", text: "Hello world" }] },
        },
      });

      // Should have sent "Hello" then " world", not "Hello" then "Hello world"
      expect(connection.sessionUpdate).toHaveBeenCalledTimes(2);
      expect(connection.sessionUpdate).toHaveBeenNthCalledWith(1,
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: "text", text: "Hello" },
          }),
        }),
      );
      expect(connection.sessionUpdate).toHaveBeenNthCalledWith(2,
        expect.objectContaining({
          update: expect.objectContaining({
            content: { type: "text", text: " world" },
          }),
        }),
      );

      (promptPromise as any).catch?.(() => {});
    });
  });

  describe("verbose logging", () => {
    it("logs when verbose is true", async () => {
      const verboseAgent = new AcpGwAgent(connection, gateway, { verbose: true });
      
      // Capture stderr
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      
      await verboseAgent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      verboseAgent.start();

      expect(stderrWrite).toHaveBeenCalledWith(expect.stringContaining("[acp]"));
      
      stderrWrite.mockRestore();
    });
  });
});
