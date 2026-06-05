// Codex Supervisor tests cover mcp tools plugin behavior.
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import {
  redactCodexSupervisorEndpoint,
  redactCodexSupervisorValue,
  registerCodexSupervisorMcpTools,
  sanitizeCodexSupervisorSessionListResult,
} from "./mcp-tools.js";
import type { CodexSupervisor } from "./supervisor.js";

describe("redactCodexSupervisorValue", () => {
  it("redacts sensitive keys and common bearer-like secrets", () => {
    expect(
      redactCodexSupervisorValue({
        authorization: "Bearer abcdefghijklmnopqrstuvwxyz012345",
        nested: {
          apiKey: "sk-abcdefghijklmnopqrstuvwxyz012345",
          text: "token ghp_abcdefghijklmnopqrstuvwxyz012345 remains hidden",
        },
      }),
    ).toEqual({
      authorization: "[redacted]",
      nested: {
        apiKey: "[redacted]",
        text: "token [redacted] remains hidden",
      },
    });
  });
});

describe("redactCodexSupervisorEndpoint", () => {
  it("removes websocket credentials and query values", () => {
    expect(
      redactCodexSupervisorEndpoint({
        id: "prod",
        transport: "websocket",
        url: "wss://user:secret@example.invalid/control?token=a=b",
      }),
    ).toEqual({
      id: "prod",
      transport: "websocket",
      url: "wss://example.invalid/control?[redacted]",
    });
  });
});

describe("sanitizeCodexSupervisorSessionListResult", () => {
  it("omits transcript-derived fields unless explicitly trusted", () => {
    const result = {
      sessions: [
        {
          endpointId: "local",
          threadId: "thread-1",
          status: "idle",
          preview: "first prompt",
          name: "thread title",
        },
      ],
      errors: [{ endpointId: "down", ok: false, detail: "stderr secret" }],
    };

    expect(sanitizeCodexSupervisorSessionListResult(result, false)).toEqual({
      sessions: [{ endpointId: "local", threadId: "thread-1", status: "idle" }],
      errors: [{ endpointId: "down", ok: false }],
    });
    expect(sanitizeCodexSupervisorSessionListResult(result, true)).toEqual(result);
  });
});

describe("registerCodexSupervisorMcpTools", () => {
  it("uses per-server transcript policy when listing sessions", async () => {
    const handlers = new Map<string, (params: Record<string, unknown>) => Promise<unknown>>();
    const server = {
      tool(name: string, _description: string, _schema: unknown, handler: unknown) {
        handlers.set(name, handler as (params: Record<string, unknown>) => Promise<unknown>);
      },
    } as unknown as McpServer;
    const supervisor = {
      listSessionSnapshot: async () => ({
        sessions: [
          {
            endpointId: "local",
            threadId: "thread-1",
            status: "idle",
            preview: "first prompt",
            name: "thread title",
          },
        ],
        errors: [{ endpointId: "down", ok: false, detail: "stderr secret" }],
      }),
    } as unknown as CodexSupervisor;

    registerCodexSupervisorMcpTools(server, supervisor, {
      rawTranscriptReadsAllowed: () => false,
    });

    await expect(handlers.get("codex_sessions_list")?.({})).resolves.toMatchObject({
      structuredContent: {
        sessions: [{ endpointId: "local", threadId: "thread-1", status: "idle" }],
        errors: [{ endpointId: "down", ok: false }],
      },
    });
  });
});
