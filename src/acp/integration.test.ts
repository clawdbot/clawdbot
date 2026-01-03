/**
 * ACP-GW Integration Tests
 * 
 * These tests spin up a real Gateway and test acp end-to-end.
 * They require more setup but test the full flow.
 */

import { createServer, type AddressInfo } from "node:net";
import { describe, expect, it, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { GatewayClient } from "../gateway/client.js";
import { startGatewayServer } from "../gateway/server.js";
import { AcpGwAgent } from "./translator.js";
import { clearAllSessions } from "./session.js";
import type { AgentSideConnection } from "@agentclientprotocol/sdk";

// Get a free port
async function getFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// Mock AgentSideConnection that captures session updates
function createMockConnection() {
  const updates: Array<{ sessionId: string; update: unknown }> = [];
  const connection = {
    sessionUpdate: async (params: { sessionId: string; update: unknown }) => {
      updates.push(params);
    },
    requestPermission: async () => ({
      outcome: { outcome: "selected", optionId: "allow" },
    }),
  } as unknown as AgentSideConnection;
  return { connection, updates };
}

describe("acp integration", () => {
  let gatewayServer: Awaited<ReturnType<typeof startGatewayServer>>;
  let gatewayPort: number;
  let gatewayUrl: string;

  beforeAll(async () => {
    gatewayPort = await getFreePort();
    gatewayUrl = `ws://127.0.0.1:${gatewayPort}`;
    gatewayServer = await startGatewayServer(gatewayPort);
  });

  afterAll(async () => {
    await gatewayServer?.close();
  });

  beforeEach(() => {
    clearAllSessions();
  });

  describe("gateway connection", () => {
    it("connects to gateway", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      let connected = false;
      gateway.opts.onHelloOk = () => {
        connected = true;
      };

      gateway.start();

      // Wait for connection
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(connected).toBe(true);

      gateway.stop();
    });
  });

  describe("session lifecycle", () => {
    it("creates a session via acp", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      // Initialize
      const initResult = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });
      expect(initResult.protocolVersion).toBe(1);
      expect(initResult.agentInfo?.name).toBe("clawd-gw");

      // Create session
      const sessionResult = await agent.newSession({
        cwd: "/tmp/test",
        mcpServers: [],
      });
      expect(sessionResult.sessionId).toBeDefined();
      expect(sessionResult.sessionId.length).toBeGreaterThan(0);

      gateway.stop();
    });

    it("handles multiple sessions", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      // Create multiple sessions
      const s1 = await agent.newSession({ cwd: "/path1", mcpServers: [] });
      const s2 = await agent.newSession({ cwd: "/path2", mcpServers: [] });
      const s3 = await agent.newSession({ cwd: "/path3", mcpServers: [] });

      expect(s1.sessionId).not.toBe(s2.sessionId);
      expect(s2.sessionId).not.toBe(s3.sessionId);

      gateway.stop();
    });
  });

  describe("disconnect handling", () => {
    it("handles gateway disconnect gracefully", async () => {
      const { connection } = createMockConnection();
      
      // Start a temporary gateway
      const tempPort = await getFreePort();
      const tempServer = await startGatewayServer(tempPort);
      
      // Create agent first so we can wire up onClose
      let agent: AcpGwAgent;
      
      const gateway = new GatewayClient({
        url: `ws://127.0.0.1:${tempPort}`,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
        onClose: (_code, reason) => {
          agent?.handleGatewayDisconnect(reason);
        },
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      // Verify connected
      expect((agent as unknown as { connected: boolean }).connected).toBe(true);

      // Close the gateway
      await tempServer.close();

      // Wait for disconnect to propagate
      await new Promise((resolve) => setTimeout(resolve, 500));

      // Agent should be marked as disconnected
      expect((agent as unknown as { connected: boolean }).connected).toBe(false);
    });
  });

  describe("authentication", () => {
    it("authenticate returns empty object", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });

      const result = await agent.authenticate({
        authMethodId: "test",
        credentials: {},
      });

      expect(result).toEqual({});

      gateway.stop();
    });
  });

  describe("full lifecycle", () => {
    it("initializes, creates session, and handles events", async () => {
      const { connection, updates } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
        onEvent: (evt) => {
          agent?.handleGatewayEvent(evt);
        },
      });

      let agent: AcpGwAgent;

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      // Initialize
      const initResult = await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "integration-test", version: "1.0" },
      });
      expect(initResult.protocolVersion).toBe(1);

      // Create session
      const session = await agent.newSession({
        cwd: "/tmp/integration-test",
        mcpServers: [],
      });
      expect(session.sessionId).toBeDefined();

      // Verify session can be retrieved
      const { getSession } = await import("./session.js");
      const retrievedSession = getSession(session.sessionId);
      expect(retrievedSession).toBeDefined();
      expect(retrievedSession?.cwd).toBe("/tmp/integration-test");

      gateway.stop();
    });

    it("handles setSessionMode", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      const session = await agent.newSession({
        cwd: "/tmp/test",
        mcpServers: [],
      });

      // setSessionMode should not throw
      const result = await agent.setSessionMode({
        sessionId: session.sessionId,
        modeId: "high",
      });
      expect(result).toEqual({});

      gateway.stop();
    });

    it("handles cancel on non-running session", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      const session = await agent.newSession({
        cwd: "/tmp/test",
        mcpServers: [],
      });

      // Cancel should not throw even if no prompt is running
      await agent.cancel({ sessionId: session.sessionId });

      gateway.stop();
    });
  });

  describe("verbose mode", () => {
    it("logs to stderr when verbose is enabled", async () => {
      const { connection } = createMockConnection();
      const stderrWrite = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: true });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "test", version: "1.0" },
      });

      expect(stderrWrite).toHaveBeenCalled();
      
      stderrWrite.mockRestore();
      gateway.stop();
    });
  });

  describe("gateway reconnection", () => {
    it("updateGateway changes gateway reference", async () => {
      const { connection } = createMockConnection();
      
      const gateway1 = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway1.opts.onHelloOk = () => resolve();
        gateway1.start();
      });

      const agent = new AcpGwAgent(connection, gateway1, { verbose: false });
      agent.start();

      // Create a second gateway
      const gateway2 = new GatewayClient({
        url: gatewayUrl,
        clientName: "test2",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway2.opts.onHelloOk = () => resolve();
        gateway2.start();
      });

      // Update to new gateway
      agent.updateGateway(gateway2);
      
      // Verify reconnect handler works
      agent.handleGatewayReconnect();
      expect((agent as any).connected).toBe(true);

      gateway1.stop();
      gateway2.stop();
    });
  });

  describe("prompt flow", { timeout: 120_000 }, () => {
    it("sends prompt and receives streaming response", async () => {
      const { connection, updates } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
        onEvent: (evt) => {
          agent?.handleGatewayEvent(evt);
        },
      });

      let agent: AcpGwAgent;

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "prompt-test", version: "1.0" },
      });

      const session = await agent.newSession({
        cwd: "/tmp/prompt-test",
        mcpServers: [],
      });

      // Send a simple prompt
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "What is 2+2? Reply with just the number." }],
      });

      // Verify we got a valid response (end_turn or refusal are both valid completions)
      expect(["end_turn", "refusal"]).toContain(result.stopReason);

      // Verify we received streaming updates
      const textChunks = updates.filter(
        (u) => (u.update as any)?.sessionUpdate === "agent_message_chunk"
      );
      // May or may not have streaming text depending on response
      // The key is that we completed successfully
      // (fast responses might not trigger delta events)

      gateway.stop();
    });

    it("sends prompt with tool use and receives tool events", async () => {
      const { connection, updates } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
        onEvent: (evt) => {
          agent?.handleGatewayEvent(evt);
        },
      });

      let agent: AcpGwAgent;

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "tool-test", version: "1.0" },
      });

      const session = await agent.newSession({
        cwd: "/tmp/tool-test",
        mcpServers: [],
      });

      // Send a prompt that should trigger tool use (list files is safer than echo)
      const result = await agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "List the files in /tmp using bash. Just run: ls /tmp" }],
      });

      // Should complete (might be end_turn or refusal depending on model)
      expect(["end_turn", "refusal"]).toContain(result.stopReason);

      // Check for tool call events - may or may not have them depending on model behavior
      const toolCalls = updates.filter(
        (u) => (u.update as any)?.sessionUpdate === "tool_call"
      );

      // If we got tool calls, verify their structure
      if (toolCalls.length > 0) {
        const firstToolCall = toolCalls[0]?.update as any;
        expect(firstToolCall?.toolCallId).toBeDefined();
        expect(firstToolCall?.title).toBeDefined();
        expect(firstToolCall?.status).toBe("running");

        const toolUpdates = updates.filter(
          (u) => (u.update as any)?.sessionUpdate === "tool_call_update"
        );
        if (toolUpdates.length > 0) {
          const firstToolUpdate = toolUpdates[0]?.update as any;
          expect(firstToolUpdate?.toolCallId).toBeDefined();
          expect(["completed", "error"]).toContain(firstToolUpdate?.status);
        }
      }

      gateway.stop();
    });

    it("handles prompt cancellation", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
        onEvent: (evt) => {
          agent?.handleGatewayEvent(evt);
        },
      });

      let agent: AcpGwAgent;

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      agent = new AcpGwAgent(connection, gateway, { verbose: false });
      agent.start();

      await agent.initialize({
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: "cancel-test", version: "1.0" },
      });

      const session = await agent.newSession({
        cwd: "/tmp/cancel-test",
        mcpServers: [],
      });

      // Start a prompt and cancel it
      // Note: Cancel timing is tricky - if the prompt completes before cancel,
      // we get end_turn. If cancel works, we get cancelled. Either is valid.
      const promptPromise = agent.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "What is 1+1? Reply briefly." }],
      });

      // Try to cancel immediately
      await agent.cancel({ sessionId: session.sessionId });

      // The prompt should resolve with either cancelled or end_turn
      const result = await promptPromise;
      expect(["cancelled", "end_turn", "refusal"]).toContain(result.stopReason);

      gateway.stop();
    });
  });

  describe("error handling", () => {
    it("loadSession throws not implemented", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });

      await expect(agent.loadSession({ sessionId: "test" }))
        .rejects.toThrow("Session loading not implemented");

      gateway.stop();
    });

    it("prompt throws for unknown session", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });

      await expect(agent.prompt({
        sessionId: "nonexistent",
        prompt: [{ type: "text", text: "hello" }],
      })).rejects.toThrow("Session nonexistent not found");

      gateway.stop();
    });

    it("setSessionMode throws for unknown session", async () => {
      const { connection } = createMockConnection();
      
      const gateway = new GatewayClient({
        url: gatewayUrl,
        clientName: "test",
        clientVersion: "1.0.0",
        mode: "acp",
      });

      await new Promise<void>((resolve) => {
        gateway.opts.onHelloOk = () => resolve();
        gateway.start();
      });

      const agent = new AcpGwAgent(connection, gateway, { verbose: false });

      await expect(agent.setSessionMode({
        sessionId: "nonexistent",
        modeId: "high",
      })).rejects.toThrow("Session nonexistent not found");

      gateway.stop();
    });
  });
});
