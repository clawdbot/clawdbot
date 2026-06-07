// MCP HTTP tests cover gateway-scoped tool listing and invocation over the
// JSON-RPC surface, including hook filtering and context propagation.
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

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
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
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

type McpToolResultPayload = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    content?: Array<{ text?: string }>;
    isError?: boolean;
  };
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

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
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
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

let server: Awaited<ReturnType<typeof startMcpLoopbackServer>> | undefined;

const MAIN_SESSION_HEADER = { "x-session-key": "agent:main:main" };
const ANGLE_NUMBER_PROPERTY = { type: "number" };

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

async function sendChunkedOversizedBody(params: {
  port: number;
  token: string;
}): Promise<{ status: number | undefined; body: string; closed: boolean }> {
  return await new Promise((resolve, reject) => {
    let sawResponse = false;
    let closed = false;
    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${params.token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        sawResponse = true;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const waitForClose = new Promise<void>((closeResolve) => {
            if (closed) {
              closeResolve();
              return;
            }
            req.once("close", () => closeResolve());
            setTimeout(closeResolve, 250).unref();
          });
          void waitForClose.then(() => {
            resolve({ status: res.statusCode, body, closed });
          });
        });
      },
    );
    req.on("close", () => {
      closed = true;
    });
    req.on("error", (error) => {
      if (!sawResponse) {
        reject(error);
      }
    });
    req.write("x".repeat(524_288));
    req.write("x".repeat(524_288));
    setTimeout(() => {
      req.write("x");
    }, 10).unref();
  });
}

async function sendStalledBody(params: {
  port: number;
  token: string;
}): Promise<{ status: number | undefined; body: string; closed: boolean }> {
  return await new Promise((resolve, reject) => {
    let sawResponse = false;
    let closed = false;
    let settled = false;
    const req = request(
      {
        hostname: "127.0.0.1",
        port: params.port,
        path: "/mcp",
        method: "POST",
        headers: {
          authorization: `Bearer ${params.token}`,
          "content-type": "application/json",
          "transfer-encoding": "chunked",
        },
      },
      (res) => {
        sawResponse = true;
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          body += chunk;
        });
        res.on("end", () => {
          const waitForClose = new Promise<void>((closeResolve) => {
            if (closed) {
              closeResolve();
              return;
            }
            req.once("close", () => closeResolve());
            setTimeout(closeResolve, 250).unref();
          });
          void waitForClose.then(() => {
            if (settled) {
              return;
            }
            settled = true;
            clearTimeout(timeout);
            resolve({ status: res.statusCode, body, closed });
          });
        });
      },
    );
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      req.destroy();
      reject(new Error("stalled body test timed out"));
    }, 2_000);
    req.on("close", () => {
      closed = true;
    });
    req.on("error", (error) => {
      if (!sawResponse && !settled) {
        settled = true;
        clearTimeout(timeout);
        reject(error);
      }
    });
    req.write("{");
  });
}

async function startLoopbackServerForTest(port = 0) {
  server = await startMcpLoopbackServer(port);
  const runtime = getActiveMcpLoopbackRuntime();
  if (!runtime) {
    throw new Error("expected active MCP loopback runtime");
  }
  return { port: server.port, runtime };
}

async function readMcpPayload(response: Response): Promise<McpToolResultPayload> {
  return (await response.json()) as McpToolResultPayload;
}

async function sendLoopbackToolsList(params: {
  token?: string;
  headers?: Record<string, string>;
  id?: number;
}) {
  return sendRaw({
    port: server?.port ?? 0,
    token: params.token,
    headers: jsonHeaders(params.headers),
    body: mcpToolsListBody(params.id),
  });
}

async function sendLoopbackToolCall(params: {
  token?: string;
  name: string;
  args?: Record<string, unknown>;
  headers?: Record<string, string>;
}) {
  return sendRaw({
    port: server?.port ?? 0,
    token: params.token,
    headers: jsonHeaders(params.headers),
    body: mcpToolCallBody(params.name, params.args),
  });
}

async function sendMainSessionToolCall(params: {
  token?: string;
  name?: string;
  args?: Record<string, unknown>;
}) {
  return sendLoopbackToolCall({
    token: params.token,
    name: params.name ?? "message",
    args: params.args,
    headers: MAIN_SESSION_HEADER,
  });
}

async function readOkMcpPayload(response: Response) {
  const payload = await readMcpPayload(response);
  expect(response.status).toBe(200);
  return payload;
}

async function listMainSessionTools(token?: string) {
  return readOkMcpPayload(
    await sendLoopbackToolsList({
      token,
      headers: MAIN_SESSION_HEADER,
    }),
  );
}

async function callMainSessionTool(params: {
  token?: string;
  name?: string;
  args?: Record<string, unknown>;
}) {
  return readOkMcpPayload(await sendMainSessionToolCall(params));
}

async function callMessageToolWithExecute(execute: MockGatewayTool["execute"]) {
  mockScopedTools([makeMessageTool({ execute })]);
  const { runtime } = await startLoopbackServerForTest();
  return callMainSessionTool({
    token: runtime?.ownerToken,
    name: "message",
    args: { body: "hello" },
  });
}

async function expectBrowserToolsListStatus(params: {
  origin: string | ((port: number) => string);
  fetchSite?: string;
  token?: "owner" | "none";
  status: number;
}) {
  const { runtime, port } = await startLoopbackServerForTest();
  const origin = typeof params.origin === "function" ? params.origin(port) : params.origin;
  const response = await sendRaw({
    port,
    token: params.token === "none" ? undefined : runtime?.ownerToken,
    headers: jsonHeaders({
      origin,
      ...(params.fetchSite ? { "sec-fetch-site": params.fetchSite } : {}),
    }),
    body: mcpToolsListBody(),
  });

  expect(response.status).toBe(params.status);
}

function expectMcpToolNames(payload: McpToolResultPayload, expected: string[]) {
  const names = (payload.result?.tools ?? []).map((tool) => tool.name);
  for (const name of expected) {
    expect(names).toContain(name);
  }
}

function expectMcpResultText(payload: McpToolResultPayload, text: string, isError?: boolean) {
  if (isError === undefined) {
    expect(payload.result?.isError).not.toBe(true);
  } else {
    expect(payload.result?.isError).toBe(isError);
  }
  expect(payload.result?.content?.[0]?.text).toBe(text);
}

function angleSchema(property: unknown, required: string[] = []) {
  return {
    type: "object",
    properties: { angle: property },
    required,
  };
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

function makeMockTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return {
    name: "mockplugin_tool",
    description: "mock tool",
    parameters: { type: "object", properties: {} },
    execute: async () => ({
      content: [{ type: "text", text: "ok" }],
    }),
    ...overrides,
  };
}

function makeMessageTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "message",
    description: "send a message",
    ...overrides,
  });
}

function makeCronTool(overrides: Partial<MockGatewayTool> = {}): MockGatewayTool {
  return makeMockTool({
    name: "cron",
    description: "manage schedules",
    ...overrides,
  });
}

function mockScopedTools(tools: MockGatewayTool[]) {
  resolveGatewayScopedToolsMock.mockReturnValue({
    agentId: "main",
    tools,
  });
}

function jsonHeaders(headers: Record<string, string> = {}) {
  return {
    "content-type": "application/json",
    ...headers,
  };
}

function mcpToolsListBody(id = 1) {
  return JSON.stringify({ jsonrpc: "2.0", id, method: "tools/list" });
}

function mcpToolCallBody(name: string, args: Record<string, unknown> = {}, id = 1) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name, arguments: args },
  });
}

function buildMockMcpToolSchema(tools: MockGatewayTool[]) {
  return buildMcpToolSchema(tools as unknown as Parameters<typeof buildMcpToolSchema>[0]);
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
  mockScopedTools([makeMessageTool()]);
});

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe("buildMcpToolSchema", () => {
  it("omits unreadable loopback tool names and parameters while preserving healthy siblings", () => {
    const unreadableName = makeMockTool({
      name: "fuzzplugin_unreadable",
      description: "unreadable name",
    });
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin loopback tool name getter exploded");
      },
    });
    const unreadableDescription = makeMockTool({
      name: "mockplugin_unreadable_description",
      description: "optional",
      parameters: { type: "object", properties: { value: { type: "string" } } },
    });
    Object.defineProperty(unreadableDescription, "description", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin loopback description getter exploded");
      },
    });
    const unreadableParameters = makeMockTool({
      name: "mockplugin_unreadable_parameters",
      description: "unreadable parameters",
    });
    Object.defineProperty(unreadableParameters, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin loopback parameters getter exploded");
      },
    });

    expect(
      buildMockMcpToolSchema([unreadableName, unreadableDescription, unreadableParameters]),
    ).toEqual([
      {
        name: "mockplugin_unreadable_description",
        description: undefined,
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
        },
      },
    ]);
  });

  it("flattens usable schemas from malformed and boolean union variants", () => {
    const cases: Array<{
      name: string;
      parameters: Record<string, unknown>;
      expected: Record<string, unknown>;
    }> = [
      {
        name: "fuzzplugin_move_delta",
        parameters: {
          anyOf: [angleSchema(null, ["angle"]), angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"])],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"]),
      },
      {
        name: "fuzzplugin_optional_delta",
        parameters: {
          anyOf: [angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"]), true],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY),
      },
      {
        name: "fuzzplugin_boolean_delta",
        parameters: {
          anyOf: [angleSchema(false), angleSchema(ANGLE_NUMBER_PROPERTY, ["angle"])],
        },
        expected: angleSchema(ANGLE_NUMBER_PROPERTY),
      },
    ];

    for (const testCase of cases) {
      expect(
        buildMockMcpToolSchema([
          makeMockTool({
            name: testCase.name,
            parameters: testCase.parameters,
          }),
        ])[0]?.inputSchema,
      ).toEqual(testCase.expected);
    }
  });
});

describe("mcp loopback server", () => {
  it("passes session, account, message channel, and inbound event headers into shared tool resolution", async () => {
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 53_000,
    });
    const { runtime, port: serverPort } = await startLoopbackServerForTest(port);

    const response = await sendRaw({
      port: serverPort,
      token: runtime?.nonOwnerToken,
      headers: jsonHeaders({
        "x-session-key": "agent:main:telegram:group:chat123",
        "x-openclaw-account-id": "work",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-current-channel-id": "telegram:chat123",
        "x-openclaw-current-thread-ts": "42",
        "x-openclaw-current-message-id": "reply-message-1",
        "x-openclaw-current-inbound-audio": "true",
        "x-openclaw-inbound-event-kind": "room_event",
        "x-openclaw-source-reply-delivery-mode": "message_tool_only",
      }),
      body: mcpToolsListBody(),
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:telegram:group:chat123");
    expect(call.accountId).toBe("work");
    expect(call.messageProvider).toBe("telegram");
    expect(call.currentChannelId).toBe("telegram:chat123");
    expect(call.currentThreadTs).toBe("42");
    expect(call.currentMessageId).toBe("reply-message-1");
    expect(call.currentInboundAudio).toBe(true);
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

  it("keeps loopback tool cache entries separate by inbound event kind, delivery mode, and inbound audio", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sendToolsList = async (
      inboundEventKind: string,
      sourceReplyDeliveryMode?: string,
      currentInboundAudio?: boolean,
    ) =>
      await sendLoopbackToolsList({
        token: runtime?.ownerToken,
        headers: {
          "x-session-key": "agent:main:telegram:group:chat123",
          "x-openclaw-message-channel": "telegram",
          "x-openclaw-inbound-event-kind": inboundEventKind,
          ...(sourceReplyDeliveryMode
            ? { "x-openclaw-source-reply-delivery-mode": sourceReplyDeliveryMode }
            : {}),
          ...(currentInboundAudio ? { "x-openclaw-current-inbound-audio": "true" } : {}),
        },
      });

    expect((await sendToolsList("user_request")).status).toBe(200);
    expect((await sendToolsList("room_event")).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only")).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only", true)).status).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(4);
    expect(getScopedToolsCall(0).inboundEventKind).toBe("user_request");
    expect(getScopedToolsCall(1).inboundEventKind).toBe("room_event");
    expect(getScopedToolsCall(2).sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getScopedToolsCall(3).currentInboundAudio).toBe(true);
  });

  it("caps loopback tool cache cardinality by evicting oldest contexts", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      accountId: undefined,
      cfg: { session: { mainKey: "main" } } as never,
      currentChannelId: "telegram:chat123",
      currentInboundAudio: undefined,
      currentMessageId: undefined,
      currentThreadTs: "thread-1",
      inboundEventKind: "room_event",
      messageProvider: "telegram",
      senderIsOwner: true,
      sessionKey: "agent:main:telegram:group:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
    } satisfies Parameters<McpLoopbackToolCache["resolve"]>[0];

    for (let index = 0; index < 257; index += 1) {
      cache.resolve({
        ...baseParams,
        currentMessageId: `message-${index}`,
      });
    }
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(257);

    cache.resolve({
      ...baseParams,
      currentMessageId: "message-0",
    });
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(258);

    cache.resolve({
      ...baseParams,
      currentMessageId: "message-256",
    });
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(258);
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
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolsList({
      token: runtime?.nonOwnerToken,
      headers: {
        "x-session-key": "agent:main:main",
      },
    });
    const payload = await readMcpPayload(response);

    expect(response.status).toBe(200);
    expect(payload.result?.tools?.[0]?.inputSchema).toEqual({
      type: "object",
      properties: {},
    });
  });

  it("derives sender owner identity from the loopback bearer token", async () => {
    const { runtime } = await startLoopbackServerForTest();

    const sendToolsList = async (token?: string) =>
      await sendLoopbackToolsList({
        token,
        headers: {
          "x-session-key": "agent:main:matrix:dm:test",
          "x-openclaw-message-channel": "matrix",
        },
      });

    expect((await sendToolsList(runtime?.ownerToken)).status).toBe(200);
    expect((await sendToolsList(runtime?.nonOwnerToken)).status).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
    expect(getScopedToolsCall(0).senderIsOwner).toBe(true);
    expect(getScopedToolsCall(1).senderIsOwner).toBe(false);
  });

  it("ignores spoofed owner headers on loopback requests", async () => {
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolsList({
      token: runtime?.nonOwnerToken,
      headers: {
        "x-session-key": "agent:main:matrix:dm:test",
        "x-openclaw-message-channel": "matrix",
        "x-openclaw-sender-is-owner": "true",
      },
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:matrix:dm:test");
    expect(call.messageProvider).toBe("matrix");
    expect(call.senderIsOwner).toBe(false);
    expect(call.surface).toBe("loopback");
  });

  it("keeps all tools in loopback tool lists", async () => {
    mockScopedTools([
      makeMessageTool(),
      makeCronTool(),
      makeMockTool({
        name: "owner_probe",
        description: "owner probe",
        execute: async () => ({
          content: [{ type: "text", text: "owner" }],
        }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await listMainSessionTools(runtime?.ownerToken);

    expectMcpToolNames(payload, ["message", "cron", "owner_probe"]);
  });

  it("keeps tools available to loopback callers", async () => {
    mockScopedTools([makeMessageTool(), makeCronTool()]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await listMainSessionTools(runtime?.ownerToken);

    expectMcpToolNames(payload, ["message", "cron"]);
  });

  it("executes tools for loopback callers", async () => {
    const cronExecute = vi.fn(async () => ({
      content: [{ type: "text", text: "CRON_EXECUTED" }],
    }));
    mockScopedTools([makeMessageTool(), makeCronTool({ execute: cronExecute })]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "cron",
    });

    expect(cronExecute).toHaveBeenCalledTimes(1);
    expectMcpResultText(payload, "CRON_EXECUTED");
  });

  it("calls healthy tools when an earlier loopback tool name is unreadable", async () => {
    const messageExecute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "MESSAGE_EXECUTED" }],
    }));
    const unreadableName = makeMockTool({
      name: "fuzzplugin_unreadable_call",
      description: "unreadable name",
    });
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin loopback call name getter exploded");
      },
    });
    mockScopedTools([unreadableName, makeMessageTool({ execute: messageExecute })]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "message",
      args: { body: "hello" },
    });

    expect(messageExecute).toHaveBeenCalledTimes(1);
    expectMcpResultText(payload, "MESSAGE_EXECUTED");
  });

  it("does not execute loopback tools omitted from the advertised schema", async () => {
    const unreadableExecute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "UNREADABLE_EXECUTED" }],
    }));
    const unreadableParameters = makeMockTool({
      name: "mockplugin_unreadable_parameters",
      description: "unreadable parameters",
      execute: unreadableExecute,
    });
    Object.defineProperty(unreadableParameters, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin loopback call parameters getter exploded");
      },
    });
    mockScopedTools([unreadableParameters]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "mockplugin_unreadable_parameters",
    });

    expect(unreadableExecute).not.toHaveBeenCalled();
    expectMcpResultText(payload, "Tool not available: mockplugin_unreadable_parameters", true);
  });

  it("honors before-tool-call hook blocks before loopback tool execution", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: true,
      reason: "blocked by hook",
    });
    const payload = await callMessageToolWithExecute(execute);

    const hookInput = getBeforeToolCallHookInput(0);
    expect(hookInput.toolName).toBe("message");
    expect(hookInput.params).toEqual({ body: "hello" });
    expect(hookInput.ctx?.agentId).toBe("main");
    expect(hookInput.ctx?.config).toEqual({ session: { mainKey: "main" } });
    expect(hookInput.ctx?.sessionKey).toBe("agent:main:main");
    expect(hookInput.signal).toBeInstanceOf(AbortSignal);
    expect(execute).not.toHaveBeenCalled();
    expectMcpResultText(payload, "blocked by hook", true);
  });

  it("forwards the request abort signal to loopback tool execution", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    const payload = await callMessageToolWithExecute(execute);

    expectMcpResultText(payload, "EXECUTED", false);
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
      body: mcpToolsListBody(),
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

  it("returns JSON-RPC parse errors only for invalid JSON", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: "{",
    });
    const payload = (await response.json()) as {
      id?: unknown;
      error?: { code?: number; message?: string };
    };

    expect(response.status).toBe(400);
    expect(payload.id).toBeNull();
    expect(payload.error).toMatchObject({
      code: -32700,
      message: "Parse error",
    });
  });

  it("returns internal errors for valid JSON when gateway tool resolution fails", async () => {
    resolveGatewayScopedToolsMock.mockImplementationOnce(() => {
      throw new Error("tool resolution exploded");
    });
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: mcpToolsListBody(42),
    });
    const payload = (await response.json()) as {
      id?: unknown;
      error?: { code?: number; message?: string };
    };

    expect(response.status).toBe(500);
    expect(payload.id).toBe(42);
    expect(payload.error).toMatchObject({
      code: -32603,
      message: "Internal error",
    });
  });

  it("returns invalid request errors for malformed batch entries without resetting the request", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: `[null,${mcpToolsListBody(7)}]`,
    });
    const payload = (await response.json()) as Array<{
      id?: unknown;
      error?: { code?: number; message?: string };
      result?: { tools?: Array<{ name: string }> };
    }>;

    expect(response.status).toBe(200);
    expect(payload).toHaveLength(2);
    expect(payload[0]).toMatchObject({
      id: null,
      error: {
        code: -32600,
        message: "Invalid Request",
      },
    });
    expect(payload[1]?.id).toBe(7);
    expect(payload[1]?.result?.tools?.map((tool) => tool.name)).toContain("message");
  });

  it("returns 413 instead of resetting oversized request bodies", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    const response = await sendRaw({
      port: server.port,
      token: runtime?.ownerToken,
      headers: { "content-type": "application/json" },
      body: "x".repeat(1_048_577),
    });

    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toEqual({ error: "payload_too_large" });
  });

  it("closes slow oversized request uploads after flushing 413", async () => {
    server = await startMcpLoopbackServer(0);
    const runtime = getActiveMcpLoopbackRuntime();
    if (!runtime) {
      throw new Error("expected active MCP loopback runtime");
    }

    const response = await sendChunkedOversizedBody({
      port: server.port,
      token: runtime.ownerToken,
    });

    expect(response).toEqual({
      status: 413,
      body: '{"error":"payload_too_large"}',
      closed: true,
    });
  });

  it("times out stalled request bodies and closes uploads after flushing 408", async () => {
    const previousTimeout = process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS;
    process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS = "20";
    try {
      server = await startMcpLoopbackServer(0);
      const runtime = getActiveMcpLoopbackRuntime();
      if (!runtime) {
        throw new Error("expected active MCP loopback runtime");
      }

      const response = await sendStalledBody({
        port: server.port,
        token: runtime.ownerToken,
      });

      expect(response).toEqual({
        status: 408,
        body: '{"error":"request_body_timeout"}',
        closed: true,
      });
    } finally {
      if (previousTimeout === undefined) {
        delete process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS;
      } else {
        process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS = previousTimeout;
      }
    }
  });

  it("rejects cross-origin browser requests before auth", async () => {
    await expectBrowserToolsListStatus({
      origin: "https://evil.example",
      fetchSite: "cross-site",
      token: "none",
      status: 403,
    });
  });

  it("rejects non-loopback origins even without fetch metadata", async () => {
    await expectBrowserToolsListStatus({
      origin: "https://evil.example",
      token: "none",
      status: 403,
    });
  });

  it("allows loopback browser origins for local clients", async () => {
    await expectBrowserToolsListStatus({
      origin: "http://127.0.0.1:43123",
      status: 200,
    });
  });

  it("allows same-origin browser requests from loopback clients", async () => {
    await expectBrowserToolsListStatus({
      origin: (port) => `http://127.0.0.1:${port}`,
      fetchSite: "same-origin",
      status: 200,
    });
  });

  it("allows cross-site fetch metadata when both ends are loopback (localhost ↔ 127.0.0.1)", async () => {
    // Browsers report a request from a `http://localhost:<ui-port>`
    // page to `http://127.0.0.1:<mcp-port>` as Sec-Fetch-Site:
    // cross-site even though both ends are loopback. The gate must
    // not blanket-reject on the cross-site signal — checkBrowserOrigin
    // already authorizes loopback origins from loopback peers via
    // its `local-loopback` matcher.
    await expectBrowserToolsListStatus({
      origin: "http://localhost:43123",
      fetchSite: "cross-site",
      status: 200,
    });
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
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-current-channel-id"]).toBe(
      "${OPENCLAW_MCP_CURRENT_CHANNEL_ID}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-current-thread-ts"]).toBe(
      "${OPENCLAW_MCP_CURRENT_THREAD_TS}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-current-message-id"]).toBe(
      "${OPENCLAW_MCP_CURRENT_MESSAGE_ID}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-current-inbound-audio"]).toBe(
      "${OPENCLAW_MCP_CURRENT_INBOUND_AUDIO}",
    );
    expect(config.mcpServers?.openclaw?.headers?.["x-openclaw-source-reply-delivery-mode"]).toBe(
      "${OPENCLAW_MCP_SOURCE_REPLY_DELIVERY_MODE}",
    );
    expect(config.mcpServers?.openclaw?.headers).not.toHaveProperty("x-openclaw-sender-is-owner");
  });
});
