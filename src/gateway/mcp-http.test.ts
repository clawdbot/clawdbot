import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";

type MockGatewayTool = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (...args: unknown[]) => Promise<{ content: Array<{ type: string; text: string }> }>;
};

type MockGatewayScopedTools = {
  agentId: string;
  tools: MockGatewayTool[];
};

type MockBeforeToolCallHookResult =
  | { blocked: true; reason: string }
  | { blocked: false; params: unknown };

type ScopedToolsCall = {
  sessionKey?: string;
  accountId?: string;
  messageProvider?: string;
  inboundEventKind?: string;
  sourceReplyDeliveryMode?: string;
  senderIsOwner?: boolean;
  surface?: string;
  excludeToolNames?: Iterable<string>;
};

type BeforeToolCallHookInput = {
  toolName?: string;
  params?: unknown;
  ctx?: {
    agentId?: string;
    config?: unknown;
    sessionKey?: string;
  };
  signal?: unknown;
};

const runBeforeToolCallHookMock = vi.hoisted(() =>
  vi.fn(
    async (args: { params: unknown }): Promise<MockBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  ),
);

const resolveGatewayScopedToolsMock = vi.hoisted(() =>
  vi.fn<(...args: unknown[]) => MockGatewayScopedTools>(() => ({
    agentId: "main",
    tools: [
      {
        name: "message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  })),
);

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ session: { mainKey: "main" } }),
}));

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../agents/pi-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: (...args: Parameters<typeof runBeforeToolCallHookMock>) =>
    runBeforeToolCallHookMock(...args),
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

import {
  createMcpLoopbackServerConfig,
  closeMcpLoopbackServer,
  getActiveMcpLoopbackRuntime,
  ensureMcpLoopbackServer,
  startMcpLoopbackServer,
} from "./mcp-http.js";

let server: Awaited<ReturnType<typeof startMcpLoopbackServer>> | undefined;

async function sendRaw(params: {
  port: number;
  token?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  return await fetch(`http://127.0.0.1:${params.port}/mcp`, {
    method: "POST",
    headers: {
      ...(params.token ? { authorization: `Bearer ${params.token}` } : {}),
      ...params.headers,
    },
    body: params.body,
  });
}

function getScopedToolsCall(index: number): ScopedToolsCall {
  const call = resolveGatewayScopedToolsMock.mock.calls[index]?.[0];
  if (typeof call !== "object" || call === null) {
    throw new Error(`Expected scoped tools call ${index} to receive an options object`);
  }
  return call as ScopedToolsCall;
}

function getBeforeToolCallHookInput(index: number): BeforeToolCallHookInput {
  const call = runBeforeToolCallHookMock.mock.calls[index]?.[0];
  if (typeof call !== "object" || call === null) {
    throw new Error(`Expected before-tool-call hook ${index} to receive an input object`);
  }
  return call as BeforeToolCallHookInput;
}

beforeEach(() => {
  resolveGatewayScopedToolsMock.mockClear();
  runBeforeToolCallHookMock.mockClear();
  runBeforeToolCallHookMock.mockImplementation(
    async (args: { params: unknown }): Promise<MockBeforeToolCallHookResult> => ({
      blocked: false,
      params: args.params,
    }),
  );
  resolveGatewayScopedToolsMock.mockReturnValue({
    agentId: "main",
    tools: [
      {
        name: "message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  });
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("mcp loopback server", () => {
  it("passes session, account, message channel, and inbound event headers into shared tool resolution", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 53_000,
    });
    server = await startMcpLoopbackServer(port);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.nonOwnerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:telegram:group:chat123",
        "x-openclaw-account-id": "work",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-inbound-event-kind": "room_event",
        "x-openclaw-source-reply-delivery-mode": "message_tool_only",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:telegram:group:chat123");
    expect(call.accountId).toBe("work");
    expect(call.messageProvider).toBe("telegram");
    expect(call.inboundEventKind).toBe("room_event");
    expect(call.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call.surface).toBe("loopback");
    expect(Array.from(call.excludeToolNames ?? [])).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
    ]);
  });

  it("keeps loopback tool cache entries separate by inbound event kind and delivery mode", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const sendToolsList = async (inboundEventKind: string, sourceReplyDeliveryMode?: string) =>
      await sendRaw({
        port: server?.port ?? 0,
        token: runtime?.ownerToken,
        headers: {
          "content-type": "application/json",
          "x-session-key": "agent:main:telegram:group:chat123",
          "x-openclaw-message-channel": "telegram",
          "x-openclaw-inbound-event-kind": inboundEventKind,
          ...(sourceReplyDeliveryMode
            ? { "x-openclaw-source-reply-delivery-mode": sourceReplyDeliveryMode }
            : {}),
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    expect((await sendToolsList("user_request")).status).toBe(200);
    expect((await sendToolsList("room_event")).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only")).status).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(3);
    expect(getScopedToolsCall(0).inboundEventKind).toBe("user_request");
    expect(getScopedToolsCall(1).inboundEventKind).toBe("room_event");
    expect(getScopedToolsCall(2).sourceReplyDeliveryMode).toBe("message_tool_only");
  });

  it("adds empty properties for object schemas that omit properties", async () => {
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "schema_probe",
          description: "exercise no-argument MCP schemas",
          parameters: { type: "object" },
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.nonOwnerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ inputSchema?: Record<string, unknown> }> };
    };

    expect(response.status).toBe(200);
    expect(payload.result?.tools?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("derives sender owner identity from the loopback bearer token", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const sendToolsList = async (token?: string) =>
      await sendRaw({
        port: server?.port ?? 0,
        token,
        headers: {
          "content-type": "application/json",
          "x-session-key": "agent:main:matrix:dm:test",
          "x-openclaw-message-channel": "matrix",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });

    expect((await sendToolsList(runtime?.ownerToken)).status).toBe(200);
    expect((await sendToolsList(runtime?.nonOwnerToken)).status).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
    expect(getScopedToolsCall(0).senderIsOwner).toBe(true);
    expect(getScopedToolsCall(1).senderIsOwner).toBe(false);
  });

  it("ignores spoofed owner headers on loopback requests", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.nonOwnerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:matrix:dm:test",
        "x-openclaw-message-channel": "matrix",
        "x-openclaw-sender-is-owner": "true",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:matrix:dm:test");
    expect(call.messageProvider).toBe("matrix");
    expect(call.senderIsOwner).toBe(false);
    expect(call.surface).toBe("loopback");
  });

  it("keeps all tools in loopback tool lists", async () => {
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "message",
          description: "send a message",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
        },
        {
          name: "cron",
          description: "manage schedules",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "cron" }],
          }),
        },
        {
          name: "owner_probe",
          description: "owner probe",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "owner" }],
          }),
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toContain("message");
    expect(names).toContain("cron");
    expect(names).toContain("owner_probe");
  });

  it("keeps tools available to loopback callers", async () => {
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "message",
          description: "send a message",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
        },
        {
          name: "cron",
          description: "manage schedules",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "cron" }],
          }),
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    const payload = (await response.json()) as {
      result?: { tools?: Array<{ name: string }> };
    };
    const names = (payload.result?.tools ?? []).map((tool) => tool.name);

    expect(response.status).toBe(200);
    expect(names).toContain("message");
    expect(names).toContain("cron");
  });

  it("executes tools for loopback callers", async () => {
    const cronExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "CRON_EXECUTED" }],
    }));
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "message",
          description: "send a message",
          parameters: { type: "object", properties: {} },
          execute: async () => ({
            content: [{ type: "text", text: "ok" }],
          }),
        },
        {
          name: "cron",
          description: "manage schedules",
          parameters: { type: "object", properties: {} },
          execute: cronExecute,
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "cron", arguments: {} },
      }),
    });
    const payload = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };

    expect(response.status).toBe(200);
    expect(cronExecute).toHaveBeenCalledTimes(1);
    expect(payload.result?.isError).not.toBe(true);
    expect(payload.result?.content?.[0]?.text).toBe("CRON_EXECUTED");
  });

  it("honors before-tool-call hook blocks before loopback tool execution", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: true,
      reason: "blocked by hook",
    });
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "message",
          description: "send a message",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message", arguments: { body: "hello" } },
      }),
    });
    const payload = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
    };

    expect(response.status).toBe(200);
    const hookInput = getBeforeToolCallHookInput(0);
    expect(hookInput.toolName).toBe("message");
    expect(hookInput.params).toEqual({ body: "hello" });
    expect(hookInput.ctx?.agentId).toBe("main");
    expect(hookInput.ctx?.config).toEqual({ session: { mainKey: "main" } });
    expect(hookInput.ctx?.sessionKey).toBe("agent:main:main");
    expect(hookInput.signal).toBeInstanceOf(AbortSignal);
    expect(execute).not.toHaveBeenCalled();
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content?.[0]?.text).toBe("blocked by hook");
  });

  it("forwards the request abort signal to loopback tool execution", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    resolveGatewayScopedToolsMock.mockReturnValue({
      agentId: "main",
      tools: [
        {
          name: "message",
          description: "send a message",
          parameters: { type: "object", properties: {} },
          execute,
        },
      ],
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();

    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:main",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message", arguments: { body: "hello" } },
      }),
    });
    const payload = (await response.json()) as {
      result?: { isError?: boolean };
    };

    expect(response.status).toBe(200);
    expect(payload.result?.isError).toBe(false);
    expect(execute).toHaveBeenCalledTimes(1);
    const [callId, params, signal] = execute.mock.calls.at(0) ?? [];
    expect(callId).toMatch(/^mcp-/);
    expect(params).toEqual({ body: "hello" });
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it("tracks the active runtime only while the server is running", async () => {
    server = await startMcpLoopbackServer(0);
    const active = getActiveMcpLoopbackRuntime();
    expect(active?.port).toBe(server.port);
    expect(active?.ownerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(active?.nonOwnerToken).toMatch(/^[0-9a-f]{64}$/);
    expect(active?.nonOwnerToken).not.toBe(active?.ownerToken);

    await server.close();
    server = undefined;
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  });

  it("starts the loopback server lazily and reuses the same singleton", async () => {
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();

    const first = await ensureMcpLoopbackServer(0);
    const second = await ensureMcpLoopbackServer(0);

    expect(second).toBe(first);
    expect(getActiveMcpLoopbackRuntime()?.port).toBe(first.port);

    await closeMcpLoopbackServer();
    expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
  });

  it("returns 401 when the bearer token is missing", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(response.status).toBe(401);
  });

  it("returns 415 when the content type is not JSON", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: { "content-type": "text/plain" },
      body: "{}",
    });
    expect(response.status).toBe(415);
  });

  it("rejects cross-origin browser requests before auth", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
  });

  it("rejects non-loopback origins even without fetch metadata", async () => {
    server = await startMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(403);
  });

  it("allows loopback browser origins for local clients", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        origin: "http://127.0.0.1:43123",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });

  it("allows same-origin browser requests from loopback clients", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        origin: `http://127.0.0.1:${server.port}`,
        "sec-fetch-site": "same-origin",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });

  it("allows cross-site fetch metadata when both ends are loopback (localhost ↔ 127.0.0.1)", async () => {
    // Browsers report a request from a `http://localhost:<ui-port>`
    // page to `http://127.0.0.1:<mcp-port>` as Sec-Fetch-Site:
    // cross-site even though both ends are loopback. The gate must
    // not blanket-reject on the cross-site signal — checkBrowserOrigin
    // already authorizes loopback origins from loopback peers via
    // its `local-loopback` matcher.
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: {
        "content-type": "application/json",
        origin: "http://localhost:43123",
        "sec-fetch-site": "cross-site",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });

    expect(response.status).toBe(200);
  });
});

describe("createMcpLoopbackServerConfig", () => {
  it("builds a server entry with env-driven headers", () => {
    const config = createMcpLoopbackServerConfig(23119) as {
      mcpServers?: Record<string, { url?: string; headers?: Record<string, string> }>;
    };
    expect(config.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(config.mcpServers?.openclaw?.headers?.Authorization).toBe(
      "Bearer ${OPENCLAW_MCP_TOKEN}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-message-channel"]).toBe(
      "${OPENCLAW_MCP_MESSAGE_CHANNEL}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-source-reply-delivery-mode"]).toBe(
      "${OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE}",
    );
    expect(config.mcpServers?.openclaw?.headers).not.toHaveProperty("x-openclaw-sender-is-owner");
  });
});
