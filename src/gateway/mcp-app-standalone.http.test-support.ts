import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { Readable } from "node:stream";
import { vi } from "vitest";
import {
  createStandaloneHostBrowserHarness,
  type StandaloneHostBrowserOptions,
} from "./mcp-app-standalone.browser.test-support.js";
import { makeMockHttpResponse } from "./test-http-response.js";

const mocks = vi.hoisted(() => ({
  completeRetirement: vi.fn(),
  getMcpAppViewLease: vi.fn(),
  peekSessionMcpRuntime: vi.fn(),
}));

vi.mock("../agents/agent-bundle-mcp-runtime.js", () => ({
  completeDeferredSessionMcpRuntimeRetirement: mocks.completeRetirement,
  peekSessionMcpRuntime: mocks.peekSessionMcpRuntime,
}));
vi.mock("../agents/mcp-ui-resource.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/mcp-ui-resource.js")>()),
  getMcpAppViewLease: mocks.getMcpAppViewLease,
}));

// Keep exported production bindings local: Vitest's mock hoisting rewrites static
// imports but not their export specifiers, leaving those exports undefined.
const { executeMcpAppOperation, resolveMcpAppActiveView } = await import("./mcp-app-operations.js");
const {
  createMcpAppStandaloneTicket,
  handleMcpAppStandaloneHttpRequest,
  mcpAppStandaloneTesting,
  verifyMcpAppStandaloneTicket,
} = await import("./mcp-app-standalone.js");

function issueTicket(params: Parameters<typeof createMcpAppStandaloneTicket>[0]) {
  const issued = createMcpAppStandaloneTicket(params);
  if (!issued) {
    throw new Error("ticket capacity unexpectedly exhausted");
  }
  return issued;
}

const nowMs = 1_800_000_000_000;
const secret = Buffer.alloc(32, 7);
const releaseRuntimeLease = vi.fn();
const runtime = {
  sessionId: "runtime-session",
  mcpAppsEnabled: true,
  markUsed: vi.fn(),
  acquireLease: vi.fn(() => releaseRuntimeLease),
  getCatalog: vi.fn(async () => ({
    tools: [
      { serverName: "demo", toolName: "shared" },
      { serverName: "demo", toolName: "app-only", uiVisibility: ["app"] },
      { serverName: "demo", toolName: "model-only", uiVisibility: ["model"] },
      { serverName: "other", toolName: "cross-only", uiVisibility: ["app"] },
    ],
  })),
  callTool: vi.fn(async (serverName: string, toolName: string) => ({
    content: [{ type: "text", text: `${serverName}:${toolName}` }],
  })),
  listTools: vi.fn(async () => ({
    tools: [
      { name: "shared", inputSchema: { type: "object" } },
      { name: "app-only", inputSchema: { type: "object" }, _meta: { ui: { visibility: ["app"] } } },
      {
        name: "model-only",
        inputSchema: { type: "object" },
        _meta: { ui: { visibility: ["model"] } },
      },
    ],
  })),
  listResources: vi.fn(async () => [{ uri: "ui://demo/state", name: "state" }]),
  listResourceTemplates: vi.fn(async () => ({ resourceTemplates: [] })),
  readResource: vi.fn(async (serverName: string, uri: string) => ({
    contents: [{ uri, text: `${serverName}:${uri}` }],
  })),
};
const view = {
  viewId: "mcp-app-view",
  agentId: "main",
  sessionId: runtime.sessionId,
  runtime,
  serverName: "demo",
  toolName: "weather",
  uiResourceUri: "ui://demo/app",
  html: "<!doctype html><p>private fixture</p>",
  csp: { connectDomains: ["https://api.example.com"] },
  allowedAppToolNames: new Set(["shared", "app-only"]),
  authorizeAppInteraction: undefined as (() => boolean | Promise<boolean>) | undefined,
  toolInput: { city: "Paris" },
  toolResult: { content: [{ type: "text", text: "sunny" }] },
  expiresAtMs: nowMs + 10 * 60_000,
  requestWindowStartedAtMs: nowMs,
  requestCount: 0,
  toolCallCount: 0,
  activeRequests: 0,
  byteSize: 100,
};

async function request(params: {
  url: string;
  method?: "GET" | "HEAD" | "POST";
  authorization?: string;
  clock?: () => number;
  now?: number;
  body?: unknown;
  socket?: EventEmitter;
}) {
  const { res, end, setHeader } = makeMockHttpResponse();
  Object.assign(res, { socket: null });
  const serialized = params.body === undefined ? undefined : JSON.stringify(params.body);
  const req = Object.assign(Readable.from(serialized === undefined ? [] : [serialized]), {
    url: params.url,
    method: params.method ?? "GET",
    headers: {
      ...(params.authorization ? { authorization: params.authorization } : {}),
      ...(serialized ? { "content-type": "application/json" } : {}),
    },
    socket: params.socket ?? new EventEmitter(),
  }) as IncomingMessage;
  const handled = await handleMcpAppStandaloneHttpRequest(req, res, {
    gatewayPort: 18_789,
    sandboxPort: 18_790,
    now: params.clock,
    nowMs: params.now ?? nowMs,
    ticketSecret: secret,
  });
  return { handled, res, end, setHeader };
}

async function createSerializedHost(options: StandaloneHostBrowserOptions = {}) {
  const shell = await request({ url: "/__openclaw__/mcp-app" });
  const source = /<script>([\s\S]+)<\/script>/u.exec(String(shell.end.mock.calls[0]?.[0]))?.[1];
  if (!source) {
    throw new Error("standalone shell script missing");
  }
  const ticket = issueTicket({ sessionKey: "agent:main:main", view, nowMs, secret }).ticket;
  const loaded = await request({
    url: "/__openclaw__/mcp-app/view",
    authorization: `MCP-App ${ticket}`,
  });
  const payload: unknown = JSON.parse(String(loaded.end.mock.calls[0]?.[0]));
  return await createStandaloneHostBrowserHarness({ source, ticket, payload, ...options });
}

export function resetStandaloneMcpAppTestState() {
  mcpAppStandaloneTesting.clearTickets();
  vi.clearAllMocks();
  mocks.completeRetirement.mockResolvedValue(undefined);
  Object.assign(view, {
    allowedAppToolNames: new Set(["shared", "app-only"]),
    authorizeAppInteraction: undefined,
    readOnly: undefined,
    requestWindowStartedAtMs: nowMs,
    requestCount: 0,
    toolCallCount: 0,
    activeRequests: 0,
  });
  mocks.peekSessionMcpRuntime.mockReturnValue(runtime);
  mocks.getMcpAppViewLease.mockReturnValue(view);
}

export {
  createMcpAppStandaloneTicket,
  createSerializedHost,
  executeMcpAppOperation,
  handleMcpAppStandaloneHttpRequest,
  issueTicket,
  mcpAppStandaloneTesting,
  mocks,
  nowMs,
  releaseRuntimeLease,
  request,
  resolveMcpAppActiveView,
  runtime,
  secret,
  view,
  verifyMcpAppStandaloneTicket,
};
