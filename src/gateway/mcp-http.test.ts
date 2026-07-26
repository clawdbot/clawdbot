// MCP HTTP tests cover gateway-scoped tool listing and invocation over the
// JSON-RPC surface, including hook filtering and context propagation.
import { request } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { getFreePortBlockWithPermissionFallback } from "../test-utils/ports.js";
import { buildMcpToolSchema } from "./mcp-http.schema.js";

type MockGatewayTool = {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  prepareBeforeToolCallParams?: (...args: unknown[]) => unknown;
  finalizeBeforeToolCallParams?: (...args: unknown[]) => unknown;
  execute: (...args: unknown[]) => Promise<{
    content: unknown[];
    details?: Record<string, unknown>;
  }>;
};

type MockGatewayScopedTools = {
  agentId: string;
  tools: MockGatewayTool[];
};

type MockBeforeToolCallHookResult =
  | {
      blocked: true;
      kind: "veto";
      deniedReason?: "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
      reason: string;
    }
  | {
      blocked: true;
      kind: "failure";
      disposition: "blocked" | "cancelled" | "failed" | "timed_out";
      deniedReason?: "plugin-before-tool-call" | "plugin-approval" | "tool-loop";
      reason: string;
    }
  | { blocked: false; params: unknown };

type ScopedToolsCall = {
  sessionKey?: string;
  runtimePolicySessionKey?: string;
  agentId?: string;
  sessionId?: string;
  modelProvider?: string;
  modelId?: string;
  yieldContextCacheKey?: string;
  onYield?: (message: string) => Promise<void> | void;
  accountId?: string;
  messageProvider?: string;
  clientCaps?: string[];
  currentChannelId?: string;
  currentThreadTs?: string;
  currentMessageId?: string | number;
  currentInboundAudio?: boolean;
  inboundEventKind?: string;
  sourceReplyDeliveryMode?: string;
  taskSuggestionDeliveryMode?: string;
  requireExplicitMessageTarget?: boolean;
  senderIsOwner?: boolean;
  conversationReadOrigin?: "delegated" | "direct-operator";
  surface?: string;
  excludeToolNames?: Iterable<string>;
  includeNodeExecTool?: boolean;
  nodeExecAllowed?: boolean;
  execSession?: {
    execHost?: string;
    execSecurity?: string;
    execAsk?: string;
    execNode?: string;
  };
  execOverrides?: {
    host?: string;
    security?: string;
    ask?: string;
    node?: string;
  };
  bashElevated?: {
    enabled: boolean;
    allowed: boolean;
    defaultLevel: "on" | "off" | "ask" | "full";
    fullAccessAvailable?: boolean;
    fullAccessBlockedReason?: string;
  };
  trigger?: string;
  approvalReviewerDeviceId?: string;
  channelContext?: { sender?: { id?: string }; chat?: { id?: string } };
  senderName?: string;
  senderUsername?: string;
  senderE164?: string;
  groupId?: string;
  groupChannel?: string;
  groupSpace?: string;
  spawnedBy?: string;
};

type BeforeToolCallHookInput = {
  toolName?: string;
  params?: unknown;
  ctx?: {
    agentId?: string;
    config?: unknown;
    sessionKey?: string;
    sessionId?: string;
    runId?: string;
    approvalReviewerDeviceId?: string;
    channelId?: string;
    turnSourceChannel?: string;
    turnSourceTo?: string;
    turnSourceAccountId?: string;
    turnSourceThreadId?: string | number;
    loopDetection?: unknown;
  };
  signal?: unknown;
};

type McpToolResultPayload = {
  result?: {
    tools?: Array<{ name: string; inputSchema?: Record<string, unknown> }>;
    content?: Array<Record<string, unknown>>;
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
        label: "Message",
        description: "send a message",
        parameters: { type: "object", properties: {} },
        execute: async () => ({
          content: [{ type: "text", text: "ok" }],
        }),
      },
    ],
  })),
);

const logWarnMock = vi.hoisted(() => vi.fn<(message: string) => void>());
const sessionEntries = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock("../config/io.js", () => ({
  getRuntimeConfig: () => ({ session: { mainKey: "main" } }),
}));

vi.mock("../logger.js", async () => {
  const actual = await vi.importActual<typeof import("../logger.js")>("../logger.js");
  return {
    ...actual,
    logWarn: (message: string) => logWarnMock(message),
  };
});

vi.mock("../config/sessions.js", () => ({
  resolveMainSessionKey: () => "agent:main:main",
}));

vi.mock("../config/sessions/session-accessor.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/sessions/session-accessor.js")>();
  return {
    ...actual,
    resolveSessionEntryAccessTarget: (params: { sessionKey: string }) => ({
      entry: sessionEntries.get(params.sessionKey),
    }),
  };
});

vi.mock("../agents/agent-tools.before-tool-call.js", () => ({
  runBeforeToolCallHook: (...args: Parameters<typeof runBeforeToolCallHookMock>) =>
    runBeforeToolCallHookMock(...args),
}));

vi.mock("./tool-resolution.js", () => ({
  resolveGatewayScopedTools: (...args: Parameters<typeof resolveGatewayScopedToolsMock>) =>
    resolveGatewayScopedToolsMock(...args),
}));

import {
  activateMcpLoopbackClientGrantCapture,
  deactivateMcpLoopbackClientGrantCapture,
  mintAttachGrant,
  mintMcpLoopbackClientGrant,
  revokeMcpLoopbackClientGrant,
} from "./mcp-grant-store.js";
import { handleMcpJsonRpc } from "./mcp-http.handlers.js";
import { closeMcpLoopbackServer, ensureMcpLoopbackServer } from "./mcp-http.js";
import {
  beginMcpLoopbackToolCallCapture,
  clearMcpLoopbackToolCallCapture,
  createMcpAttachGrantServerConfig,
  createMcpLoopbackServerConfig,
  getActiveMcpLoopbackRuntime,
  markMcpLoopbackToolCallFinished,
  markMcpLoopbackToolCallStarted,
  recordMcpLoopbackToolCallResult,
  waitForMcpLoopbackToolCallCaptureIdle,
} from "./mcp-http.loopback-runtime.js";
import { McpLoopbackToolCache } from "./mcp-http.runtime.js";

let server: Awaited<ReturnType<typeof ensureMcpLoopbackServer>> | undefined;

const MAIN_SESSION_HEADER = { "x-session-key": "agent:main:main" };
const ANGLE_NUMBER_PROPERTY = { type: "number" };
const SSE_TEST_READ_TIMEOUT_MS = 100;

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

async function readStreamChunkWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<ReadableStreamReadResult<Uint8Array>> {
  const timeoutResult = Symbol("sse-read-timeout");
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      reader.read(),
      new Promise<typeof timeoutResult>((resolve) => {
        timeout = setTimeout(() => resolve(timeoutResult), SSE_TEST_READ_TIMEOUT_MS);
      }),
    ]);
    if (result === timeoutResult) {
      throw new Error("timed out waiting for SSE response body");
    }
    return result;
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function expectPromiseResolvesWithin<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          reject(new Error(`${label} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
  }
}

async function readUntilInitialSseCommentFrame(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<void> {
  const decoder = new TextDecoder();
  let bodyPrefix = "";
  while (!bodyPrefix.includes(":\n\n")) {
    const chunk = await readStreamChunkWithTimeout(reader);
    expect(chunk.done).toBe(false);
    bodyPrefix += decoder.decode(chunk.value, { stream: true });
    if (bodyPrefix.length > 64) {
      throw new Error(`SSE response did not start with a comment frame: ${bodyPrefix}`);
    }
  }
  expect(bodyPrefix.startsWith(":\n\n")).toBe(true);
}

async function expectInitialSseCommentFrame(res: Response): Promise<void> {
  expect(res.body).toBeTruthy();
  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("expected SSE response body");
  }
  let pendingRead: Promise<ReadableStreamReadResult<Uint8Array>> | undefined;
  let closeTimeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await readUntilInitialSseCommentFrame(reader);

    pendingRead = reader.read();
    const immediateClose = Symbol("immediate-close");
    const result = await Promise.race([
      pendingRead,
      new Promise<typeof immediateClose>((resolve) => {
        closeTimeout = setTimeout(() => resolve(immediateClose), SSE_TEST_READ_TIMEOUT_MS);
      }),
    ]);
    expect(result).toBe(immediateClose);
  } finally {
    if (closeTimeout) {
      clearTimeout(closeTimeout);
    }
    await reader.cancel();
    await pendingRead?.catch(() => undefined);
    reader.releaseLock();
  }
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
  bodyAfterDelay?: string;
  delayMs?: number;
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
    if (params.bodyAfterDelay === undefined) {
      req.write("{");
      return;
    }
    req.flushHeaders();
    setTimeout(() => {
      req.end(params.bodyAfterDelay);
    }, params.delayMs ?? 0).unref();
  });
}

async function startLoopbackServerForTest(port = 0) {
  server = await ensureMcpLoopbackServer(port);
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
    label: "Mock tool",
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
  logWarnMock.mockClear();
  sessionEntries.clear();
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

  it("preserves every literal across const and enum union variants", () => {
    const tool = makeMockTool({
      name: "codex_threads_literal_union",
      parameters: {
        anyOf: [
          {
            type: "object",
            properties: {
              action: {
                type: "string",
                const: "list",
                enum: ["list", "ignored"],
                description: "List threads",
              },
              thread_id: { type: "string" },
            },
            required: ["action"],
          },
          {
            type: "object",
            properties: {
              action: { type: "string", const: "fork", description: "Fork a thread" },
              thread_id: { type: "string" },
            },
            required: ["action"],
          },
          {
            type: "object",
            properties: {
              action: { type: "string", const: "rename" },
              thread_id: { type: "string" },
            },
            required: ["action"],
          },
          {
            type: "object",
            properties: {
              action: { type: "string", enum: ["archive", "unarchive"] },
              thread_id: { type: "string" },
            },
            required: ["action"],
          },
        ],
      },
    });

    expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toEqual({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["list", "fork", "rename", "archive", "unarchive"],
          description: "List threads",
        },
        thread_id: { type: "string" },
      },
      required: ["action"],
    });
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("keeps the first literal schema when validation constraints differ", () => {
    const tool = makeMockTool({
      name: "codex_threads_constrained_literals",
      parameters: {
        anyOf: [
          {
            type: "object",
            properties: {
              action: { type: "string", const: "list", pattern: "^list$" },
            },
          },
          {
            type: "object",
            properties: {
              action: { type: "string", const: "fork", pattern: "^fork$" },
            },
          },
        ],
      },
    });

    expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toMatchObject({
      properties: {
        action: { type: "string", const: "list", pattern: "^list$" },
      },
    });
    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "codex_threads_constrained_literals.action", keeping the first variant',
    ]);
  });

  it("does not warn for structurally identical property schemas", () => {
    const tool = makeMockTool({
      name: "codex_threads_identical_properties",
      parameters: {
        oneOf: [
          {
            type: "object",
            properties: {
              thread_id: { type: "string", description: "Thread identifier" },
            },
          },
          {
            type: "object",
            properties: {
              thread_id: { type: "string", description: "Thread identifier" },
            },
          },
        ],
      },
    });

    expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toMatchObject({
      properties: {
        thread_id: { type: "string", description: "Thread identifier" },
      },
    });
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("warns once for repeated union schema conflicts across loopback schema rebuilds", () => {
    const tool = makeMockTool({
      name: "mcp_message_send_rebuild",
      parameters: {
        anyOf: [
          {
            type: "object",
            properties: {
              action: { type: "string", description: "message action" },
              callId: { type: "string", description: "voice call id" },
            },
          },
          {
            type: "object",
            properties: {
              action: { type: "number", description: "different server action" },
              callId: { type: "number", description: "different call id" },
            },
          },
        ],
      },
    });

    for (let index = 0; index < 3; index += 1) {
      expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toMatchObject({
        type: "object",
        properties: {
          action: { type: "string", description: "message action" },
          callId: { type: "string", description: "voice call id" },
        },
      });
    }

    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "mcp_message_send_rebuild.action", keeping the first variant',
      'mcp-loopback: conflicting schema definitions for "mcp_message_send_rebuild.callId", keeping the first variant',
    ]);
  });

  it("does not warn for structurally identical union property schemas", () => {
    const tool = makeMockTool({
      name: "lark_doc_read",
      parameters: {
        anyOf: [
          {
            type: "object",
            properties: {
              doc_token: {
                type: "string",
                description: "Lark document token",
                minLength: 1,
              },
            },
          },
          {
            type: "object",
            properties: {
              doc_token: {
                minLength: 1,
                description: "Lark document token",
                type: "string",
              },
            },
          },
        ],
      },
    });

    expect(buildMockMcpToolSchema([tool])[0]?.inputSchema).toMatchObject({
      type: "object",
      properties: {
        doc_token: {
          type: "string",
          description: "Lark document token",
          minLength: 1,
        },
      },
    });
    expect(logWarnMock).not.toHaveBeenCalled();
  });

  it("warns per tool for the same conflicting field name across different tools", () => {
    const conflictingUnion = (label: string) => ({
      anyOf: [
        { type: "object", properties: { action: { type: "string", description: `${label} a` } } },
        { type: "object", properties: { action: { type: "number", description: `${label} b` } } },
      ],
    });
    const messageTool = makeMockTool({
      name: "mcp_message_send_per_tool",
      parameters: conflictingUnion("message"),
    });
    const calendarTool = makeMockTool({
      name: "mcp_calendar_create_per_tool",
      parameters: conflictingUnion("calendar"),
    });

    buildMockMcpToolSchema([messageTool, calendarTool]);
    // Rebuild to prove per-(tool, field) dedupe survives repeated schema builds.
    buildMockMcpToolSchema([messageTool, calendarTool]);

    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "mcp_message_send_per_tool.action", keeping the first variant',
      'mcp-loopback: conflicting schema definitions for "mcp_calendar_create_per_tool.action", keeping the first variant',
    ]);
  });

  it("warns once per tool for repeated malformed variant schemas across rebuilds", () => {
    const tool = makeMockTool({
      name: "mcp_message_send_malformed",
      parameters: {
        anyOf: [
          { type: "object", properties: { action: { type: "string" } } },
          { type: "object", properties: { action: 123 } },
        ],
      },
    });

    buildMockMcpToolSchema([tool]);
    buildMockMcpToolSchema([tool]);

    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: malformed schema definition for "mcp_message_send_malformed.action", ignoring that variant',
    ]);
  });
});

describe("mcp loopback server", () => {
  it("keeps equal schemas quiet and dedupes genuine conflicts across HTTP cache misses", async () => {
    mockScopedTools([
      makeMockTool({
        name: "lark_doc_read",
        parameters: {
          anyOf: [
            {
              type: "object",
              properties: {
                doc_token: { type: "string", description: "Lark document token" },
                action: { type: "string" },
              },
            },
            {
              type: "object",
              properties: {
                doc_token: { description: "Lark document token", type: "string" },
                action: { type: "number" },
              },
            },
          ],
        },
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    for (let index = 0; index < 3; index += 1) {
      const payload = await readOkMcpPayload(
        await sendLoopbackToolsList({
          token: runtime.ownerToken,
          headers: {
            ...MAIN_SESSION_HEADER,
            "x-openclaw-current-message-id": `message-${index}`,
          },
        }),
      );
      expectMcpToolNames(payload, ["lark_doc_read"]);
    }

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(3);
    expect(logWarnMock.mock.calls.map(([message]) => message)).toEqual([
      'mcp-loopback: conflicting schema definitions for "lark_doc_read.action", keeping the first variant',
    ]);
  });

  it("rejects reserved harness contexts before tool resolution", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const response = await sendLoopbackToolsList({
      token: runtime.ownerToken,
      headers: {
        "x-session-key": "agent:main:harness:codex:supervision:native-thread",
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      error: { code: -32600, message: expect.stringContaining("reserved") },
    });
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("suppresses reserved-harness errors for notifications", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const headers = {
      "content-type": "application/json",
      "x-session-key": "agent:main:harness:codex:supervision:native-thread",
    };
    const notificationResponse = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });
    const mixedResponse = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers,
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/list" },
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
      ]),
    });

    expect(notificationResponse.status).toBe(202);
    await expect(notificationResponse.text()).resolves.toBe("");
    expect(mixedResponse.status).toBe(200);
    await expect(mixedResponse.json()).resolves.toEqual([
      expect.objectContaining({
        id: 42,
        error: { code: -32600, message: expect.stringContaining("reserved") },
      }),
    ]);
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("allows an existing unlocked legacy harness-prefixed context", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sessionKey = "agent:main:harness:legacy-notes";
    sessionEntries.set(sessionKey, { sessionId: "legacy-session", modelSelectionLocked: false });

    const response = await sendLoopbackToolsList({
      token: runtime.ownerToken,
      headers: { "x-session-key": sessionKey },
    });

    expect(response.status).toBe(200);
    expect((await response.json()).result).toBeDefined();
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledWith(
      expect.objectContaining({ sessionKey }),
    );
  });

  it("rejects an existing locked harness context", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sessionKey = "agent:main:harness:codex:supervision:native-thread";
    sessionEntries.set(sessionKey, {
      sessionId: "locked-session",
      agentHarnessId: "codex",
      modelSelectionLocked: true,
    });

    const response = await sendLoopbackToolsList({
      token: runtime.ownerToken,
      headers: { "x-session-key": sessionKey },
    });

    expect(await response.json()).toMatchObject({
      error: { code: -32600, message: expect.stringContaining("reserved") },
    });
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

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
        "x-openclaw-session-id": "session-123",
        "x-openclaw-account-id": "work",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-client-caps": "tool-events,inline-widgets",
        "x-openclaw-current-channel-id": "telegram:chat123",
        "x-openclaw-current-thread-ts": "42",
        "x-openclaw-current-message-id": "reply-message-1",
        "x-openclaw-current-inbound-audio": "true",
        "x-openclaw-inbound-event-kind": "room_event",
        "x-openclaw-source-reply-delivery-mode": "message_tool_only",
        "x-openclaw-task-suggestion-delivery-mode": "gateway",
        "x-openclaw-require-explicit-message-target": "true",
      }),
      body: mcpToolsListBody(),
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:telegram:group:chat123");
    expect(call.sessionId).toBe("session-123");
    expect(call.accountId).toBe("work");
    expect(call.messageProvider).toBe("telegram");
    expect(call.clientCaps).toEqual(["tool-events", "inline-widgets"]);
    expect(call.currentChannelId).toBe("telegram:chat123");
    expect(call.currentThreadTs).toBe("42");
    expect(call.currentMessageId).toBe("reply-message-1");
    expect(call.currentInboundAudio).toBe(true);
    expect(call.inboundEventKind).toBe("room_event");
    expect(call.sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(call.taskSuggestionDeliveryMode).toBe("gateway");
    expect(call.requireExplicitMessageTarget).toBe(true);
    expect(call.conversationReadOrigin).toBe("delegated");
    expect(call.surface).toBe("loopback");
    expect(call.includeNodeExecTool).toBe(false);
    expect(Array.from(call.excludeToolNames ?? [])).toEqual([
      "read",
      "write",
      "edit",
      "apply_patch",
      "exec",
      "process",
    ]);
  });

  it("normalizes whitespace, duplicate, and empty client capability headers", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sendWithCaps = async (clientCaps: string, currentMessageId: string) =>
      await sendLoopbackToolsList({
        token: runtime.ownerToken,
        headers: {
          "x-session-key": "agent:main:main",
          "x-openclaw-current-message-id": currentMessageId,
          "x-openclaw-client-caps": clientCaps,
        },
      });

    expect(
      (await sendWithCaps(" tool-events, inline-widgets,tool-events, , ", "message-capped")).status,
    ).toBe(200);
    expect((await sendWithCaps("", "message-capless")).status).toBe(200);

    expect(getScopedToolsCall(0).clientCaps).toEqual(["tool-events", "inline-widgets"]);
    expect(getScopedToolsCall(1).clientCaps).toBeUndefined();
  });

  it("binds an attach grant's session and ignores ALL spoofed context headers (no scope-shop)", async () => {
    const grant = mintAttachGrant({ sessionKey: "agent:main:attach-host" });
    const port = await getFreePortBlockWithPermissionFallback({
      offsets: [0],
      fallbackBase: 53_000,
    });
    const { port: serverPort } = await startLoopbackServerForTest(port);

    const response = await sendRaw({
      port: serverPort,
      token: grant.token,
      headers: jsonHeaders({
        "x-session-key": "agent:main:SPOOFED-other-session",
        "x-openclaw-message-channel": "telegram",
        "x-openclaw-client-caps": "inline-widgets",
        "x-openclaw-account-id": "victim-account",
        "x-openclaw-current-channel-id": "telegram:victim-chat",
        "x-openclaw-current-thread-ts": "999",
        "x-openclaw-source-reply-delivery-mode": "automatic",
        "x-openclaw-inbound-event-kind": "room_event",
      }),
      body: mcpToolsListBody(),
    });

    expect(response.status).toBe(200);
    const call = getScopedToolsCall(0);
    expect(call.sessionKey).toBe("agent:main:attach-host");
    expect(call.senderIsOwner).toBe(false);
    expect(call.surface).toBe("loopback");
    expect(call.messageProvider).toBeUndefined();
    expect(call.clientCaps).toBeUndefined();
    expect(call.accountId).toBeUndefined();
    expect(call.currentChannelId).toBeUndefined();
    expect(call.currentThreadTs).toBeUndefined();
    expect(call.sourceReplyDeliveryMode).toBeUndefined();
    expect(call.inboundEventKind).toBeUndefined();
    expect(call.conversationReadOrigin).toBe("delegated");
    expect(call.includeNodeExecTool).toBe(false);
    expect(Array.from(call.excludeToolNames ?? [])).toContain("exec");
  });

  it("binds a CLI grant's complete context and ignores spoofed scope headers", async () => {
    const { port, runtime } = await startLoopbackServerForTest();
    const grant = mintMcpLoopbackClientGrant({
      context: {
        sessionKey: "agent:main:discord:channel:bound",
        runtimePolicySessionKey: "agent:worker:discord:default:direct:bound-user",
        agentId: "worker",
        sessionId: "session-bound",
        runId: "run-bound",
        modelProvider: "anthropic",
        modelId: "claude-opus-4-7",
        messageProvider: "discord",
        clientCaps: ["tool-events"],
        currentChannelId: "discord:bound",
        currentThreadTs: "bound-thread",
        currentMessageId: "bound-message",
        currentInboundAudio: true,
        accountId: "bound-account",
        inboundEventKind: "user_request",
        sourceReplyDeliveryMode: "message_tool_only",
        taskSuggestionDeliveryMode: "gateway",
        requireExplicitMessageTarget: true,
        senderIsOwner: false,
        nodeExecAllowed: true,
        execOverrides: {
          host: "node",
          security: "allowlist",
          ask: "always",
          node: "mac-b",
        },
        bashElevated: {
          enabled: true,
          allowed: true,
          defaultLevel: "full",
          fullAccessAvailable: false,
          fullAccessBlockedReason: "runtime",
        },
        approvalReviewerDeviceId: "bound-reviewer",
        senderName: "Bound Name",
        senderUsername: "bound-user",
        senderE164: "+15557654321",
        groupId: "bound",
        groupChannel: "ops",
        groupSpace: "guild-bound",
        spawnedBy: "agent:main:discord:channel:parent",
      },
      runtimeOwnerToken: runtime.ownerToken,
    });
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey: "capture-bound",
      }),
    ).toBe(true);

    const sendWithCapture = async (captureKey?: string, method: "list" | "call" = "list") =>
      await sendRaw({
        port,
        token: grant.token,
        headers: jsonHeaders({
          ...(captureKey ? { "x-openclaw-cli-capture-key": captureKey } : {}),
          "x-session-key": "agent:main:main",
          "x-openclaw-session-id": "session-spoofed",
          "x-openclaw-message-channel": "telegram",
          "x-openclaw-client-caps": "inline-widgets,admin",
          "x-openclaw-account-id": "spoofed-account",
          "x-openclaw-current-channel-id": "telegram:spoofed",
          "x-openclaw-current-thread-ts": "spoofed-thread",
          "x-openclaw-current-message-id": "spoofed-message",
          "x-openclaw-current-inbound-audio": "false",
          "x-openclaw-inbound-event-kind": "room_event",
          "x-openclaw-source-reply-delivery-mode": "automatic",
          "x-openclaw-task-suggestion-delivery-mode": "direct",
          "x-openclaw-require-explicit-message-target": "false",
        }),
        body: method === "call" ? mcpToolCallBody("message") : mcpToolsListBody(),
      });

    expect((await sendWithCapture()).status).toBe(401);
    expect((await sendWithCapture("capture-forged")).status).toBe(401);
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();

    expect((await sendWithCapture("capture-bound")).status).toBe(200);
    expect((await sendWithCapture("capture-bound", "call")).status).toBe(200);
    const expectedBoundContext = {
      sessionKey: "agent:main:discord:channel:bound",
      runtimePolicySessionKey: "agent:worker:discord:default:direct:bound-user",
      agentId: "worker",
      sessionId: "session-bound",
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
      messageProvider: "discord",
      clientCaps: ["tool-events"],
      currentChannelId: "discord:bound",
      currentThreadTs: "bound-thread",
      currentMessageId: "bound-message",
      currentInboundAudio: true,
      accountId: "bound-account",
      inboundEventKind: "user_request",
      sourceReplyDeliveryMode: "message_tool_only",
      taskSuggestionDeliveryMode: "gateway",
      requireExplicitMessageTarget: true,
      senderIsOwner: false,
      nodeExecAllowed: true,
      execOverrides: {
        host: "node",
        security: "allowlist",
        ask: "always",
        node: "mac-b",
      },
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
      approvalReviewerDeviceId: "bound-reviewer",
      senderName: "Bound Name",
      senderUsername: "bound-user",
      senderE164: "+15557654321",
      groupId: "bound",
      groupChannel: "ops",
      groupSpace: "guild-bound",
      spawnedBy: "agent:main:discord:channel:parent",
      surface: "loopback",
    };
    expect(getScopedToolsCall(0)).toMatchObject(expectedBoundContext);
    expect(getScopedToolsCall(1)).toMatchObject(expectedBoundContext);
    expect(getScopedToolsCall(0).includeNodeExecTool).toBe(true);
    expect(Array.from(getScopedToolsCall(0).excludeToolNames ?? [])).not.toContain("exec");
    expect(getBeforeToolCallHookInput(0).ctx).toMatchObject({
      agentId: "main",
      sessionKey: "agent:main:discord:channel:bound",
      sessionId: "session-bound",
      runId: "run-bound",
      approvalReviewerDeviceId: "bound-reviewer",
      channelId: "discord:bound",
      turnSourceChannel: "discord",
      turnSourceTo: "discord:bound",
      turnSourceAccountId: "bound-account",
      turnSourceThreadId: "bound-thread",
    });
    expect(getBeforeToolCallHookInput(0).ctx).toHaveProperty("loopDetection");
  });

  it("revalidates a CLI grant after async preparation before tool execution", async () => {
    let releasePreparation: (() => void) | undefined;
    let markPreparationStarted: (() => void) | undefined;
    const preparationGate = new Promise<void>((resolve) => {
      releasePreparation = resolve;
    });
    const preparationStarted = new Promise<void>((resolve) => {
      markPreparationStarted = resolve;
    });
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "should not execute" }],
    }));
    mockScopedTools([
      makeMockTool({
        name: "exec",
        prepareBeforeToolCallParams: async (args) => {
          markPreparationStarted?.();
          await preparationGate;
          return args;
        },
        execute,
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();
    const grant = mintMcpLoopbackClientGrant({
      context: {
        sessionKey: "agent:main:main",
        senderIsOwner: true,
        nodeExecAllowed: true,
      },
      runtimeOwnerToken: runtime.ownerToken,
    });
    const captureKey = "capture-revoked-during-prepare";
    expect(
      activateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      }),
    ).toBe(true);

    const responsePromise = sendLoopbackToolCall({
      token: grant.token,
      name: "exec",
      headers: { "x-openclaw-cli-capture-key": captureKey },
    });
    await preparationStarted;
    expect(
      deactivateMcpLoopbackClientGrantCapture({
        token: grant.token,
        runtimeOwnerToken: runtime.ownerToken,
        captureKey,
      }),
    ).toBe(true);
    releasePreparation?.();

    const response = await responsePromise;
    const payload = await readMcpPayload(response);
    expect(response.status).toBe(200);
    expect(payload.result?.isError).toBe(true);
    expect(payload.result?.content).toEqual([
      { type: "text", text: "Tool call authorization expired" },
    ]);
    expect(execute).not.toHaveBeenCalled();
  });

  it("rejects revoked and prior-runtime CLI grants", async () => {
    const firstServer = await startLoopbackServerForTest();
    const staleGrant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:stale", senderIsOwner: false },
      runtimeOwnerToken: firstServer.runtime.ownerToken,
    });
    activateMcpLoopbackClientGrantCapture({
      token: staleGrant.token,
      runtimeOwnerToken: firstServer.runtime.ownerToken,
      captureKey: "capture-stale",
    });
    await server?.close();
    server = undefined;

    const successor = await startLoopbackServerForTest();
    expect(
      (
        await sendRaw({
          port: successor.port,
          token: staleGrant.token,
          headers: jsonHeaders({ "x-openclaw-cli-capture-key": "capture-stale" }),
          body: mcpToolsListBody(),
        })
      ).status,
    ).toBe(401);

    const revokedGrant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:revoked", senderIsOwner: false },
      runtimeOwnerToken: successor.runtime.ownerToken,
    });
    activateMcpLoopbackClientGrantCapture({
      token: revokedGrant.token,
      runtimeOwnerToken: successor.runtime.ownerToken,
      captureKey: "capture-revoked",
    });
    expect(revokeMcpLoopbackClientGrant(revokedGrant.token)).toBe(true);
    expect(
      (
        await sendRaw({
          port: successor.port,
          token: revokedGrant.token,
          headers: jsonHeaders({ "x-openclaw-cli-capture-key": "capture-revoked" }),
          body: mcpToolsListBody(),
        })
      ).status,
    ).toBe(401);
  });

  it("routes sessions_yield to the current CLI capture", async () => {
    resolveGatewayScopedToolsMock.mockImplementation((input): MockGatewayScopedTools => {
      const call = input as ScopedToolsCall;
      return {
        agentId: "main",
        tools: [
          makeMockTool({
            name: "sessions_yield",
            execute: async (_toolCallId, args) => {
              if (!call.sessionId) {
                throw new Error("No session context");
              }
              if (!call.onYield) {
                throw new Error("Yield not supported in this context");
              }
              const message = (args as { message?: string }).message ?? "Turn yielded.";
              await call.onYield(message);
              return {
                content: [{ type: "text", text: JSON.stringify({ status: "yielded", message }) }],
              };
            },
          }),
        ],
      };
    });
    const { runtime } = await startLoopbackServerForTest();
    const firstYield = vi.fn();
    const secondYield = vi.fn();
    const sendYield = async (
      captureKey: string,
      message: string,
      onYield: (message: string) => void,
    ) => {
      beginMcpLoopbackToolCallCapture({
        captureKey,
        onYield,
        onToolCallResult: vi.fn(),
      });
      return await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "sessions_yield",
        args: { message },
        headers: {
          "x-session-key": "agent:main:main",
          "x-openclaw-session-id": "session-reused",
          "x-openclaw-cli-capture-key": captureKey,
        },
      });
    };

    const captureKey = "capture-reused";
    expect((await sendYield(captureKey, "first yield", firstYield)).status).toBe(200);
    expect((await sendYield(captureKey, "second yield", secondYield)).status).toBe(200);

    expect(firstYield).toHaveBeenCalledWith("first yield");
    expect(secondYield).toHaveBeenCalledWith("second yield");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps loopback tool cache entries separate by inbound event, delivery, audio, and target policy", async () => {
    const { runtime } = await startLoopbackServerForTest();
    const sendToolsList = async (
      inboundEventKind: string,
      sourceReplyDeliveryMode?: string,
      currentInboundAudio?: boolean,
      requireExplicitMessageTarget?: boolean,
      taskSuggestionDeliveryMode?: string,
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
          ...(requireExplicitMessageTarget
            ? { "x-openclaw-require-explicit-message-target": "true" }
            : {}),
          ...(taskSuggestionDeliveryMode
            ? { "x-openclaw-task-suggestion-delivery-mode": taskSuggestionDeliveryMode }
            : {}),
        },
      });

    expect((await sendToolsList("user_request")).status).toBe(200);
    expect((await sendToolsList("room_event")).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only")).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only", true)).status).toBe(200);
    expect((await sendToolsList("room_event", "message_tool_only", true, true)).status).toBe(200);
    expect(
      (await sendToolsList("room_event", "message_tool_only", true, true, "gateway")).status,
    ).toBe(200);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(6);
    expect(getScopedToolsCall(0).inboundEventKind).toBe("user_request");
    expect(getScopedToolsCall(1).inboundEventKind).toBe("room_event");
    expect(getScopedToolsCall(2).sourceReplyDeliveryMode).toBe("message_tool_only");
    expect(getScopedToolsCall(3).currentInboundAudio).toBe(true);
    expect(getScopedToolsCall(4).requireExplicitMessageTarget).toBe(true);
    expect(getScopedToolsCall(5).taskSuggestionDeliveryMode).toBe("gateway");
  });

  it("keeps capless and capability-scoped tool cache entries separate", async () => {
    resolveGatewayScopedToolsMock.mockImplementation((input): MockGatewayScopedTools => {
      const call = input as ScopedToolsCall;
      return {
        agentId: "main",
        tools: [
          makeMessageTool(),
          ...(call.clientCaps?.includes("inline-widgets")
            ? [makeMockTool({ name: "show_widget" })]
            : []),
        ],
      };
    });
    const { runtime } = await startLoopbackServerForTest();
    const listTools = async (clientCaps?: string) =>
      await readMcpPayload(
        await sendLoopbackToolsList({
          token: runtime.ownerToken,
          headers: {
            "x-session-key": "agent:main:main",
            ...(clientCaps ? { "x-openclaw-client-caps": clientCaps } : {}),
          },
        }),
      );

    const capless = await listTools();
    const capped = await listTools("inline-widgets");

    expect(capless.result?.tools?.map((tool) => tool.name)).not.toContain("show_widget");
    expect(capped.result?.tools?.map((tool) => tool.name)).toContain("show_widget");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(2);
  });

  it("keeps explicit non-owner and unknown-owner loopback cache entries separate", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      accountId: undefined,
      cfg: { session: { mainKey: "main" } } as never,
      currentChannelId: "telegram:chat123",
      currentInboundAudio: undefined,
      currentMessageId: "message-1",
      currentThreadTs: "thread-1",
      inboundEventKind: "room_event",
      messageProvider: "telegram",
      sessionKey: "agent:main:telegram:group:chat123",
      sourceReplyDeliveryMode: "message_tool_only",
    } satisfies Omit<Parameters<McpLoopbackToolCache["resolve"]>[0], "senderIsOwner">;
    resolveGatewayScopedToolsMock.mockImplementation((input: unknown) => {
      const params = input as { senderIsOwner?: boolean };
      return {
        agentId: "main",
        tools:
          params.senderIsOwner === false
            ? [makeMessageTool()]
            : [makeMessageTool(), makeCronTool()],
      };
    });

    const unknownFirst = cache.resolve({ ...baseParams, senderIsOwner: undefined });
    const nonOwnerSecond = cache.resolve({ ...baseParams, senderIsOwner: false });
    expect(unknownFirst.toolSchema.map((tool) => tool.name)).toContain("cron");
    expect(nonOwnerSecond.toolSchema.map((tool) => tool.name)).not.toContain("cron");

    const secondCache = new McpLoopbackToolCache();
    const nonOwnerFirst = secondCache.resolve({ ...baseParams, senderIsOwner: false });
    const unknownSecond = secondCache.resolve({ ...baseParams, senderIsOwner: undefined });
    expect(nonOwnerFirst.toolSchema.map((tool) => tool.name)).not.toContain("cron");
    expect(unknownSecond.toolSchema.map((tool) => tool.name)).toContain("cron");

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(4);
  });

  it("keeps CLI node-exec capability and session defaults cache-bound", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      cfg: {} as never,
      sessionKey: "agent:main:direct:test",
      messageProvider: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: true,
    } satisfies Parameters<McpLoopbackToolCache["resolve"]>[0];
    resolveGatewayScopedToolsMock.mockImplementation((input: unknown) => {
      const params = input as ScopedToolsCall;
      return {
        agentId: "main",
        tools: params.includeNodeExecTool
          ? [makeMessageTool(), makeMockTool({ name: "exec" })]
          : [makeMessageTool()],
      };
    });

    const withoutExec = cache.resolve({ ...baseParams, nodeExecAllowed: false });
    const withExec = cache.resolve({
      ...baseParams,
      nodeExecAllowed: true,
      execSession: { execHost: "node", execNode: "mac-a" },
    });
    cache.resolve({
      ...baseParams,
      nodeExecAllowed: true,
      execSession: { execHost: "node", execNode: "mac-b" },
    });

    expect(withoutExec.toolSchema.map((tool) => tool.name)).not.toContain("exec");
    expect(withExec.toolSchema.map((tool) => tool.name)).toContain("exec");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(3);
  });

  it("keeps model policy identity cache-bound", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      cfg: {} as never,
      sessionKey: "agent:main:direct:test",
      messageProvider: undefined,
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: true,
      nodeExecAllowed: true,
    } satisfies Parameters<McpLoopbackToolCache["resolve"]>[0];
    resolveGatewayScopedToolsMock.mockImplementation((input: unknown) => {
      const params = input as ScopedToolsCall;
      const blocked = params.modelProvider === "anthropic" && params.modelId === "claude-opus-4-7";
      return {
        agentId: "main",
        tools: blocked ? [makeMessageTool()] : [makeMessageTool(), makeMockTool({ name: "exec" })],
      };
    });

    const openAi = cache.resolve({
      ...baseParams,
      modelProvider: "openai",
      modelId: "gpt-5.5",
    });
    const blockedAnthropic = cache.resolve({
      ...baseParams,
      modelProvider: "anthropic",
      modelId: "claude-opus-4-7",
    });
    const allowedAnthropic = cache.resolve({
      ...baseParams,
      modelProvider: "anthropic",
      modelId: "claude-sonnet-4-6",
    });
    cache.resolve({ ...baseParams, modelProvider: "openai", modelId: "gpt-5.5" });

    expect(openAi.toolSchema.map((tool) => tool.name)).toContain("exec");
    expect(blockedAnthropic.toolSchema.map((tool) => tool.name)).not.toContain("exec");
    expect(allowedAnthropic.toolSchema.map((tool) => tool.name)).toContain("exec");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(3);
  });

  it("keeps exec overrides and sender identities cache-bound", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      cfg: {} as never,
      sessionKey: "agent:main:direct:test",
      messageProvider: "discord",
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: false,
      nodeExecAllowed: true,
    } satisfies Parameters<McpLoopbackToolCache["resolve"]>[0];

    cache.resolve(baseParams);
    cache.resolve({ ...baseParams, execOverrides: { host: "gateway" } });
    cache.resolve({ ...baseParams, senderName: "Guest Name" });
    cache.resolve({ ...baseParams, senderUsername: "guest-user" });
    cache.resolve({ ...baseParams, senderE164: "+15550001111" });
    cache.resolve({ ...baseParams, groupId: "group-a" });
    cache.resolve({ ...baseParams, groupChannel: "ops" });
    cache.resolve({ ...baseParams, groupSpace: "guild-a" });
    cache.resolve({ ...baseParams, spawnedBy: "agent:main:discord:channel:parent" });
    cache.resolve({
      ...baseParams,
      runtimePolicySessionKey: "agent:main:discord:default:direct:guest",
    });
    cache.resolve({ ...baseParams, agentId: "worker" });
    cache.resolve(baseParams);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(11);
  });

  it("keeps every elevated-exec authority field cache-bound", () => {
    const cache = new McpLoopbackToolCache();
    const baseParams = {
      cfg: {} as never,
      sessionKey: "agent:main:direct:test",
      messageProvider: "discord",
      currentChannelId: undefined,
      currentThreadTs: undefined,
      currentMessageId: undefined,
      currentInboundAudio: undefined,
      accountId: undefined,
      inboundEventKind: undefined,
      sourceReplyDeliveryMode: undefined,
      senderIsOwner: true,
      nodeExecAllowed: true,
    } satisfies Parameters<McpLoopbackToolCache["resolve"]>[0];

    cache.resolve(baseParams);
    cache.resolve({
      ...baseParams,
      bashElevated: { enabled: false, allowed: false, defaultLevel: "off" },
    });
    cache.resolve({
      ...baseParams,
      bashElevated: { enabled: true, allowed: true, defaultLevel: "ask" },
    });
    cache.resolve({
      ...baseParams,
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: true,
      },
    });
    cache.resolve({
      ...baseParams,
      bashElevated: {
        enabled: true,
        allowed: true,
        defaultLevel: "full",
        fullAccessAvailable: false,
        fullAccessBlockedReason: "runtime",
      },
    });
    cache.resolve(baseParams);

    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(5);
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
          label: "Schema probe",
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
    for (const index of [0, 1]) {
      expect(getScopedToolsCall(index).includeNodeExecTool).toBe(false);
      expect(Array.from(getScopedToolsCall(index).excludeToolNames ?? [])).toContain("exec");
    }
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
    const cronExecute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "CRON_EXECUTED" }],
    }));
    const args = { action: "status" };
    mockScopedTools([makeMessageTool(), makeCronTool({ execute: cronExecute })]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "cron",
      args,
    });

    expect(cronExecute).toHaveBeenCalledTimes(1);
    expect(getBeforeToolCallHookInput(0).params).toEqual(args);
    expect(cronExecute.mock.calls[0]?.[1]).toEqual(args);
    expectMcpResultText(payload, "CRON_EXECUTED");
  });

  it.each([
    ["null", null],
    ["array", []],
    ["string", "bad"],
  ])("rejects %s tool call arguments before hooks or execution", async (_label, badArguments) => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    mockScopedTools([makeMessageTool({ execute })]);
    const { runtime, port } = await startLoopbackServerForTest();

    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message", arguments: badArguments },
      }),
    });

    expect(response.status).toBe(200);
    expect(await readMcpPayload(response)).toEqual({
      jsonrpc: "2.0",
      id: 1,
      error: {
        code: -32602,
        message: "Invalid params: tools/call arguments must be an object",
      },
    });
    expect(runBeforeToolCallHookMock).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("keeps omitted tool call arguments as an empty object", async () => {
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    mockScopedTools([makeMessageTool({ execute })]);
    const { runtime, port } = await startLoopbackServerForTest();

    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: jsonHeaders(),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message" },
      }),
    });

    expect(response.status).toBe(200);
    expectMcpResultText(await readMcpPayload(response), "EXECUTED");
    expect(runBeforeToolCallHookMock).toHaveBeenCalledTimes(1);
    expect(getBeforeToolCallHookInput(0).params).toEqual({});
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[1]).toEqual({});
  });

  it("preserves valid MCP content blocks returned by loopback tools", async () => {
    const content = [
      { type: "text", text: "caption", annotations: { audience: ["user"] } },
      { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      {
        type: "resource",
        resource: { uri: "memo://one", text: "memo body", mimeType: "text/plain" },
      },
    ];
    mockScopedTools([
      makeMockTool({
        name: "content_probe",
        execute: async () => ({ content }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "content_probe",
    });

    expect(payload.result?.content).toEqual(content);
  });

  it("converts malformed, unknown, and unsupported MCP content blocks to text", async () => {
    const malformed = [
      { type: "image", mimeType: "image/png" },
      { type: "audio", data: "not base64!", mimeType: "audio/mpeg" },
      { type: "audio", data: "YXVkaW8=", mimeType: "audio/mpeg" },
      {
        type: "resource_link",
        name: "report",
        uri: "https://example.test/report.pdf",
        mimeType: "application/pdf",
      },
      { type: "tool_use", id: "unexpected" },
    ];
    mockScopedTools([
      makeMockTool({
        name: "malformed_content_probe",
        execute: async () => ({ content: malformed }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const payload = await callMainSessionTool({
      token: runtime?.ownerToken,
      name: "malformed_content_probe",
    });

    expect(payload.result?.content).toEqual(
      malformed.map((block) => ({ type: "text", text: JSON.stringify(block) })),
    );
  });

  it("captures only successful calls with an explicit CLI capture key", async () => {
    const captureKey = "google-gemini-cli";
    const captured: Array<{ toolName: string; args: Record<string, unknown> }> = [];
    const blockedResults: unknown[] = [];
    const startedTargets: unknown[] = [];
    const finishedTargets: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => {
        startedTargets.push(args.target);
        return typeof args.target === "string" ? args.target : undefined;
      },
      onToolCallFinish: ({ args }) => finishedTargets.push(args.target),
      onToolCallResult: (result) => {
        if (result.outcome === "blocked") {
          blockedResults.push({
            correlationId: result.correlationId,
            deniedReason: result.deniedReason,
          });
        } else if (result.toolName === "message" && result.args.action === "send") {
          captured.push({ toolName: result.toolName, args: result.args });
        }
      },
    });
    const { runtime } = await startLoopbackServerForTest();

    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "chat123", message: "sent" },
          headers: { "x-openclaw-cli-capture-key": captureKey },
        })
      ).status,
    ).toBe(200);

    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: true,
      kind: "veto",
      reason: "blocked for test",
    });
    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "blocked", message: "not sent" },
          headers: { "x-openclaw-cli-capture-key": captureKey },
        })
      ).status,
    ).toBe(200);

    expect(
      (
        await sendLoopbackToolCall({
          token: runtime.ownerToken,
          name: "message",
          args: { action: "send", target: "implicit-main", message: "not captured" },
        })
      ).status,
    ).toBe(200);

    expect(captured).toEqual([
      expect.objectContaining({
        toolName: "message",
        args: { action: "send", target: "chat123", message: "sent" },
      }),
    ]);
    expect(startedTargets).toEqual(["chat123", "blocked"]);
    expect(finishedTargets).toEqual(["chat123", "blocked"]);
    expect(blockedResults).toEqual([
      { correlationId: "blocked", deniedReason: "plugin-before-tool-call" },
    ]);
  });

  it("preserves hook failure dispositions in CLI capture", async () => {
    const captureKey = "hook-failure-dispositions";
    const captured: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => String(args.target),
      onToolCallResult: (result) => {
        captured.push({
          outcome: result.outcome,
          correlationId: result.correlationId,
          ...(result.outcome === "blocked" ? { deniedReason: result.deniedReason } : {}),
        });
      },
    });
    const { runtime } = await startLoopbackServerForTest();
    const cases = [
      { disposition: "failed" },
      { disposition: "cancelled" },
      { disposition: "timed_out" },
      { disposition: "blocked", deniedReason: "plugin-approval" },
    ] as const;

    for (const testCase of cases) {
      runBeforeToolCallHookMock.mockResolvedValueOnce({
        blocked: true,
        kind: "failure",
        disposition: testCase.disposition,
        ...(testCase.disposition === "blocked" ? { deniedReason: testCase.deniedReason } : {}),
        reason: "hook prevented execution",
      });
      const response = await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "message",
        args: { action: "send", target: testCase.disposition, message: "not sent" },
        headers: { "x-openclaw-cli-capture-key": captureKey },
      });
      expect(response.status).toBe(200);
      expect((await readMcpPayload(response)).result?.isError).toBe(true);
    }

    expect(captured).toEqual([
      { outcome: "failed", correlationId: "failed" },
      { outcome: "cancelled", correlationId: "cancelled" },
      { outcome: "timed_out", correlationId: "timed_out" },
      {
        outcome: "blocked",
        correlationId: "blocked",
        deniedReason: "plugin-approval",
      },
    ]);
  });

  it("classifies resolved structured results for CLI capture", async () => {
    const captureKey = "structured-results";
    const captured: unknown[] = [];
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallStart: ({ args }) => String(args.status),
      onToolCallResult: (result) => {
        captured.push({
          outcome: result.outcome,
          correlationId: result.correlationId,
          ...(result.outcome === "blocked" ? { deniedReason: result.deniedReason } : {}),
        });
      },
    });
    mockScopedTools([
      makeMessageTool({
        execute: async (_toolCallId, args) => ({
          content: [{ type: "text", text: "result" }],
          details: args as Record<string, unknown>,
        }),
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();
    const cases = [
      { status: "completed", expected: "completed" },
      { status: "failed", expected: "failed" },
      { status: "blocked", expected: "blocked" },
      { status: "cancelled", expected: "cancelled" },
      { status: "completed-timeout", expected: "timed_out", timedOut: true },
    ] as const;

    for (const testCase of cases) {
      const response = await sendLoopbackToolCall({
        token: runtime.ownerToken,
        name: "message",
        args: {
          status: testCase.status === "completed-timeout" ? "completed" : testCase.status,
          ...("timedOut" in testCase && testCase.timedOut ? { timedOut: true } : {}),
        },
        headers: { "x-openclaw-cli-capture-key": captureKey },
      });
      expect(response.status).toBe(200);
      const payload = await readMcpPayload(response);
      expect(payload.result?.isError).toBe(testCase.expected !== "completed");
    }

    expect(captured).toEqual([
      { outcome: "completed", correlationId: "completed" },
      { outcome: "failed", correlationId: "failed" },
      {
        outcome: "blocked",
        correlationId: "blocked",
        deniedReason: "tool_result_blocked",
      },
      { outcome: "cancelled", correlationId: "cancelled" },
      { outcome: "timed_out", correlationId: "completed" },
    ]);
  });

  it("updates capture accounting with hook-rewritten tool arguments", async () => {
    const captureKey = "hook-rewritten-send";
    const updatedCalls = vi.fn();
    const finishedCalls = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallUpdate: updatedCalls,
      onToolCallFinish: finishedCalls,
      onToolCallResult: vi.fn(),
    });
    runBeforeToolCallHookMock.mockResolvedValueOnce({
      blocked: false,
      params: {
        action: "send",
        target: "rewritten-target",
        message: "rewritten send",
      },
    });
    const { runtime } = await startLoopbackServerForTest();

    await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "react", target: "original-target" },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    });

    expect(updatedCalls).toHaveBeenCalledWith({
      previous: {
        toolName: "message",
        args: { action: "react", target: "original-target" },
      },
      current: {
        toolName: "message",
        args: {
          action: "send",
          target: "rewritten-target",
          message: "rewritten send",
        },
      },
    });
    expect(finishedCalls).toHaveBeenCalledWith(
      {
        toolName: "message",
        args: {
          action: "send",
          target: "rewritten-target",
          message: "rewritten send",
        },
      },
      { prepared: true },
    );
  });

  it("reports oversized successful calls without retaining their payloads", () => {
    const captureKey = "oversized-capture";
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: captured,
    });

    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "chat123" },
    });
    if (!captureHandle) {
      throw new Error("Expected active MCP capture");
    }
    recordMcpLoopbackToolCallResult({
      captureHandle,
      toolName: "message",
      args: { action: "send", target: "chat123" },
      result: { content: "x".repeat(20 * 1024) },
      outcome: "completed",
    });
    markMcpLoopbackToolCallFinished(captureHandle);

    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        args: { action: "send", target: "chat123" },
      }),
    );
  });

  it("keeps admitted calls bound to their original capture generation", () => {
    const captureKey = "generation-bound-capture";
    const firstCapture = vi.fn();
    const secondCapture = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: firstCapture,
    });
    const firstHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "first-turn" },
    });
    if (!firstHandle) {
      throw new Error("Expected first MCP capture generation");
    }
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: secondCapture,
    });

    recordMcpLoopbackToolCallResult({
      captureHandle: firstHandle,
      toolName: "message",
      args: { action: "send", target: "first-turn" },
      result: { status: "sent" },
      outcome: "completed",
    });
    markMcpLoopbackToolCallFinished(firstHandle);

    expect(firstCapture).toHaveBeenCalledOnce();
    expect(secondCapture).not.toHaveBeenCalled();
  });

  it("binds slow request bodies to their capture generation at header acceptance", async () => {
    const captureKey = "slow-request-generation";
    const requestClassified = vi.fn();
    const requestStarted = vi.fn();
    const captured = vi.fn();
    let resolveRequestStarted: (() => void) | undefined;
    const requestStartedPromise = new Promise<void>((resolve) => {
      resolveRequestStarted = resolve;
    });
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onRequestStart: () => {
        requestStarted();
        resolveRequestStarted?.();
      },
      onRequestClassified: requestClassified,
      onToolCallResult: captured,
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const responsePromise = new Promise<{ status: number | undefined; body: string }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            path: "/mcp",
            method: "POST",
            headers: {
              authorization: `Bearer ${runtime.ownerToken}`,
              "content-type": "application/json",
              "transfer-encoding": "chunked",
              "x-openclaw-cli-capture-key": captureKey,
            },
          },
          (res) => {
            let body = "";
            res.setEncoding("utf8");
            res.on("data", (chunk) => {
              body += chunk;
            });
            res.on("end", () => resolve({ status: res.statusCode, body }));
          },
        );
        req.on("error", reject);
        req.flushHeaders();
        void requestStartedPromise.then(() => {
          clearMcpLoopbackToolCallCapture(captureKey);
          req.end(mcpToolCallBody("message", { action: "send", target: "late-body" }));
        });
      },
    );

    await requestStartedPromise;
    expect(requestStarted).toHaveBeenCalledOnce();
    expect(requestClassified).not.toHaveBeenCalled();
    const response = await responsePromise;

    expect(response.status).toBe(200);
    expect(requestClassified).toHaveBeenCalledOnce();
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        args: { action: "send", target: "late-body" },
        outcome: "completed",
      }),
    );
  });

  it("waits through a quiet admission grace before clearing a failed-turn capture", async () => {
    const captureKey = "admission-grace";
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: vi.fn(),
    });
    const idlePromise = waitForMcpLoopbackToolCallCaptureIdle(captureKey, {
      timeoutMs: 500,
      admissionGraceMs: 40,
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "late-admission" },
    });
    if (!captureHandle) {
      throw new Error("Expected late MCP capture admission");
    }
    setTimeout(() => markMcpLoopbackToolCallFinished(captureHandle), 10);

    await expect(idlePromise).resolves.toBe(true);
  });

  it("keeps capture observer errors from changing tool success", async () => {
    const captureKey = "throwing-observer";
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: () => {
        throw new Error("observer failed");
      },
    });
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "send", target: "chat123", message: "sent" },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    });

    expect(response.status).toBe(200);
    const payload = await readMcpPayload(response);
    expect(payload.result?.isError).toBe(false);
  });

  it("captures partial-delivery errors before returning the tool failure", async () => {
    const captureKey = "partial-delivery";
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: captured,
    });
    mockScopedTools([
      makeMessageTool({
        execute: async () => {
          throw Object.assign(new Error("second chunk failed"), { sentBeforeError: true });
        },
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "send", target: "chat123", message: "sent partly" },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    });

    const payload = await readMcpPayload(response);
    expect(payload.result?.isError).toBe(true);
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        outcome: "failed",
        result: expect.objectContaining({ sentBeforeError: true }),
      }),
    );
  });

  it("preserves thrown timeout outcomes in CLI capture", async () => {
    const captureKey = "thrown-timeout";
    const captured = vi.fn();
    const timeoutError = Object.assign(new Error("tool deadline elapsed"), {
      name: "TimeoutError",
    });
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: captured,
    });
    mockScopedTools([
      makeMessageTool({
        execute: async () => {
          throw timeoutError;
        },
      }),
    ]);
    const { runtime } = await startLoopbackServerForTest();

    const response = await sendLoopbackToolCall({
      token: runtime.ownerToken,
      name: "message",
      args: { action: "send", target: "chat123", message: "late" },
      headers: { "x-openclaw-cli-capture-key": captureKey },
    });

    expect((await readMcpPayload(response)).result?.isError).toBe(true);
    expect(captured).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "message",
        outcome: "timed_out",
        result: timeoutError,
      }),
    );
  });

  it("ignores calls after a capture is cleared", () => {
    const captureKey = "cleared-capture";
    const captured = vi.fn();
    beginMcpLoopbackToolCallCapture({
      captureKey,
      onToolCallResult: captured,
    });
    clearMcpLoopbackToolCallCapture(captureKey);
    const captureHandle = markMcpLoopbackToolCallStarted({
      captureKey,
      toolName: "message",
      args: { action: "send", target: "old-turn" },
    });

    expect(captureHandle).toBeUndefined();
    expect(captured).not.toHaveBeenCalled();
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
      kind: "veto",
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

  it("prepares and finalizes loopback tool params around before-tool hooks", async () => {
    const preparedObject = {
      stage: "prepared",
      privateState: "preserved",
    };
    const prepareBeforeToolCallParams = vi.fn(async () => preparedObject);
    const finalizeBeforeToolCallParams = vi.fn((hookParams: unknown, preparedParams: unknown) => ({
      ...(hookParams as Record<string, unknown>),
      privateState: (preparedParams as Record<string, unknown>).privateState,
      stage: "finalized",
    }));
    const execute = vi.fn<MockGatewayTool["execute"]>(async () => ({
      content: [{ type: "text", text: "EXECUTED" }],
    }));
    const tool = makeMessageTool({
      prepareBeforeToolCallParams,
      finalizeBeforeToolCallParams,
      execute,
    });
    const onToolCallPrepared = vi.fn();
    const onToolCallResult = vi.fn();
    runBeforeToolCallHookMock.mockImplementationOnce(async ({ params: hookParams }) => {
      expect(hookParams).toEqual({ stage: "prepared", privateState: "preserved" });
      return { blocked: false, params: { stage: "hook-adjusted" } };
    });

    const payload = await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message", arguments: { stage: "raw" } },
      },
      tools: [tool as unknown as AnyAgentTool],
      toolSchema: buildMockMcpToolSchema([tool]),
      hookContext: { sessionKey: "agent:main:main" },
      onToolCallPrepared,
      onToolCallResult,
    });

    expect(prepareBeforeToolCallParams).toHaveBeenCalledWith(
      { stage: "raw" },
      expect.objectContaining({
        toolCallId: expect.stringMatching(/^mcp-/),
        hookContext: { sessionKey: "agent:main:main" },
      }),
    );
    expect(finalizeBeforeToolCallParams).toHaveBeenCalledWith(
      { stage: "hook-adjusted" },
      { stage: "prepared", privateState: "preserved" },
    );
    expect(finalizeBeforeToolCallParams.mock.calls[0]?.[1]).toBe(preparedObject);
    const finalArgs = {
      stage: "finalized",
      privateState: "preserved",
    };
    expect(execute).toHaveBeenCalledWith(expect.stringMatching(/^mcp-/), finalArgs, undefined);
    expect(onToolCallPrepared).toHaveBeenCalledWith({ toolName: "message", args: finalArgs });
    expect(onToolCallResult).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "message", args: finalArgs, outcome: "completed" }),
    );
    expect(payload).toMatchObject({ result: { isError: false } });
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

  it("preserves request-disconnect evidence without classifying a tool failure", async () => {
    const controller = new AbortController();
    controller.abort();
    const onToolCallResult = vi.fn();
    const partialDelivery = Object.assign(new Error("request disconnected"), {
      name: "AbortError",
      sentBeforeError: true,
    });
    const tool = makeMessageTool({
      execute: async () => {
        throw partialDelivery;
      },
    });

    await handleMcpJsonRpc({
      message: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "message", arguments: { body: "hello" } },
      },
      tools: [tool as unknown as AnyAgentTool],
      toolSchema: buildMockMcpToolSchema([tool]),
      signal: controller.signal,
      onToolCallResult,
    });

    expect(onToolCallResult).toHaveBeenCalledWith({
      toolName: "message",
      args: { body: "hello" },
      outcome: "unknown",
      result: partialDelivery,
    });
  });

  it("tracks the active runtime only while the server is running", async () => {
    server = await ensureMcpLoopbackServer(0);
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
    server = await ensureMcpLoopbackServer(0);
    const response = await sendRaw({
      port: server.port,
      headers: { "content-type": "application/json" },
      body: mcpToolsListBody(),
    });
    expect(response.status).toBe(401);
  });

  it("returns 415 when the content type is not JSON", async () => {
    server = await ensureMcpLoopbackServer(0);
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
    server = await ensureMcpLoopbackServer(0);
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
    server = await ensureMcpLoopbackServer(0);
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

  it("does not include notifications in internal-error batch responses", async () => {
    resolveGatewayScopedToolsMock.mockImplementation(() => {
      throw new Error("tool resolution exploded");
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/list" },
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
      ]),
    });
    const payload = (await response.json()) as Array<{
      id?: unknown;
      error?: { code?: number; message?: string };
    }>;

    expect(response.status).toBe(500);
    expect(payload).toHaveLength(1);
    expect(payload[0]).toMatchObject({
      id: 42,
      error: {
        code: -32603,
        message: "Internal error",
      },
    });
  });

  it("returns invalid request errors for malformed batch entries without resetting the request", async () => {
    server = await ensureMcpLoopbackServer(0);
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

  it("returns an invalid request for an empty batch before harness policy", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: {
        "content-type": "application/json",
        "x-session-key": "agent:main:harness:codex:supervision:native-thread",
      },
      body: "[]",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      id: null,
      error: { code: -32600, message: "Invalid Request" },
    });
    expect(resolveGatewayScopedToolsMock).not.toHaveBeenCalled();
  });

  it("returns 202 with an empty body for JSON-RPC notifications", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
  });

  it("suppresses internal errors for notification-only requests", async () => {
    resolveGatewayScopedToolsMock.mockImplementation(() => {
      throw new Error("tool resolution exploded");
    });
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "tools/list" }),
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
  });

  it("returns only request responses for mixed batches", async () => {
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "tools/list" },
        { jsonrpc: "2.0", id: 42, method: "tools/list" },
      ]),
    });
    const payload = (await response.json()) as Array<{ id?: unknown }>;

    expect(response.status).toBe(200);
    expect(payload).toHaveLength(1);
    expect(payload[0]?.id).toBe(42);
  });

  it("dispatches tools/call notifications without returning a response", async () => {
    const execute = vi.fn(async () => ({
      content: [{ type: "text", text: "ok" }],
    }));
    mockScopedTools([makeMessageTool({ execute })]);
    const { runtime, port } = await startLoopbackServerForTest();
    const response = await sendRaw({
      port,
      token: runtime.ownerToken,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tools/call",
        params: { name: "message", arguments: { body: "hello" } },
      }),
    });

    expect(response.status).toBe(202);
    await expect(response.text()).resolves.toBe("");
    expect(resolveGatewayScopedToolsMock).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("returns 413 instead of resetting oversized request bodies", async () => {
    server = await ensureMcpLoopbackServer(0);
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
    server = await ensureMcpLoopbackServer(0);
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
      server = await ensureMcpLoopbackServer(0);
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

  it("keeps delayed valid MCP request bodies open when timeout config exceeds Node's timer ceiling", async () => {
    const previousTimeout = process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS;
    process.env.OPENCLAW_MCP_LOOPBACK_BODY_TIMEOUT_MS = "2147483648";
    try {
      server = await ensureMcpLoopbackServer(0);
      const runtime = getActiveMcpLoopbackRuntime();
      if (!runtime) {
        throw new Error("expected active MCP loopback runtime");
      }
      const auth = runtime.ownerToken;

      const response = await sendStalledBody({
        port: server.port,
        token: auth,
        bodyAfterDelay: mcpToolsListBody(),
        delayMs: 25,
      });

      expect(response.status).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        result: { tools: [{ name: "message" }] },
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
      mcpServers?: Record<
        string,
        { alwaysLoad?: boolean; url?: string; headers?: Record<string, string> }
      >;
    };
    expect(config.mcpServers?.openclaw?.url).toBe("http://127.0.0.1:23119/mcp");
    expect(config.mcpServers?.openclaw?.alwaysLoad).toBe(true);
    expect(config.mcpServers?.openclaw?.headers).toEqual({
      Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
      "x-openclaw-cli-capture-key": "${OPENCLAW_MCP_CLI_CAPTURE_KEY}",
    });
  });

  it("builds an attach grant config with only token-backed headers", () => {
    const config = createMcpAttachGrantServerConfig(23119) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    expect(config.mcpServers?.openclaw?.headers).toEqual({
      Authorization: "Bearer ${OPENCLAW_MCP_TOKEN}",
    });
  });

  it("opens an auth-gated SSE stream on GET (Streamable HTTP notification channel)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const token = getActiveMcpLoopbackRuntime()?.ownerToken;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    await expectInitialSseCommentFrame(res);
  });

  it("requires an active matching CLI capture on GET and DELETE", async () => {
    const { port, runtime } = await startLoopbackServerForTest();
    const grant = mintMcpLoopbackClientGrant({
      context: { sessionKey: "agent:main:transport", senderIsOwner: false },
      runtimeOwnerToken: runtime.ownerToken,
    });
    const captureKey = "capture-transport";
    activateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    });
    const send = async (method: "GET" | "DELETE", requestCaptureKey?: string) =>
      await fetch(`http://127.0.0.1:${port}/mcp`, {
        method,
        headers: {
          authorization: `Bearer ${grant.token}`,
          ...(requestCaptureKey ? { "x-openclaw-cli-capture-key": requestCaptureKey } : {}),
        },
      });

    for (const method of ["GET", "DELETE"] as const) {
      for (const requestCaptureKey of [undefined, "capture-forged"]) {
        const response = await send(method, requestCaptureKey);
        expect(response.status).toBe(401);
        await response.body?.cancel();
      }
    }

    const getResponse = await send("GET", captureKey);
    expect(getResponse.status).toBe(200);
    await expectInitialSseCommentFrame(getResponse);
    expect((await send("DELETE", captureKey)).status).toBe(200);

    deactivateMcpLoopbackClientGrantCapture({
      token: grant.token,
      runtimeOwnerToken: runtime.ownerToken,
      captureKey,
    });
    for (const method of ["GET", "DELETE"] as const) {
      const response = await send(method, captureKey);
      expect(response.status).toBe(401);
      await response.body?.cancel();
    }
  });

  it("closes active GET notification streams during loopback shutdown", async () => {
    server = await ensureMcpLoopbackServer(0);
    const token = getActiveMcpLoopbackRuntime()?.ownerToken;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "GET",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(res.status).toBe(200);
    const reader = res.body?.getReader();
    if (!reader) {
      throw new Error("expected SSE response body");
    }

    try {
      await readUntilInitialSseCommentFrame(reader);
      const closePromise = server.close();
      server = undefined;
      await expectPromiseResolvesWithin(closePromise, 500, "MCP loopback server close");
      const closed = await readStreamChunkWithTimeout(reader);
      expect(closed.done).toBe(true);
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
  });

  it("withdraws a closing runtime before drain without fencing its successor", async () => {
    const oldServer = await ensureMcpLoopbackServer(0);
    const oldRuntime = getActiveMcpLoopbackRuntime();
    if (!oldRuntime) {
      throw new Error("expected old MCP loopback runtime");
    }
    let stalledRequest: ReturnType<typeof request> | undefined;
    let resolveSocketReady: () => void = () => {};
    let rejectSocketReady: (error: Error) => void = () => {};
    const socketReady = new Promise<void>((resolve, reject) => {
      resolveSocketReady = resolve;
      rejectSocketReady = reject;
    });
    const responsePromise = new Promise<void>((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port: oldServer.port,
          path: "/mcp",
          method: "POST",
          headers: {
            authorization: `Bearer ${oldRuntime.ownerToken}`,
            connection: "close",
            "content-type": "application/json",
          },
        },
        (res) => {
          res.resume();
          res.once("end", resolve);
        },
      );
      req.once("socket", (socket) => {
        if (!socket.connecting) {
          resolveSocketReady();
          return;
        }
        socket.once("connect", resolveSocketReady);
      });
      req.once("error", (error) => {
        rejectSocketReady(error);
        reject(error);
      });
      req.write("{");
      stalledRequest = req;
    });
    let stalledRequestEnded = false;
    const finishStalledRequest = () => {
      if (stalledRequestEnded) {
        return;
      }
      stalledRequestEnded = true;
      stalledRequest?.end("}");
    };
    let oldClose: Promise<void> | undefined;
    try {
      await socketReady;
      await new Promise<void>((resolve) => {
        setImmediate(resolve);
      });

      let closeSettled = false;
      oldClose = closeMcpLoopbackServer().finally(() => {
        closeSettled = true;
      });
      expect(getActiveMcpLoopbackRuntime()).toBeUndefined();
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 20);
      });
      expect(closeSettled).toBe(false);

      const successor = await startLoopbackServerForTest();
      const successorGrant = mintMcpLoopbackClientGrant({
        context: { sessionKey: "agent:main:successor", senderIsOwner: false },
        runtimeOwnerToken: successor.runtime.ownerToken,
      });
      activateMcpLoopbackClientGrantCapture({
        token: successorGrant.token,
        runtimeOwnerToken: successor.runtime.ownerToken,
        captureKey: "capture-successor",
      });

      finishStalledRequest();
      await responsePromise;
      await oldClose;
      expect(getActiveMcpLoopbackRuntime()?.ownerToken).toBe(successor.runtime.ownerToken);
      expect(
        (
          await sendRaw({
            port: successor.port,
            token: successorGrant.token,
            headers: jsonHeaders({ "x-openclaw-cli-capture-key": "capture-successor" }),
            body: mcpToolsListBody(),
          })
        ).status,
      ).toBe(200);
    } finally {
      finishStalledRequest();
      await responsePromise.catch(() => undefined);
      await (oldClose ?? oldServer.close()).catch(() => undefined);
    }
  });

  it("rejects a GET notification channel without a bearer token (401)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "GET" });
    expect(res.status).toBe(401);
    await res.body?.cancel();
  });

  it("rejects a GET notification channel from a browser Origin (403)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const token = getActiveMcpLoopbackRuntime()?.ownerToken;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "GET",
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        origin: "https://evil.example",
      },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it("acknowledges DELETE session teardown with 200 (stateless no-op)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const token = getActiveMcpLoopbackRuntime()?.ownerToken;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "DELETE",
      headers: token ? { authorization: `Bearer ${token}` } : {},
    });
    expect(res.status).toBe(200);
  });

  it("ignores Mcp-Session-Id on DELETE because loopback teardown is stateless", async () => {
    server = await ensureMcpLoopbackServer(0);
    const token = getActiveMcpLoopbackRuntime()?.ownerToken;
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "DELETE",
      headers: token
        ? { authorization: `Bearer ${token}`, "mcp-session-id": "ignored-loopback-session" }
        : { "mcp-session-id": "ignored-loopback-session" },
    });
    expect(res.status).toBe(200);
  });

  it("rejects DELETE without a bearer token (401)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "DELETE" });
    expect(res.status).toBe(401);
  });

  it("rejects unsupported methods with 405 advertising GET, POST, DELETE", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, { method: "PUT" });
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, POST, DELETE");
  });

  it("stays stateless: POST responses advertise no Mcp-Session-Id", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await sendRaw({
      port: server.port,
      token: getActiveMcpLoopbackRuntime()?.ownerToken,
      headers: { "content-type": "application/json", "x-session-key": "agent:main:main" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });

  it("rejects a browser-Origin GET before auth (403, no bearer)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "GET",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
    await res.body?.cancel();
  });

  it("rejects a browser-Origin DELETE before auth (403, no bearer)", async () => {
    server = await ensureMcpLoopbackServer(0);
    const res = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
      method: "DELETE",
      headers: { origin: "https://evil.example" },
    });
    expect(res.status).toBe(403);
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
