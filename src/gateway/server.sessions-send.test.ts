import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createClawdbotTools } from "../agents/clawdbot-tools.js";
import { resolveSessionTranscriptPath } from "../config/sessions.js";
import { emitAgentEvent } from "../infra/agent-events.js";
import {
  agentCommand,
  getFreePort,
  installGatewayTestHooks,
  startGatewayServer,
} from "./test-helpers.js";

installGatewayTestHooks();

const servers: Array<Awaited<ReturnType<typeof startGatewayServer>>> = [];

afterEach(async () => {
  for (const server of servers) {
    try {
      await server.close();
    } catch {
      /* ignore */
    }
  }
  servers.length = 0;
  // Add small delay to ensure port is fully released by OS
  await new Promise((resolve) => setTimeout(resolve, 50));
});

describe("sessions_send gateway loopback", () => {
  it("returns reply when lifecycle ends before agent.wait", async () => {
    const port = await getFreePort();
    vi.stubEnv("CLAWDBOT_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port);
    const spy = vi.mocked(agentCommand);
    spy.mockImplementation(async (opts) => {
      const params = opts as {
        sessionId?: string;
        runId?: string;
        extraSystemPrompt?: string;
      };
      const sessionId = params.sessionId ?? "main";
      const runId = params.runId ?? sessionId;
      const sessionFile = resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });

      const startedAt = Date.now();
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt },
      });

      let text = "pong";
      if (params.extraSystemPrompt?.includes("Agent-to-agent reply step")) {
        text = "REPLY_SKIP";
      } else if (params.extraSystemPrompt?.includes("Agent-to-agent announce step")) {
        text = "ANNOUNCE_SKIP";
      }
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      };
      await fs.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf8");

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: {
          phase: "end",
          startedAt,
          endedAt: Date.now(),
        },
      });
    });

    servers.push(server);

    const tool = createClawdbotTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) throw new Error("missing sessions_send tool");

    const result = await tool.execute("call-loopback", {
      sessionKey: "main",
      message: "ping",
      timeoutSeconds: 5,
    });
    const details = result.details as {
      status?: string;
      reply?: string;
      sessionKey?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.reply).toBe("pong");
    expect(details.sessionKey).toBe("main");

    const firstCall = spy.mock.calls[0]?.[0] as { lane?: string } | undefined;
    expect(firstCall?.lane).toBe("nested");
  });
});

describe("sessions_send label lookup", () => {
  it("finds session by label and sends message", { timeout: 60_000 }, async () => {
    const port = await getFreePort();
    vi.stubEnv("CLAWDBOT_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port);
    servers.push(server);
    const spy = vi.mocked(agentCommand);
    spy.mockImplementation(async (opts) => {
      const params = opts as {
        sessionId?: string;
        runId?: string;
        extraSystemPrompt?: string;
      };
      const sessionId = params.sessionId ?? "test-labeled";
      const runId = params.runId ?? sessionId;
      const sessionFile = resolveSessionTranscriptPath(sessionId);
      await fs.mkdir(path.dirname(sessionFile), { recursive: true });

      const startedAt = Date.now();
      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "start", startedAt },
      });

      const text = "labeled response";
      const message = {
        role: "assistant",
        content: [{ type: "text", text }],
      };
      await fs.appendFile(sessionFile, `${JSON.stringify({ message })}\n`, "utf8");

      emitAgentEvent({
        runId,
        stream: "lifecycle",
        data: { phase: "end", startedAt, endedAt: Date.now() },
      });
    });

    // First, create a session with a label via sessions.patch
    const { callGateway } = await import("./call.js");
    await callGateway({
      method: "sessions.patch",
      params: { key: "test-labeled-session", label: "my-test-worker" },
      timeoutMs: 5000,
    });

    const tool = createClawdbotTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) throw new Error("missing sessions_send tool");

    // Send using label instead of sessionKey
    const result = await tool.execute("call-by-label", {
      label: "my-test-worker",
      message: "hello labeled session",
      timeoutSeconds: 5,
    });
    const details = result.details as {
      status?: string;
      reply?: string;
      sessionKey?: string;
    };
    expect(details.status).toBe("ok");
    expect(details.reply).toBe("labeled response");
    expect(details.sessionKey).toBe("agent:main:test-labeled-session");
  });

  it("returns error when label not found", { timeout: 60_000 }, async () => {
    const port = await getFreePort();
    vi.stubEnv("CLAWDBOT_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port);
    servers.push(server);

    const tool = createClawdbotTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) throw new Error("missing sessions_send tool");

    const result = await tool.execute("call-missing-label", {
      label: "nonexistent-label",
      message: "hello",
      timeoutSeconds: 5,
    });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("No session found with label");
  });

  it("returns error when neither sessionKey nor label provided", { timeout: 60_000 }, async () => {
    const port = await getFreePort();
    vi.stubEnv("CLAWDBOT_GATEWAY_PORT", String(port));

    const server = await startGatewayServer(port);
    servers.push(server);

    const tool = createClawdbotTools().find((candidate) => candidate.name === "sessions_send");
    if (!tool) throw new Error("missing sessions_send tool");

    const result = await tool.execute("call-no-key", {
      message: "hello",
      timeoutSeconds: 5,
    });
    const details = result.details as { status?: string; error?: string };
    expect(details.status).toBe("error");
    expect(details.error).toContain("Either sessionKey or label is required");
  });
});
