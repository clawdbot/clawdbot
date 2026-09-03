/** Tests session-scoped MCP runtime catalog, transport, validation, and lifecycle behavior. */
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { materializeRequesterScopedMcpToolsForHarnessRun } from "openclaw/plugin-sdk/agent-harness-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import {
  cleanupTempDirs,
  makeTempDir,
  useAutoCleanupTempDirTracker,
} from "../../test/helpers/temp-dir.js";
import { createCombinedSessionMcpRuntime } from "./agent-bundle-mcp-combined.js";
import { completeDeferredSessionMcpRuntimeRetirement } from "./agent-bundle-mcp-manager-api.js";
import { runWithSessionMcpRequestSignal } from "./agent-bundle-mcp-request-context.js";
import { SESSION_MCP_RUNTIME_MANAGER_KEY } from "./agent-bundle-mcp-runtime-shared.js";
import {
  createBundleMcpJsonSchemaValidator,
  createSessionMcpRuntime,
  testing,
} from "./agent-bundle-mcp-runtime.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
  peekSessionMcpRuntime,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";
import { updateMcpAppModelContext } from "./mcp-app-model-context.js";
import { fetchMcpAppView, getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";

vi.mock("./embedded-agent-mcp.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedded-agent-mcp.js")>();
  return {
    loadEmbeddedAgentMcpConfig: (
      params: Parameters<typeof actual.loadEmbeddedAgentMcpConfig>[0],
    ) => {
      if (params.cfg?.plugins?.entries?.["agent-bundle-probe"]?.enabled === true) {
        return actual.loadEmbeddedAgentMcpConfig(params);
      }
      return {
        diagnostics: [],
        prepareDataDirsByServer: {},
        mcpServers: Object.fromEntries(
          Object.entries(params.cfg?.mcp?.servers ?? {}).filter(([name]) => {
            const overrides = params.toolOverrides?.mcpServers;
            return !(overrides && Object.hasOwn(overrides, name) && overrides[name] === false);
          }),
        ),
      };
    },
  };
});

vi.mock("./mcp-auth-profile.js", () => ({
  resolveMcpAuthProfileId: () => undefined,
  withMcpAuthProfileBearer: () => {
    throw new Error("Unexpected auth-profile transport in MCP runtime test");
  },
}));

const tempDirs: string[] = [];
const tempDirTracker = useAutoCleanupTempDirTracker(afterEach);

type RuntimeFactoryOptions = NonNullable<
  Parameters<typeof testing.createSessionMcpRuntimeManager>[0]
>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;
type RuntimeParams = Parameters<typeof getOrCreateSessionMcpRuntime>[0];
type ConfiguredMcpServer = NonNullable<
  NonNullable<NonNullable<RuntimeParams["cfg"]>["mcp"]>["servers"]
>[string];
const LIST_TOOLS_SERVER_LOG_TIMEOUT_MS = 2_000;
const LIST_TOOLS_TEST_DEADLINE_MS = 4_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

async function startRequesterScopedMcpProofServer(): Promise<{
  url: string;
  session: { current?: string; closed?: string };
  close: () => Promise<void>;
}> {
  const server = new McpServer({ name: "openclaw-requester-proof", version: "1.0.0" });
  const session: { current?: string; closed?: string } = {};
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: randomUUID,
    onsessioninitialized(nextSessionId) {
      session.current = nextSessionId;
    },
    onsessionclosed(nextSessionId) {
      session.closed = nextSessionId;
    },
  });
  server.registerTool(
    "requester_probe",
    { description: "Return the live requester-scoped MCP transport identity" },
    async () => ({ content: [{ type: "text", text: session.current ?? "missing-session" }] }),
  );
  await server.connect(transport);
  const httpServer = http.createServer((request, response) => {
    if (request.url !== "/mcp" || request.headers.authorization !== "Bearer proof-token") {
      response.writeHead(404).end();
      return;
    }
    void transport.handleRequest(request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", resolve);
  });
  const address = httpServer.address();
  if (!address || typeof address === "string") {
    throw new Error("requester-scoped MCP proof server did not bind a loopback port");
  }
  return {
    url: `http://127.0.0.1:${address.port}/mcp`,
    session,
    close: async () => {
      await server.close();
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

function readMcpText(
  result: { content: ReadonlyArray<{ type: string; text?: string }> },
  label: string,
): string {
  const content = expectDefined(result.content[0], label);
  if (content.type !== "text" || typeof content.text !== "string") {
    throw new Error(`${label} did not contain text`);
  }
  return content.text;
}

async function writeListToolsMcpServer(params: {
  filePath: string;
  logPath: string;
  delayMs?: number;
  listToolsReleasePath?: string;
  initializeDelayMs?: number;
  hang?: boolean;
  inputSchema?: unknown;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    outputSchema?: unknown;
    execution?: { taskSupport?: "forbidden" | "optional" | "required" };
    _meta?: Record<string, unknown>;
  }>;
  toolsByList?: Array<
    Array<{
      name: string;
      description?: string;
      inputSchema?: unknown;
      outputSchema?: unknown;
      execution?: { taskSupport?: "forbidden" | "optional" | "required" };
      _meta?: Record<string, unknown>;
    }>
  >;
  capabilities?: Record<string, unknown>;
  databasePath?: string;
  pidPath?: string;
  hangToolCallsUntilRestartMarkerPath?: string;
  notifyListChangedOnInitialized?: boolean;
  notifyListChangedAfterFirstList?: boolean;
  notifyListChangedReleasePath?: string;
  notifyListChangedBeforeEveryListResponse?: boolean;
  exitOnListCall?: number;
  listToolsMethodNotFound?: boolean;
  listToolsJsonRpcErrorMessage?: string;
  toolPageCursors?: Array<string | null>;
  callToolIsError?: boolean;
  callToolJsonRpcError?: boolean;
  callToolJsonRpcErrorCode?: number;
  callToolResult?: CallToolResult;
  callToolDelayMs?: number;
  callToolReleasePath?: string;
  notifyListChangedOnToolCall?: boolean;
  resourcePageDelayMs?: number;
  resourcePageCount?: number;
  resourcePageCursors?: Array<string | null>;
  resourceListJsonRpcError?: boolean;
  resourceReadJsonRpcError?: boolean;
  resourceReadResult?: ReadResourceResult;
  promptPageDelayMs?: number;
  promptPageCursors?: Array<string | null>;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(params.logPath)};
const delayMs = ${params.delayMs ?? 0};
const listToolsReleasePath = ${JSON.stringify(params.listToolsReleasePath)};
const initializeDelayMs = ${params.initializeDelayMs ?? 0};
const hang = ${params.hang === true};
const capabilities = ${JSON.stringify(params.capabilities ?? { tools: {} })};
const databasePath = ${JSON.stringify(params.databasePath)};
const pidPath = ${JSON.stringify(params.pidPath)};
const hangToolCallsUntilRestartMarkerPath = ${JSON.stringify(
      params.hangToolCallsUntilRestartMarkerPath,
    )};
const notifyListChangedOnInitialized = ${params.notifyListChangedOnInitialized === true};
const notifyListChangedAfterFirstList = ${params.notifyListChangedAfterFirstList === true};
const notifyListChangedReleasePath = ${JSON.stringify(params.notifyListChangedReleasePath)};
const notifyListChangedBeforeEveryListResponse = ${params.notifyListChangedBeforeEveryListResponse === true};
const exitOnListCall = ${params.exitOnListCall ?? 0};
const listToolsMethodNotFound = ${params.listToolsMethodNotFound === true};
const listToolsJsonRpcErrorMessage = ${JSON.stringify(params.listToolsJsonRpcErrorMessage)};
const toolPageCursors = ${JSON.stringify(params.toolPageCursors)};
const tools = ${JSON.stringify(
      params.tools ?? [
        {
          name: "slow_tool",
          description: "Returned after a slow catalog response.",
          inputSchema: params.inputSchema ?? { type: "object", properties: {} },
        },
      ],
    )};
const toolsByList = ${JSON.stringify(params.toolsByList)};
const callToolIsError = ${params.callToolIsError === true};
const callToolJsonRpcError = ${params.callToolJsonRpcError === true};
const callToolJsonRpcErrorCode = ${params.callToolJsonRpcErrorCode ?? -32000};
const callToolResult = ${JSON.stringify(params.callToolResult)};
const callToolDelayMs = ${params.callToolDelayMs ?? 0};
const callToolReleasePath = ${JSON.stringify(params.callToolReleasePath)};
const notifyListChangedOnToolCall = ${params.notifyListChangedOnToolCall === true};
const resourcePageDelayMs = ${params.resourcePageDelayMs ?? 0};
const resourcePageCount = ${params.resourcePageCount ?? 1};
const resourcePageCursors = ${JSON.stringify(params.resourcePageCursors)};
const resourceListJsonRpcError = ${params.resourceListJsonRpcError === true};
const resourceReadJsonRpcError = ${params.resourceReadJsonRpcError === true};
const resourceReadResult = ${JSON.stringify(params.resourceReadResult)};
const promptPageDelayMs = ${params.promptPageDelayMs ?? 0};
const promptPageCursors = ${JSON.stringify(params.promptPageCursors)};

async function waitForPath(filePath) {
  while (filePath) {
    const exists = await fs.access(filePath).then(() => true).catch(() => false);
    if (exists) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

let buffer = "";
let listCount = 0;
let resourceListCount = 0;
let promptListCount = 0;
let pendingTimer;
let keepAlive;
let database;
let hangToolCallsUntilRestart = false;
if (databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS lock_probe (value TEXT); BEGIN IMMEDIATE; INSERT INTO lock_probe VALUES ('held')");
}
if (pidPath) {
  await fs.writeFile(pidPath, String(process.pid), "utf8");
}
if (hangToolCallsUntilRestartMarkerPath) {
  hangToolCallsUntilRestart = !(await fs
    .access(hangToolCallsUntilRestartMarkerPath)
    .then(() => true)
    .catch(() => false));
  if (hangToolCallsUntilRestart) {
    await fs.writeFile(hangToolCallsUntilRestartMarkerPath, String(process.pid), "utf8");
  }
}
function log(line) {
  appendFileSync(logPath, line + "\\n", "utf8");
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities,
        serverInfo: { name: "test-list-tools", version: "1.0.0" },
      },
    };
    if (initializeDelayMs > 0) {
      setTimeout(() => send(response), initializeDelayMs);
    } else {
      send(response);
    }
    return;
  }
  if (message.method === "notifications/initialized") {
    if (notifyListChangedOnInitialized) {
      log("notify tools/list_changed");
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    return;
  }
  if (message.method === "tools/list") {
    listCount += 1;
    log("tools/list cursor " + JSON.stringify(message.params?.cursor));
    if (listCount === exitOnListCall) {
      log("exit tools/list " + listCount);
      process.exit(1);
    }
    if (listToolsMethodNotFound) {
      log("reject tools/list method not found");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method not found" },
      });
      return;
    }
    if (listToolsJsonRpcErrorMessage) {
      log("reject tools/list with configured error");
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: listToolsJsonRpcErrorMessage },
      });
      return;
    }
    if (hang) {
      log("hang tools/list");
      keepAlive = setInterval(() => {}, 1000);
      return;
    }
    const currentListCount = listCount;
    const toolPageCursor = toolPageCursors?.[currentListCount - 1];
    log("delay tools/list " + delayMs);
    const sendListResponse = () => {
      if (notifyListChangedBeforeEveryListResponse) {
        log("notify tools/list_changed before response");
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: toolsByList
            ? toolsByList[Math.min(currentListCount - 1, toolsByList.length - 1)]
            : toolPageCursors
              ? tools.map((tool) => ({ ...tool, name: tool.name + "-" + currentListCount }))
              : tools,
          ...(toolPageCursor !== undefined && toolPageCursor !== null
            ? { nextCursor: toolPageCursor }
            : {}),
        },
      });
      if (notifyListChangedAfterFirstList && currentListCount === 1) {
        void (async () => {
          await waitForPath(notifyListChangedReleasePath);
          log("notify tools/list_changed");
          send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        })();
      }
    };
    void (async () => {
      await waitForPath(listToolsReleasePath);
      pendingTimer = setTimeout(sendListResponse, delayMs);
    })();
  }
  if (message.method === "tools/call") {
    if (hangToolCallsUntilRestart) {
      log("hang tools/call");
      keepAlive = setInterval(() => {}, 1000);
      return;
    }
    if (callToolJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: callToolJsonRpcErrorCode, message: "tool request failed" },
      });
      return;
    }
    if (notifyListChangedOnToolCall) {
      log("notify tools/list_changed during tools/call");
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    }
    void (async () => {
      await waitForPath(callToolReleasePath);
      log("delay tools/call " + callToolDelayMs);
      pendingTimer = setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            isError: callToolIsError,
            ...(callToolResult ?? {
              content: [{ type: "text", text: callToolIsError ? "tool failed" : "tool ok" }],
            }),
          },
        });
      }, callToolDelayMs);
    })();
  }
  if (message.method === "resources/list") {
    resourceListCount += 1;
    log("resources/list cursor " + JSON.stringify(message.params?.cursor));
    if (resourceListJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "resource request failed" },
      });
      return;
    }
    setTimeout(() => {
      const resourcePageCursor = resourcePageCursors?.[resourceListCount - 1];
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          resources: resourcePageCursors
            ? [{ uri: "memo://page-" + resourceListCount, name: "page-" + resourceListCount }]
            : [],
          ...(resourcePageCursor !== undefined && resourcePageCursor !== null
            ? { nextCursor: resourcePageCursor }
            : resourceListCount < resourcePageCount
              ? { nextCursor: String(resourceListCount) }
              : {}),
        },
      });
    }, resourcePageDelayMs);
    return;
  }
  if (message.method === "prompts/list") {
    promptListCount += 1;
    log("prompts/list cursor " + JSON.stringify(message.params?.cursor));
    setTimeout(() => {
      const promptPageCursor = promptPageCursors?.[promptListCount - 1];
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          prompts: [{ name: "prompt-" + promptListCount }],
          ...(promptPageCursor !== undefined && promptPageCursor !== null
            ? { nextCursor: promptPageCursor }
            : {}),
        },
      });
    }, promptPageDelayMs);
    return;
  }
  if (message.method === "resources/read") {
    if (resourceReadJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "resource read failed" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: resourceReadResult ?? { contents: [{ uri: message.params?.uri, text: "resource ok" }] },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  if (pendingTimer) {
    clearTimeout(pendingTimer);
  }
  if (keepAlive) {
    clearInterval(keepAlive);
  }
  try {
    database?.exec("ROLLBACK");
  } catch {}
  database?.close();
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
  );
}

async function waitForFileText(
  filePath: string,
  expectedText: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastText = "";
  while (Date.now() < deadline) {
    try {
      lastText = await fs.readFile(filePath, "utf8");
      if (lastText.includes(expectedText)) {
        return;
      }
    } catch {
      // The server may not have written the log file yet.
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(
    `Timed out waiting for ${expectedText} in ${filePath}; saw ${JSON.stringify(lastText)}`,
  );
}

async function waitForPredicate(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForFileTextCount(
  filePath: string,
  expectedText: string,
  expectedCount: number,
  timeoutMs: number,
): Promise<void> {
  await waitForPredicate(
    async () => {
      const text = await fs.readFile(filePath, "utf8").catch(() => "");
      return text.split(expectedText).length - 1 >= expectedCount;
    },
    `${expectedCount} occurrences of ${expectedText} in ${filePath}`,
    timeoutMs,
  );
}

/** Waits for a replacement child to register a pid different from the one that died. */
async function waitForChangedPid(
  pidPath: string,
  previousPid: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const raw = await fs.readFile(pidPath, "utf8").catch(() => "");
    const pid = Number.parseInt(raw.trim(), 10);
    if (Number.isFinite(pid) && pid !== previousPid) {
      return pid;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for a replacement child pid (still ${previousPid})`);
}

function makeRuntime(
  tools: Array<{ toolName: string; description: string }>,
  serverName = "bundleProbe",
): SessionMcpRuntime {
  const createdAt = Date.now();
  let lastUsedAt = createdAt;
  return {
    sessionId: "session-colliding-tools",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt,
    get lastUsedAt() {
      return lastUsedAt;
    },
    markUsed: () => {
      lastUsedAt = Date.now();
    },
    peekCatalog: () => null,
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
        },
      },
      tools: tools.map((tool) => ({
        serverName,
        safeServerName: serverName,
        toolName: tool.toolName,
        description: tool.description,
        inputSchema: {
          type: "object",
          properties: {
            toolName: { type: "string", const: tool.toolName },
          },
        },
        fallbackDescription: tool.description,
      })),
    }),
    callTool: async (_serverName, toolName) => ({
      content: [{ type: "text", text: toolName }],
      isError: false,
    }),
    dispose: async () => {},
  };
}

function makeManagedRuntime(
  params: Parameters<RuntimeFactory>[0],
  tools = [{ toolName: "probe", description: "probe" }],
  serverName?: string,
): SessionMcpRuntime {
  return {
    ...makeRuntime(tools, serverName),
    sessionId: params.sessionId,
    sessionKey: params.sessionKey,
    workspaceDir: params.workspaceDir,
    configFingerprint: params.configFingerprint ?? "fingerprint",
    requesterScope: params.requesterScope,
  };
}

async function makeStdioRuntime(
  sessionId: string,
  serverName: string,
  serverPath: string,
  options: {
    workspaceDir?: string;
    server?: Omit<ConfiguredMcpServer, "command" | "args">;
    toolOverrides?: RuntimeParams["toolOverrides"];
  } = {},
): Promise<SessionMcpRuntime> {
  return await getOrCreateSessionMcpRuntime({
    sessionId,
    sessionKey: `agent:test:${sessionId}`,
    workspaceDir: options.workspaceDir ?? "/workspace",
    cfg: {
      mcp: {
        servers: {
          [serverName]: {
            command: process.execPath,
            args: [serverPath],
            ...options.server,
          },
        },
      },
    },
    ...(options.toolOverrides ? { toolOverrides: options.toolOverrides } : {}),
  });
}

function makeRequesterParams(
  sessionId: string,
  cfg: RuntimeParams["cfg"],
  requesterSenderId: string,
  overrides: Partial<RuntimeParams> = {},
): RuntimeParams {
  return {
    sessionId,
    workspaceDir: "/workspace",
    cfg,
    requesterSenderId,
    messageChannel: "telegram",
    ...overrides,
  };
}

afterEach(async () => {
  cleanupTempDirs(tempDirs);
  await testing.resetSessionMcpRuntimeManager();
});

describe("session MCP runtime", () => {
  it("advertises the stable MCP Apps client extension only when enabled", () => {
    expect(testing.buildMcpClientCapabilities(false)).toEqual({});
    expect(testing.buildMcpClientCapabilities(true)).toEqual({
      extensions: {
        "io.modelcontextprotocol/ui": {
          mimeTypes: ["text/html;profile=mcp-app"],
        },
      },
    });
  });

  it("catalogs canonical and deprecated MCP App tool metadata", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-app-metadata-");
    const serverPath = path.join(tempDir, "app-metadata.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        {
          name: "canonical",
          inputSchema: { type: "object" },
          _meta: { ui: { resourceUri: "ui://demo/app", visibility: ["app"] } },
        },
        {
          name: "deprecated",
          inputSchema: { type: "object" },
          _meta: { "ui/resourceUri": "ui://demo/legacy" },
        },
        {
          name: "hidden",
          inputSchema: { type: "object" },
          _meta: { ui: { visibility: [] } },
        },
      ],
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-app-metadata",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          apps: { enabled: true },
          servers: {
            demo: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });
    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            toolName: "canonical",
            uiResourceUri: "ui://demo/app",
            uiVisibility: ["app"],
          }),
          expect.objectContaining({
            toolName: "deprecated",
            uiResourceUri: "ui://demo/legacy",
          }),
          expect.objectContaining({ toolName: "hidden", uiVisibility: [] }),
        ]),
      );
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("accepts draft-2020-12 tool output schemas from external MCP catalogs", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator<{
      format: string;
      metadata: { format: string };
      nullable: { x?: string } | null;
      url: string;
    }>({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        format: { type: "string", enum: ["png"] },
        metadata: { const: { format: "png" } },
        nullable: {
          type: ["object", "null"],
          properties: { x: { type: "string" } },
          additionalProperties: false,
        },
        url: { type: "string", format: "uri" },
      },
      required: ["format", "metadata", "nullable", "url"],
      additionalProperties: false,
    });

    expect(
      validator({
        format: "png",
        metadata: { format: "png" },
        nullable: null,
        url: "not a uri",
      }),
    ).toEqual({
      valid: true,
      data: {
        format: "png",
        metadata: { format: "png" },
        nullable: null,
        url: "not a uri",
      },
      errorMessage: undefined,
    });
    expect(validator({ url: 42 }).valid).toBe(false);

    const dependencyValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      dependencies: {
        url: {
          properties: {
            url: {
              type: "string",
              format: "uri",
            },
          },
          required: ["url"],
        },
      },
    });
    expect(dependencyValidator({ url: "not a uri" }).valid).toBe(true);

    const mapValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      additionalProperties: {
        type: "string",
      },
    });
    expect(mapValidator({ foo: "bar" }).valid).toBe(true);
    expect(mapValidator({ foo: 42 }).valid).toBe(false);
  });

  it("rejects invalid draft-2020-12 tool output schemas from external MCP catalogs", () => {
    for (const schema of [
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "sting",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        required: "url",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
        minLength: "1",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        allOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        anyOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        oneOf: [],
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $ref: "#/$defs/Missing",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $dynamicRef: 123,
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $dynamicRef: "#/$defs/Missing",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "string",
        nullable: "yes",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        nullable: true,
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        $defs: {
          Other: {
            $id: "other",
            $anchor: "value",
            type: "string",
          },
        },
        $ref: "#value",
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        dependencies: {
          mode: 123,
        },
      },
      {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        dependencies: {
          mode: [1],
        },
      },
    ] as const) {
      expect(() => createBundleMcpJsonSchemaValidator().getValidator(schema as never)).toThrow(
        "Invalid MCP draft-2020-12 JSON Schema",
      );
    }
  });

  it("accepts draft-2020-12 local refs to boolean schemas and anchors", () => {
    const neverValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Never: false,
      },
      $ref: "#/$defs/Never",
    });
    expect(neverValidator("anything").valid).toBe(false);

    const anchorValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Value: {
          $anchor: "value",
          type: "string",
        },
      },
      $ref: "#value",
    });
    expect(anchorValidator("ok").valid).toBe(true);
    expect(anchorValidator(1).valid).toBe(false);

    const nestedAnchorValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Other: {
          $id: "other",
          $defs: {
            Value: {
              $anchor: "value",
              type: "string",
            },
          },
          $ref: "#value",
        },
      },
      $ref: "#/$defs/Other",
    });
    expect(nestedAnchorValidator("ok").valid).toBe(true);
    expect(nestedAnchorValidator(1).valid).toBe(false);

    const absoluteRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "https://example.com/schema",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "https://example.com/schema#/$defs/Value",
    });
    expect(absoluteRefValidator("ok").valid).toBe(true);
    expect(absoluteRefValidator(1).valid).toBe(false);

    const emptyIdRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: "",
      $defs: {
        Value: {
          type: "string",
        },
      },
      $ref: "#/$defs/Value",
    });
    expect(emptyIdRefValidator("ok").valid).toBe(true);
    expect(emptyIdRefValidator(1).valid).toBe(false);

    const dynamicRefValidator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: {
        Value: {
          $dynamicAnchor: "value",
          type: "string",
        },
      },
      $dynamicRef: "#value",
    });
    expect(dynamicRefValidator("ok").valid).toBe(true);
    expect(dynamicRefValidator(1).valid).toBe(false);
  });

  it("attributes draft-2020-12 compiler failures to the MCP schema", () => {
    let thrown: unknown;
    try {
      createBundleMcpJsonSchemaValidator().getValidator({
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        properties: {
          value: { type: "string", pattern: "[" },
        },
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      message: expect.stringContaining(
        "Invalid MCP draft-2020-12 JSON Schema: Invalid regular expression",
      ),
      cause: expect.any(Error),
    });
  });

  it("compiles draft-2020-12 patterns with redundant unicode-invalid escapes", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      properties: {
        url: { type: "string", pattern: "^https\\:\\/\\/" },
      },
      required: ["url"],
      additionalProperties: false,
    });

    expect(validator({ url: "https://example.com/path" }).valid).toBe(true);
    expect(validator({ url: "http://example.com" }).valid).toBe(false);
  });

  it("accepts draft-2020-12 local refs into schema arrays", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      anyOf: [{ type: "string" }],
      $ref: "#/anyOf/0",
    });
    expect(validator("ok").valid).toBe(true);
    expect(validator(1).valid).toBe(false);
  });

  it("accepts draft-2020-12 local refs to anchors inside dependency schemas", () => {
    const validator = createBundleMcpJsonSchemaValidator().getValidator({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      type: "object",
      dependencies: {
        a: {
          $defs: {
            Target: {
              $anchor: "target",
              type: "object",
            },
          },
        },
        b: {
          properties: {
            b: {
              $ref: "#target",
            },
          },
          required: ["b"],
        },
      },
    });
    expect(validator({ a: {}, b: {} }).valid).toBe(true);
    expect(validator({ a: {}, b: 1 }).valid).toBe(false);
  });

  it("enforces output schemas under the canonical trimmed tool name", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-canonical-schema-");
    const serverPath = path.join(tempDir, "server.mjs");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath: path.join(tempDir, "server.log"),
      tools: [
        {
          name: " spaced ",
          inputSchema: { type: "object" },
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
          },
        },
      ],
      callToolResult: { content: [], structuredContent: { count: "invalid" } },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-canonical-schema",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } } },
    });

    try {
      expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual(["spaced"]);
      await expect(runtime.callTool("docs", "spaced", {})).rejects.toThrow(
        "does not match the tool's output schema",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("validates an in-flight result against its dispatch-time output schema", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-dispatch-schema-");
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const releasePath = path.join(tempDir, "release-call");
    const schema = (revision: string) => ({
      type: "object",
      properties: { revision: { const: revision } },
      required: ["revision"],
    });
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      toolsByList: [
        [{ name: "versioned", inputSchema: { type: "object" }, outputSchema: schema("a") }],
        [{ name: "versioned", inputSchema: { type: "object" }, outputSchema: schema("b") }],
      ],
      notifyListChangedOnToolCall: true,
      capabilities: { tools: { listChanged: true } },
      callToolReleasePath: releasePath,
      callToolResult: { content: [], structuredContent: { revision: "a" } },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-dispatch-schema",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: { docs: { command: process.execPath, args: [serverPath] } } } },
    });

    try {
      expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual([
        "versioned",
      ]);
      const calling = runtime.callTool("docs", "versioned", {}).then(
        (value) => ({ value, error: undefined }),
        (error: unknown) => ({ value: undefined, error }),
      );
      await waitForFileText(
        logPath,
        "notify tools/list_changed during tools/call",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      await waitForPredicate(
        () => runtime.peekCatalog() === null,
        "dispatch-time catalog invalidation",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      expect((await runtime.getCatalog()).tools.map((entry) => entry.toolName)).toEqual([
        "versioned",
      ]);
      await fs.writeFile(releasePath, "release", "utf8");
      const outcome = await calling;
      expect(outcome.error).toBeUndefined();
      expect(outcome.value).toMatchObject({ structuredContent: { revision: "a" } });
    } finally {
      await fs.writeFile(releasePath, "release", "utf8").catch(() => {});
      await runtime.dispose();
    }
  });

  it("keeps colliding sanitized tool definitions stable across catalog order changes", async () => {
    const catalogA = [
      { toolName: "alpha?", description: "question" },
      { toolName: "alpha!", description: "bang" },
    ];
    const catalogB = catalogA.toReversed();

    const materializedA = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogA, "collision"),
    });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: makeRuntime(catalogB, "collision"),
    });

    const summarizeTools = (runtime: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>>) =>
      runtime.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      }));

    expect(summarizeTools(materializedA)).toEqual(summarizeTools(materializedB));
    expect(summarizeTools(materializedA)).toEqual([
      {
        name: "collision__alpha-",
        description: "bang",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha!" },
          },
        },
      },
      {
        name: "collision__alpha--2",
        description: "question",
        parameters: {
          type: "object",
          properties: {
            toolName: { type: "string", const: "alpha?" },
          },
        },
      },
    ]);
  });

  it("holds a runtime lease until the materialized tool runtime is disposed", async () => {
    let activeLeases = 0;
    const runtime = {
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      acquireLease: () => {
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
        };
      },
    };

    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(activeLeases).toBe(1);

    await materialized.dispose();
    await materialized.dispose();

    expect(activeLeases).toBe(0);
  });

  it("releases a runtime lease when catalog materialization fails", async () => {
    let activeLeases = 0;
    const runtime = {
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      acquireLease: () => {
        activeLeases += 1;
        return () => {
          activeLeases -= 1;
        };
      },
      getCatalog: async () => {
        throw new Error("catalog failed");
      },
    };

    await expect(materializeBundleMcpToolsForRun({ runtime })).rejects.toThrow("catalog failed");
    expect(activeLeases).toBe(0);
  });

  it("uses the internal catalog timeout for MCP tools/list after connecting", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-slow-listtools-"));
    const serverPath = path.join(tempDir, "slow-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(300);
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      delayMs: 100,
    });

    const runtime = await makeStdioRuntime(
      "session-slow-listtools-server-timeout",
      "slowListTools",
      serverPath,
      { server: { connectionTimeoutMs: 1_000 } },
    );

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
      expect(catalog.servers.slowListTools).toMatchObject({
        serverName: "slowListTools",
        toolCount: 1,
      });
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 100");
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("uses the configured request timeout instead of the connection timeout for delayed MCP tools/list", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-configured-listtools-");
    const serverPath = path.join(tempDir, "configured-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      delayMs: 2_000,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-configured-listtools-timeout",
      sessionKey: "agent:test:session-configured-listtools-timeout",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredListTools: {
              command: process.execPath,
              args: [serverPath],
              connectionTimeoutMs: 1_000,
              requestTimeoutMs: 4_000,
            },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 2000");
    } finally {
      await runtime.dispose();
    }
  });

  it("rejects delayed MCP tools/call responses that exceed the configured request timeout", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-call-timeout-");
    const serverPath = path.join(tempDir, "slow-tool-call.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolDelayMs: 1_500,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-tool-call-timeout",
      sessionKey: "agent:test:session-tool-call-timeout",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            slowToolCall: {
              command: process.execPath,
              args: [serverPath],
              requestTimeoutMs: 250,
            },
          },
        },
      },
    });

    try {
      await runtime.getCatalog();
      await expect(runtime.callTool("slowToolCall", "slow_tool", {})).rejects.toThrow(/timed out/i);
      await waitForFileText(logPath, "delay tools/call 1500", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
    }
  });

  it("times out default-config hung bundle MCP tools/list using the internal catalog timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-timeout-"));
    const serverPath = path.join(tempDir, "hanging-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(50);
    await writeListToolsMcpServer({ filePath: serverPath, logPath, hang: true });

    const runtime = await makeStdioRuntime(
      "session-listtools-server-timeout",
      "hangingListTools",
      serverPath,
    );
    const catalogResult = runtime.getCatalog().then(
      (catalog) => ({ status: "resolved" as const, catalog }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );

    try {
      await waitForFileText(logPath, "recv tools/list", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      const result = await withTestTimeout(
        catalogResult,
        LIST_TOOLS_TEST_DEADLINE_MS,
        "timed out waiting for bundle MCP catalog timeout",
      );

      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools).toEqual([]);
        expect(result.catalog.servers).toEqual({});
      }
    } finally {
      await runtime.dispose();
      await withTestTimeout(
        catalogResult,
        1_000,
        "timed out waiting for bundle MCP catalog cleanup",
      );
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("records diagnostics when tools/list returns an invalid tool schema", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-invalid-schema-"));
    const serverPath = path.join(tempDir, "invalid-schema.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      inputSchema: { type: "array", items: { type: "number" } },
    });

    const runtime = await makeStdioRuntime("session-invalid-schema", "fuzzplugin", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.servers).toEqual({});
      expect(catalog.tools).toEqual([]);
      expect(catalog.diagnostics?.[0]?.serverName).toBe("fuzzplugin");
      expect(catalog.diagnostics?.[0]?.message).toContain("Invalid input: expected");
      expect(catalog.diagnostics?.[0]?.message).toContain("object");
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("redacts credentials from MCP catalog diagnostics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-diagnostic-redaction-"));
    const serverPath = path.join(tempDir, "diagnostic-redaction.mjs");
    const logPath = path.join(tempDir, "server.log");
    const secret = "test-diagnostic-token";
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      listToolsJsonRpcErrorMessage: `Authorization: Bearer ${secret}`,
    });

    const runtime = await makeStdioRuntime(
      "session-diagnostic-redaction",
      "diagnostic",
      serverPath,
    );

    try {
      const catalog = await runtime.getCatalog();
      const diagnostic = catalog.diagnostics?.[0];
      expect(diagnostic?.serverName).toBe("diagnostic");
      expect(diagnostic?.message).toContain("Authorization: Bearer ");
      expect(diagnostic?.message).toContain("***");
      expect(diagnostic?.message).not.toContain(secret);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retries a failed MCP catalog without stalling healthy siblings", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-catalog-retry-");
    const retryServerPath = path.join(tempDir, "retry-list-tools.mjs");
    const retryLogPath = path.join(tempDir, "retry-server.log");
    const retryReleasePath = path.join(tempDir, "retry.release");
    const healthyServerPath = path.join(tempDir, "healthy-list-tools.mjs");
    const healthyLogPath = path.join(tempDir, "healthy-server.log");
    let nowMs = 10_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    await Promise.all([
      writeListToolsMcpServer({
        filePath: retryServerPath,
        logPath: retryLogPath,
        inputSchema: { type: "array", items: { type: "number" } },
      }),
      writeListToolsMcpServer({
        filePath: healthyServerPath,
        logPath: healthyLogPath,
        tools: [
          {
            name: "healthy_tool",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      }),
    ]);

    const staticRuntime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-catalog-retry",
      sessionKey: "agent:test:session-catalog-retry",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            healthyServer: {
              command: process.execPath,
              args: [healthyServerPath],
              connectionTimeoutMs: 2_000,
            },
            retryServer: {
              command: process.execPath,
              args: [retryServerPath],
              connectionTimeoutMs: 2_000,
            },
          },
        },
      },
    });
    const scopedRuntime = makeRuntime(
      [{ toolName: "scoped_tool", description: "Requester-scoped tool" }],
      "scopedServer",
    );
    const scopedCatalog = await scopedRuntime.getCatalog();
    scopedRuntime.getCatalog = async () => scopedCatalog;
    scopedRuntime.peekCatalog = () => scopedCatalog;
    const runtime = createCombinedSessionMcpRuntime({
      sessionId: "session-catalog-retry",
      workspaceDir: "/workspace",
      parts: [staticRuntime, scopedRuntime],
    });

    try {
      const failedCatalog = await runtime.getCatalog();
      expect(Object.keys(failedCatalog.servers)).toEqual(["healthyServer", "scopedServer"]);
      expect(failedCatalog.tools.map((tool) => tool.toolName)).toEqual([
        "healthy_tool",
        "scoped_tool",
      ]);
      expect(failedCatalog.diagnostics?.[0]?.serverName).toBe("retryServer");

      await writeListToolsMcpServer({
        filePath: retryServerPath,
        logPath: retryLogPath,
        listToolsReleasePath: retryReleasePath,
      });
      await expect(runtime.getCatalog()).resolves.toBe(failedCatalog);

      nowMs += 5_001;
      expect(runtime.peekCatalog()).toBe(failedCatalog);
      const staleCatalog = await withTestTimeout(
        runtime.getCatalog(),
        300,
        "catalog retry blocked the triggering turn",
      );
      expect(staleCatalog).toBe(failedCatalog);
      expect(staleCatalog.diagnostics?.[0]?.serverName).toBe("retryServer");
      await waitForFileTextCount(
        retryLogPath,
        "recv tools/list",
        2,
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      await expect(runtime.callTool("healthyServer", "healthy_tool", {})).resolves.toMatchObject({
        isError: false,
      });
      await fs.writeFile(retryReleasePath, "release", "utf8");

      await waitForPredicate(
        () => staticRuntime.peekCatalog()?.servers.retryServer !== undefined,
        "background catalog recovery",
        LIST_TOOLS_TEST_DEADLINE_MS,
      );
      const recoveredCatalog = await runtime.getCatalog();

      expect(recoveredCatalog.diagnostics ?? []).toEqual([]);
      expect(recoveredCatalog.servers.retryServer).toBeDefined();
      expect(recoveredCatalog.tools.map((tool) => tool.toolName)).toEqual([
        "healthy_tool",
        "slow_tool",
        "scoped_tool",
      ]);
      expect((await fs.readFile(healthyLogPath, "utf8")).match(/recv tools\/list/g)).toHaveLength(
        1,
      );
      expect((await fs.readFile(retryLogPath, "utf8")).match(/recv tools\/list/g)).toHaveLength(2);
    } finally {
      nowSpy.mockRestore();
      await runtime.dispose();
    }
  });

  it("preserves non-text structured MCP results through a real stdio server", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-structured-content-");
    const serverPath = path.join(tempDir, "structured-content.mjs");
    const logPath = path.join(tempDir, "server.log");
    const structuredContent = { description: "captured screenshot" };
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolResult: {
        content: [
          { type: "text", text: "captured screenshot" },
          { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          {
            type: "resource_link",
            uri: "https://example.com/report",
            name: "report",
            title: "Report",
          },
          { type: "resource", resource: { uri: "memo://one", text: "memo body" } },
          { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
        ],
        structuredContent,
      },
    });

    const runtime = await makeStdioRuntime("session-structured-content", "capture", serverPath, {
      workspaceDir: tempDir,
    });

    try {
      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      const result = await expectDefined(
        materialized.tools[0],
        "materialized MCP tool test invariant",
      ).execute("call-structured-content", {}, undefined, undefined);

      expect(result.content).toEqual([
        {
          type: "text",
          text: `structuredContent:\n${JSON.stringify(structuredContent, null, 2)}`,
        },
        { type: "text", text: "captured screenshot" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
        { type: "text", text: "[Report] https://example.com/report" },
        { type: "text", text: "memo body" },
        { type: "text", text: "[audio audio/mpeg]" },
      ]);
      await waitForFileText(logPath, "recv tools/call", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
    }
  });

  it("filters listed MCP tools with per-server include and exclude rules", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-tool-filter-"));
    const serverPath = path.join(tempDir, "tool-filter.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        { name: "search_docs", inputSchema: { type: "object", properties: {} } },
        { name: "read_docs", inputSchema: { type: "object", properties: {} } },
        { name: "admin_delete", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const runtime = await makeStdioRuntime("session-tool-filter", "docs", serverPath, {
      server: {
        toolFilter: { include: ["*_docs", "admin_*"], exclude: ["admin_*"] },
      },
    });

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
        "read_docs",
        "search_docs",
      ]);
      expect(catalog.servers.docs?.toolCount).toBe(2);
      expect(catalog.servers.docs?.tools?.filteredCount).toBe(1);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("applies session tool denials to listed and synthetic MCP tools", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-session-deny-");
    const serverPath = path.join(tempDir, "session-deny.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: {}, resources: {} },
      tools: [
        { name: "search_docs", inputSchema: { type: "object", properties: {} } },
        { name: "read_docs", inputSchema: { type: "object", properties: {} } },
      ],
    });

    const runtime = await makeStdioRuntime("session-tool-deny", "docs", serverPath, {
      workspaceDir: tempDir,
      toolOverrides: { mcpToolsDeny: { docs: ["read_docs", "resources_read"] } },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["search_docs"]);
      expect(catalog.sessionDeniedTools).toMatchObject([
        { serverName: "docs", toolName: "read_docs", deniedBySession: true },
      ]);
      expect(catalog.servers.docs?.toolCount).toBe(1);

      const materialized = await materializeBundleMcpToolsForRun({ runtime });
      expect(materialized.tools.map((tool) => tool.name)).toEqual([
        "docs__resources_list",
        "docs__search_docs",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not read inherited properties as MCP tool denials", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-own-deny-");
    const serverPath = path.join(tempDir, "own-deny.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({ filePath: serverPath, logPath });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-own-deny",
      workspaceDir: tempDir,
      cfg: { mcp: { servers: { constructor: { command: process.execPath, args: [serverPath] } } } },
      toolOverrides: { mcpToolsDeny: { docs: ["slow_tool"] } },
    });

    try {
      expect((await runtime.getCatalog()).tools.map((tool) => tool.toolName)).toEqual([
        "slow_tool",
      ]);
    } finally {
      await runtime.dispose();
    }
  });

  it("does not split a surrogate pair at the MCP metadata text limit", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-utf16-metadata-"));
    const serverPath = path.join(tempDir, "utf16-metadata.mjs");
    const logPath = path.join(tempDir, "server.log");
    const safePrefix = "x".repeat(1_199);
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        {
          name: "utf16_tool",
          description: `${safePrefix}🚀tail`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const runtime = await makeStdioRuntime("session-utf16-metadata", "metadata", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toHaveLength(1);
      expect(catalog.tools[0]?.description).toBe(`${safePrefix}...`);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("lists MCP tools from servers that omit the tools capability", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-unadvertised-tools-"));
    const serverPath = path.join(tempDir, "unadvertised-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: {},
      tools: [{ name: "legacy_tool", inputSchema: { type: "object", properties: {} } }],
    });

    const runtime = await makeStdioRuntime("session-unadvertised-tools", "legacy", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["legacy_tool"]);
      expect(catalog.servers.legacy?.toolCount).toBe(1);
      expect(catalog.servers.legacy?.tools).toBeUndefined();
      await waitForFileText(logPath, "recv tools/list", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps active MCP sessions usable when catalog refresh records diagnostics", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-refresh-diagnostic-"));
    const serverPath = path.join(tempDir, "refresh-diagnostic.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeExecutable(
      serverPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";
let listCount = 0;
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "refresh-diagnostic", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
    listCount += 1;
    if (listCount === 1) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools: [{ name: "ok_tool", inputSchema: { type: "object", properties: {} } }],
        },
      });
      setTimeout(() => {
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        log("sent tools/list_changed");
      }, 10);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "ok_tool", inputSchema: [] }],
      },
    });
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: false, content: [{ type: "text", text: "still connected" }] },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
    );

    const runtime = await makeStdioRuntime("session-refresh-diagnostic", "volatile", serverPath, {
      server: { requestTimeoutMs: 123_456 },
    });

    try {
      const firstCatalog = await runtime.getCatalog();
      expect(firstCatalog.tools.map((tool) => tool.toolName)).toEqual(["ok_tool"]);

      await waitForFileText(logPath, "sent tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      await waitForPredicate(
        () => runtime.peekCatalog() === null,
        "list_changed to invalidate the catalog",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      expect(runtime.getServerRequestTimeoutMs?.("volatile")).toBe(123_456);

      const refreshedCatalog = await runtime.getCatalog();
      expect(refreshedCatalog.tools).toEqual([]);
      expect(refreshedCatalog.diagnostics?.[0]?.serverName).toBe("volatile");

      const result = await runtime.callTool("volatile", "ok_tool", {});
      expect(result.content[0]).toEqual({ type: "text", text: "still connected" });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reconnects after an MCP child process exits", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-child-exit-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    const listToolsReleasePath = path.join(tempDir, "list-tools.release");
    const healthyServerPath = path.join(tempDir, "healthy.mjs");
    const healthyLogPath = path.join(tempDir, "healthy.log");
    await fs.writeFile(listToolsReleasePath, "release", "utf8");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      listToolsReleasePath,
    });
    await writeListToolsMcpServer({ filePath: healthyServerPath, logPath: healthyLogPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-child-exit",
      sessionKey: "agent:test:session-child-exit",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            child: { command: process.execPath, args: [serverPath] },
            healthy: { command: process.execPath, args: [healthyServerPath] },
          },
        },
      },
    });

    try {
      await expect(runtime.callTool("child", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
      await waitForFileText(pidPath, "", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
      await fs.rm(listToolsReleasePath, { force: true });
      // SIGKILL rather than the default SIGTERM: this test is about what happens once the
      // child is actually gone, so the kill must not race the assertions below.
      process.kill(pid, "SIGKILL");

      await waitForPredicate(
        () =>
          runtime.peekCatalog()?.diagnostics?.some((entry) => entry.serverName === "child") ===
          true,
        "closed transport to schedule a catalog retry",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      await expect(runtime.callTool("child", "slow_tool", {})).rejects.toThrow("is not connected");
      await waitForFileTextCount(logPath, "recv tools/list", 2, LIST_TOOLS_TEST_DEADLINE_MS);
      await expect(
        withTestTimeout(
          runtime.callTool("healthy", "slow_tool", {}),
          400,
          "healthy sibling stalled during reconnect",
        ),
      ).resolves.toMatchObject({ isError: false });
      await fs.writeFile(listToolsReleasePath, "release", "utf8");
      await waitForPredicate(
        async () => {
          try {
            return (await runtime.callTool("child", "slow_tool", {})).isError === false;
          } catch {
            return false;
          }
        },
        "child server to reconnect",
        LIST_TOOLS_TEST_DEADLINE_MS,
      );
      const replacementPid = await waitForChangedPid(pidPath, pid, LIST_TOOLS_TEST_DEADLINE_MS);
      expect(replacementPid).not.toBe(pid);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retires a reused MCP session that exits during catalog refresh", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-refresh-exit-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const notifyReleasePath = path.join(tempDir, "notify.release");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: { listChanged: true } },
      notifyListChangedAfterFirstList: true,
      notifyListChangedReleasePath: notifyReleasePath,
      exitOnListCall: 2,
    });

    const runtime = await makeStdioRuntime("session-refresh-exit", "child", serverPath);

    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      await fs.writeFile(notifyReleasePath, "release", "utf8");
      await waitForFileText(logPath, "notify tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      await waitForPredicate(
        () => runtime.peekCatalog() === null,
        "list_changed to invalidate the catalog",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );

      const refreshedCatalog = await runtime.getCatalog();
      expect(refreshedCatalog.tools.map((tool) => tool.toolName)).toEqual(["slow_tool"]);
      expect(refreshedCatalog.diagnostics ?? []).toEqual([]);
      // The failed refresh is retired before catalog loading returns, so callers
      // see only the replacement generation and never receive its stale diagnostic.
      await expect(runtime.callTool("child", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not cache a catalog invalidated while discovery is in flight", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-inflight-invalidated-"));
    const serverPath = path.join(tempDir, "inflight-invalidated.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeExecutable(
      serverPath,
      `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";
let listCount = 0;
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function sendToolList(id, name) {
  send({
    jsonrpc: "2.0",
    id,
    result: {
      tools: [{ name, inputSchema: { type: "object", properties: {} } }],
    },
  });
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "inflight-invalidated", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
    listCount += 1;
    if (listCount === 1) {
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      log("sent tools/list_changed");
      setTimeout(() => sendToolList(message.id, "old_tool"), 10);
      return;
    }
    sendToolList(message.id, "new_tool");
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
    );

    const runtime = await makeStdioRuntime("session-inflight-invalidated", "changing", serverPath);

    try {
      const firstCatalog = await runtime.getCatalog();
      expect(firstCatalog.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);
      await waitForFileText(logPath, "sent tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      expect(runtime.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);

      const secondCatalog = await runtime.getCatalog();
      expect(secondCatalog.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);
      expect(runtime.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("bounds catalog replay when a server invalidates every tools/list response", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-continuous-invalidation-");
    const noisyServerPath = path.join(tempDir, "noisy-server.mjs");
    const noisyLogPath = path.join(tempDir, "noisy-server.log");
    const healthyServerPath = path.join(tempDir, "healthy-server.mjs");
    const healthyLogPath = path.join(tempDir, "healthy-server.log");
    await writeListToolsMcpServer({
      filePath: noisyServerPath,
      logPath: noisyLogPath,
      capabilities: { tools: { listChanged: true } },
      tools: [{ name: "noisy_tool", inputSchema: { type: "object", properties: {} } }],
      notifyListChangedBeforeEveryListResponse: true,
    });
    await writeListToolsMcpServer({
      filePath: healthyServerPath,
      logPath: healthyLogPath,
      tools: [{ name: "healthy_tool", inputSchema: { type: "object", properties: {} } }],
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-continuous-invalidation",
      sessionKey: "agent:test:session-continuous-invalidation",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            noisy: { command: process.execPath, args: [noisyServerPath] },
            healthy: { command: process.execPath, args: [healthyServerPath] },
          },
        },
      },
    });

    try {
      const catalog = await withTestTimeout(
        runtime.getCatalog(),
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        "continuous tools/list invalidation blocked the catalog",
      );

      expect(catalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
        "healthy_tool",
        "noisy_tool",
      ]);
      const noisyLog = await fs.readFile(noisyLogPath, "utf8");
      expect(noisyLog.match(/tools\/list cursor/g)).toHaveLength(2);
    } finally {
      await runtime.dispose();
    }
  });

  it.each([
    {
      name: "resource-only servers reporting method not found",
      capabilities: { resources: { listChanged: true } },
      listToolsMethodNotFound: true,
      listToolsJsonRpcErrorMessage: undefined,
    },
    {
      name: "resource-only servers reporting unknown method",
      capabilities: { resources: { listChanged: true } },
      listToolsMethodNotFound: false,
      listToolsJsonRpcErrorMessage: "Unknown method",
    },
    {
      name: "prompt-only servers reporting unknown method",
      capabilities: { prompts: { listChanged: true } },
      listToolsMethodNotFound: false,
      listToolsJsonRpcErrorMessage: "Unknown method",
    },
  ])("keeps $name available for utility tools", async (testCase) => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-resource-only-"));
    const serverPath = path.join(tempDir, "resource-only.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: testCase.capabilities,
      listToolsMethodNotFound: testCase.listToolsMethodNotFound,
      listToolsJsonRpcErrorMessage: testCase.listToolsJsonRpcErrorMessage,
    });

    const runtime = await makeStdioRuntime("session-resource-only", "notes", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toEqual([]);
      expect(catalog.servers.notes).toMatchObject({
        serverName: "notes",
        toolCount: 0,
        ...testCase.capabilities,
      });
      expect(catalog.diagnostics ?? []).toEqual([]);
      await waitForFileText(logPath, "recv initialize", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not suppress unknown tools/list methods from tools-capable MCP servers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-tools-unknown-method-"));
    const serverPath = path.join(tempDir, "tools-unknown-method.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: {}, resources: { listChanged: true } },
      listToolsJsonRpcErrorMessage: "Unknown method",
    });

    const runtime = await makeStdioRuntime("session-tools-unknown-method", "notes", serverPath);

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.servers).toEqual({});
      expect(catalog.tools).toEqual([]);
      expect(catalog.diagnostics?.[0]).toMatchObject({
        serverName: "notes",
        message: expect.stringContaining("Unknown method"),
      });
      await waitForFileText(logPath, "recv tools/list", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not pause MCP servers for normal tool error results", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-error-backoff-"));
    const serverPath = path.join(tempDir, "error-backoff.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolIsError: true,
    });

    const runtime = await makeStdioRuntime("session-error-backoff", "failing", serverPath);

    try {
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: true,
      });
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: true,
      });
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: true,
      });
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: true,
      });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.each(["managed", "combined"] as const)(
    "cancels a %s catalog waiter without cancelling the shared producer",
    async (kind) => {
      const tempDir = tempDirTracker.make("bundle-mcp-catalog-cancel-");
      const serverPath = path.join(tempDir, "server.mjs");
      const logPath = path.join(tempDir, "server.log");
      const releasePath = path.join(tempDir, "release-list");
      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        listToolsReleasePath: releasePath,
      });
      const managed = createSessionMcpRuntime({
        sessionId: `catalog-cancel-${kind}`,
        workspaceDir: tempDir,
        cfg: { mcp: { servers: { shared: { command: process.execPath, args: [serverPath] } } } },
      });
      const runtime =
        kind === "managed"
          ? managed
          : createCombinedSessionMcpRuntime({
              sessionId: "combined-catalog-cancel",
              workspaceDir: tempDir,
              parts: [managed, makeRuntime([], "other")],
            });
      const controller = new AbortController();
      let cancelled = false;
      let failure: unknown;
      const reason = new Error("cancelled one catalog waiter");
      const first = runWithSessionMcpRequestSignal(controller.signal, () =>
        runtime.callTool("shared", "slow_tool", {}),
      ).catch((error: unknown) => {
        cancelled = true;
        failure = error;
        return error;
      });
      let other: Promise<CallToolResult> | undefined;
      try {
        await waitForFileText(logPath, "recv tools/list", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
        expect(cancelled).toBe(false);
        other = runtime.callTool("shared", "slow_tool", {});
        controller.abort(reason);
        await vi.waitFor(() => expect(cancelled).toBe(true));
        expect(failure).toMatchObject({ name: "AbortError", cause: reason });
        expect(await fs.readFile(logPath, "utf8")).not.toContain("recv notifications/cancelled");
        await fs.writeFile(releasePath, "release");
        await expect(other).resolves.toMatchObject({ isError: false });
        await first;
        const log = await fs.readFile(logPath, "utf8");
        expect(log.match(/recv tools\/list/g)).toHaveLength(1);
        expect(log.match(/recv tools\/call/g)).toHaveLength(1);
        expect(log).not.toContain("recv notifications/cancelled");
        expect(managed.peekCatalog()?.tools.map((tool) => tool.toolName)).toContain("slow_tool");
      } finally {
        await fs.writeFile(releasePath, "release");
        await Promise.allSettled([first, other]);
        await runtime.dispose();
      }
    },
  );

  it("cancels materialized MCP calls without pausing the healthy server", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-caller-cancel-");
    const serverPath = path.join(tempDir, "caller-cancel.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolDelayMs: 250,
      resourcePageDelayMs: 250,
      promptPageDelayMs: 250,
      capabilities: { tools: {}, resources: {}, prompts: {} },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-caller-cancel",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            healthy: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    try {
      const calls = [
        { toolName: "healthy__slow_tool", method: "tools/call" },
        { toolName: "healthy__resources_list", method: "resources/list" },
        { toolName: "healthy__prompts_list", method: "prompts/list" },
      ];
      for (const [index, call] of calls.entries()) {
        const attempt = index + 1;
        const controller = new AbortController();
        const pending = expectDefined(
          materialized.tools.find((entry) => entry.name === call.toolName),
          call.toolName,
        ).execute(`cancel-${attempt}`, {}, controller.signal);
        await waitForPredicate(
          async () =>
            (await fs.readFile(logPath, "utf8").catch(() => "")).includes(`recv ${call.method}`),
          `MCP ${call.method} request to reach the server`,
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );
        controller.abort(new Error(`turn cancelled ${attempt}`));
        await expect(pending).rejects.toThrow(`turn cancelled ${attempt}`);
      }

      await waitForPredicate(
        async () =>
          ((await fs.readFile(logPath, "utf8").catch(() => "")).match(
            /recv notifications\/cancelled/g,
          )?.length ?? 0) === 3,
        "three MCP cancellation notifications",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      await expect(runtime.callTool("healthy", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
      await materialized.dispose();
      await runtime.dispose();
      expect(
        (await fs.readFile(logPath, "utf8")).match(/recv notifications\/cancelled/g) ?? [],
      ).toHaveLength(3);
    } finally {
      await materialized.dispose();
      await runtime.dispose();
    }
  });

  it("pauses MCP servers after repeated tool request failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-request-failure-backoff-"));
    const serverPath = path.join(tempDir, "request-failure-backoff.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolJsonRpcError: true,
    });

    const runtime = await makeStdioRuntime(
      "session-request-failure-backoff",
      "failing",
      serverPath,
    );

    try {
      await expect(runtime.callTool("failing", "slow_tool", {})).rejects.toThrow(
        "tool request failed",
      );
      await expect(runtime.callTool("failing", "slow_tool", {})).rejects.toThrow(
        "tool request failed",
      );
      await expect(runtime.callTool("failing", "slow_tool", {})).rejects.toThrow(
        "tool request failed",
      );
      await expect(runtime.callTool("failing", "slow_tool", {})).rejects.toThrow(
        'bundle-mcp server "failing" is paused after repeated tool failures',
      );
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not recycle a responsive server that returns JSON-RPC code -32001", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-remote-timeout-code-");
    const serverPath = path.join(tempDir, "remote-timeout-code.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      callToolJsonRpcError: true,
      callToolJsonRpcErrorCode: -32001,
    });

    const runtime = await makeStdioRuntime("session-remote-timeout-code", "responsive", serverPath);

    try {
      await runtime.getCatalog();
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
          "tool request failed",
        );
      }
      await expect(runtime.callTool("responsive", "slow_tool", {})).rejects.toThrow(
        'bundle-mcp server "responsive" is paused after repeated tool failures',
      );
      expect(Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10)).toBe(pid);
      expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("recycles an MCP server after repeated request timeouts", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-timeout-recycle-");
    const serverPath = path.join(tempDir, "timeout-recycle.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    const markerPath = path.join(tempDir, "first-server.marker");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      pidPath,
      hangToolCallsUntilRestartMarkerPath: markerPath,
    });

    const runtime = await makeStdioRuntime("session-timeout-recycle", "hanging", serverPath, {
      server: { requestTimeoutMs: 500 },
    });

    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      await waitForFileText(pidPath, "", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);

      const results = await Promise.allSettled(
        Array.from({ length: 6 }, () => runtime.callTool("hanging", "slow_tool", {})),
      );
      expect(results.every((result) => result.status === "rejected")).toBe(true);
      expect(
        results.filter(
          (result) =>
            result.status === "rejected" && String(result.reason).includes("Request timed out"),
        ).length,
      ).toBeGreaterThanOrEqual(3);
      await waitForPredicate(
        async () => {
          try {
            return (await runtime.callTool("hanging", "slow_tool", {})).isError === false;
          } catch {
            return false;
          }
        },
        "timed-out server to recover without stale backoff",
        LIST_TOOLS_TEST_DEADLINE_MS,
      );
      expect(await waitForChangedPid(pidPath, pid, LIST_TOOLS_TEST_DEADLINE_MS)).not.toBe(pid);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("loads tool pages after an empty opaque cursor", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-tool-empty-cursor-");
    const serverPath = path.join(tempDir, "tool-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      toolPageCursors: ["", null],
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-tool-empty-cursor",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { paged: { command: process.execPath, args: [serverPath] } } },
      },
    });

    try {
      await expect(runtime.getCatalog()).resolves.toMatchObject({
        tools: [{ toolName: "slow_tool-1" }, { toolName: "slow_tool-2" }],
      });
      await waitForFileText(logPath, 'tools/list cursor ""', LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
    }
  });

  it("retains paginated output metadata and hides required-task tools", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-tool-metadata-pages-");
    const serverPath = path.join(tempDir, "tool-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      toolPageCursors: ["page-2", null],
      tools: [
        {
          name: "structured",
          inputSchema: { type: "object", properties: {} },
          outputSchema: {
            type: "object",
            properties: { count: { type: "number" } },
            required: ["count"],
            additionalProperties: false,
          },
        },
        {
          name: "task_only",
          inputSchema: { type: "object", properties: {} },
          execution: { taskSupport: "required" },
        },
      ],
      callToolResult: {
        content: [{ type: "text", text: "invalid" }],
        structuredContent: { count: "not-a-number" },
      },
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-tool-metadata-pages",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { paged: { command: process.execPath, args: [serverPath] } } },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => tool.toolName)).toEqual(["structured-1", "structured-2"]);
      expect(
        catalog.policyTools
          ?.filter((tool) => tool.excludedFromOpenClawCatalog)
          .map((tool) => tool.toolName),
      ).toEqual(["task_only-1", "task_only-2"]);
      await expect(runtime.callTool("paged", "structured-1", {})).rejects.toThrow(
        "does not match the tool's output schema",
      );
    } finally {
      await runtime.dispose();
    }
  });

  it("isolates a cyclic tool catalog while a healthy bundle MCP sibling survives", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-tool-cycle-");
    const loopingPath = path.join(tempDir, "looping.mjs");
    const loopingLogPath = path.join(tempDir, "looping.log");
    const healthyPath = path.join(tempDir, "healthy.mjs");
    const healthyLogPath = path.join(tempDir, "healthy.log");
    await writeListToolsMcpServer({
      filePath: loopingPath,
      logPath: loopingLogPath,
      toolPageCursors: ["same", "same"],
    });
    await writeListToolsMcpServer({ filePath: healthyPath, logPath: healthyLogPath });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-tool-cycle",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            looping: { command: process.execPath, args: [loopingPath] },
            healthy: { command: process.execPath, args: [healthyPath] },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      expect(catalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual([
        "healthy:slow_tool",
      ]);
      expect(
        catalog.diagnostics?.find((entry) => entry.serverName === "looping")?.message,
      ).toContain("repeated pagination cursor");
      await waitForFileText(healthyLogPath, "recv tools/list", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
    }
  });

  it("loads resource and prompt pages after empty opaque cursors", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-utility-empty-cursor-");
    const serverPath = path.join(tempDir, "utility-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { resources: {}, prompts: {} },
      listToolsMethodNotFound: true,
      resourcePageCursors: ["", null],
      promptPageCursors: ["", null],
    });
    const runtime = createSessionMcpRuntime({
      sessionId: "session-utility-empty-cursor",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { paged: { command: process.execPath, args: [serverPath] } } },
      },
    });

    try {
      await runtime.getCatalog();
      const listResources = runtime.listResources;
      const listPrompts = runtime.listPrompts;
      if (!listResources || !listPrompts) {
        throw new Error("Expected test runtime to expose resource and prompt utilities");
      }
      await expect(listResources("paged")).resolves.toMatchObject([
        { uri: "memo://page-1" },
        { uri: "memo://page-2" },
      ]);
      await expect(listPrompts("paged")).resolves.toMatchObject([
        { name: "prompt-1" },
        { name: "prompt-2" },
      ]);
      await waitForFileText(logPath, 'resources/list cursor ""', LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      await waitForFileText(logPath, 'prompts/list cursor ""', LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
    } finally {
      await runtime.dispose();
    }
  });

  it("bounds the complete paginated resource listing by one absolute timeout", async () => {
    const tempDir = tempDirTracker.make("bundle-mcp-resource-pages-");
    const serverPath = path.join(tempDir, "resource-pages.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { resources: {} },
      listToolsMethodNotFound: true,
      resourcePageDelayMs: 100,
      resourcePageCount: 2,
    });

    const runtime = await makeStdioRuntime("session-resource-pages", "paged", serverPath, {
      server: { requestTimeoutMs: 150 },
    });

    try {
      if (!runtime.listResources) {
        throw new Error("Expected test runtime to expose resource utilities");
      }
      await expect(runtime.listResources("paged")).rejects.toThrow(
        "MCP resource listing timed out after 150ms",
      );
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("pauses MCP servers after repeated utility request failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-utility-failure-backoff-"));
    const serverPath = path.join(tempDir, "utility-failure-backoff.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { resources: {} },
      listToolsMethodNotFound: true,
      resourceListJsonRpcError: true,
    });

    const runtime = await makeStdioRuntime(
      "session-utility-failure-backoff",
      "failing",
      serverPath,
    );

    try {
      if (!runtime.listResources) {
        throw new Error("Expected test runtime to expose resource utilities");
      }
      await expect(runtime.listResources("failing")).rejects.toThrow("resource request failed");
      await expect(runtime.listResources("failing")).rejects.toThrow("resource request failed");
      await expect(runtime.listResources("failing")).rejects.toThrow("resource request failed");
      await expect(runtime.listResources("failing")).rejects.toThrow(
        'bundle-mcp server "failing" is paused after repeated tool failures',
      );
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("does not pause tools after optional preview read failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-preview-failure-"));
    const serverPath = path.join(tempDir, "preview-failure.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: {}, resources: {} },
      resourceReadJsonRpcError: true,
    });

    const runtime = await makeStdioRuntime("session-preview-failure", "failing", serverPath);

    try {
      const readResource = runtime.readResource;
      if (!readResource) {
        throw new Error("Expected test runtime to expose resource utilities");
      }
      for (let index = 0; index < 3; index += 1) {
        await expect(
          readResource("failing", "ui://demo/app", { failureBackoff: "ignore" }),
        ).rejects.toThrow("resource read failed");
      }
      await expect(runtime.callTool("failing", "slow_tool", {})).resolves.toMatchObject({
        isError: false,
      });
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reuses repeated materialization and recreates after explicit disposal", async () => {
    const created: SessionMcpRuntime[] = [];
    const createdManifestRegistries: unknown[] = [];
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      createdManifestRegistries.push(params.manifestRegistry);
      const runtime = makeManagedRuntime(params, [
        { toolName: "bundle_probe", description: "Bundle MCP probe" },
      ]);
      created.push(runtime);
      return {
        ...runtime,
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const manifestRegistry = { plugins: [] };

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
      manifestRegistry,
    });
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
      manifestRegistry,
    });

    const materializedA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const materializedB = await materializeBundleMcpToolsForRun({
      runtime: runtimeB,
      reservedToolNames: ["builtin_tool"],
    });

    expect(runtimeA).toBe(runtimeB);
    expect(materializedA.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(materializedB.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(created).toHaveLength(1);
    expect(createdManifestRegistries).toEqual([manifestRegistry]);
    expect(manager.listSessionIds()).toEqual(["session-a"]);

    await manager.disposeSession("session-a");
    expect(disposed).toEqual(["session-a"]);

    const runtimeC = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
      manifestRegistry,
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeC });

    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toHaveLength(2);
    expect(createdManifestRegistries).toEqual([manifestRegistry, manifestRegistry]);

    const materializedC = await materializeBundleMcpToolsForRun({
      runtime: runtimeC,
      disposeRuntime: async () => {
        await manager.disposeSession("session-a");
      },
    });
    expect(materializedC.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);

    await materializedC.dispose();

    expect(disposed).toEqual(["session-a", "session-a"]);
    expect(manager.listSessionIds()).not.toContain("session-a");
  });

  it("preserves agentDir scope when creating and reusing session MCP runtimes", async () => {
    const created: Array<{ sessionId: string; agentDir?: string }> = [];
    const disposed: Array<{ sessionId: string; agentDir?: string }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({ sessionId: params.sessionId, agentDir: params.agentDir });
      return {
        ...makeManagedRuntime(params, [
          { toolName: "bundle_probe", description: "Bundle MCP probe" },
        ]),
        agentDir: params.agentDir,
        dispose: async () => {
          disposed.push({ sessionId: params.sessionId, agentDir: params.agentDir });
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/one",
    });
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/one",
    });
    const runtimeC = await manager.getOrCreate({
      sessionId: "session-agent-dir",
      sessionKey: "agent:test:session-agent-dir",
      workspaceDir: "/workspace",
      agentDir: "/agents/two",
    });

    expect(runtimeA).toBe(runtimeB);
    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toEqual([
      { sessionId: "session-agent-dir", agentDir: "/agents/one" },
      { sessionId: "session-agent-dir", agentDir: "/agents/two" },
    ]);
    expect(disposed).toEqual([{ sessionId: "session-agent-dir", agentDir: "/agents/one" }]);

    await manager.disposeAll();
  });

  it("peeks existing runtimes and populated catalogs without creating new runtimes", async () => {
    let catalogReady = false;
    const createRuntime: RuntimeFactory = (params) => {
      const base = makeManagedRuntime(params, [
        { toolName: "bundle_probe", description: "Bundle MCP probe" },
      ]);
      let cachedCatalog: ReturnType<SessionMcpRuntime["peekCatalog"]> = null;
      return {
        ...base,
        peekCatalog: () => cachedCatalog,
        getCatalog: async () => {
          const catalog = await base.getCatalog();
          cachedCatalog = catalog;
          catalogReady = true;
          return catalog;
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    expect(manager.peekSession({ sessionId: "session-peek" })).toBeUndefined();

    const runtime = await manager.getOrCreate({
      sessionId: "session-peek",
      sessionKey: "agent:test:session-peek",
      workspaceDir: "/workspace",
    });
    expect(manager.peekSession({ sessionId: "session-peek" })).toBe(runtime);
    expect(manager.peekSession({ sessionKey: "agent:test:session-peek" })).toBe(runtime);
    expect(runtime.peekCatalog()).toBeNull();
    expect(catalogReady).toBe(false);

    await runtime.getCatalog();

    expect(catalogReady).toBe(true);
    expect(runtime.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual(["bundle_probe"]);
  });

  it("recreates the session runtime when MCP config changes", async () => {
    const createRuntime: RuntimeFactory = (params) => {
      const probeText = String(
        params.cfg?.mcp?.servers?.configuredProbe?.env?.BUNDLE_PROBE_TEXT ?? "FROM-CONFIG",
      );
      return {
        ...makeManagedRuntime(params, [
          { toolName: "bundle_probe", description: "Bundle MCP probe" },
        ]),
        callTool: async () => ({
          content: [{ type: "text", text: probeText }],
          isError: false,
        }),
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["server-a.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-A",
              },
            },
          },
        },
      },
    });
    const toolsA = await materializeBundleMcpToolsForRun({ runtime: runtimeA });
    const resultA = await expectDefined(toolsA.tools[0], "toolsA.tools[0] test invariant").execute(
      "call-configured-probe-a",
      {},
      undefined,
      undefined,
    );

    const runtimeB = await manager.getOrCreate({
      sessionId: "session-c",
      sessionKey: "agent:test:session-c",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["server-b.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG-B",
              },
            },
          },
        },
      },
    });
    const toolsB = await materializeBundleMcpToolsForRun({ runtime: runtimeB });
    const resultB = await expectDefined(toolsB.tools[0], "toolsB.tools[0] test invariant").execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
    expect(runtimeA.configFingerprint).toMatch(SHA256_HEX_PATTERN);
    expect(runtimeB.configFingerprint).toMatch(SHA256_HEX_PATTERN);
    expect(runtimeA.configFingerprint).not.toBe(runtimeB.configFingerprint);
    const contentA = resultA.content[0];
    const contentB = resultB.content[0];
    if (contentA?.type !== "text" || contentB?.type !== "text") {
      throw new Error("Expected configured bundle MCP probe calls to return text content");
    }
    expect(contentA.text).toBe("FROM-CONFIG-A");
    expect(contentB.text).toBe("FROM-CONFIG-B");
  });

  it("disposes catalog startup in-flight without leaving cached runtimes", async () => {
    let notifyCatalogStarted: (() => void) | undefined;
    const catalogStarted = new Promise<void>((resolve) => {
      notifyCatalogStarted = resolve;
    });
    let rejectCatalog: ((error: Error) => void) | undefined;
    const createRuntime: RuntimeFactory = (params) => ({
      ...makeManagedRuntime(params, [
        { toolName: "bundle_probe", description: "Bundle MCP probe" },
      ]),
      getCatalog: async () => {
        if (!notifyCatalogStarted) {
          throw new Error("Expected bundle MCP catalog start callback to be initialized");
        }
        notifyCatalogStarted();
        return await new Promise((_, reject) => {
          rejectCatalog = reject;
        });
      },
      dispose: async () => {
        rejectCatalog?.(new Error(`bundle-mcp runtime disposed for session ${params.sessionId}`));
      },
    });
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const runtime = await manager.getOrCreate({
      sessionId: "session-d",
      sessionKey: "agent:test:session-d",
      workspaceDir: "/workspace",
    });

    const materializeResult = materializeBundleMcpToolsForRun({ runtime }).then(
      () => ({ status: "resolved" as const }),
      (error: unknown) => ({ status: "rejected" as const, error }),
    );
    await catalogStarted;
    await manager.disposeSession("session-d");

    const result = await materializeResult;
    if (result.status !== "rejected") {
      throw new Error("Expected bundle MCP materialization to reject after disposal");
    }
    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toMatch(/disposed/);
    expect(manager.listSessionIds()).not.toContain("session-d");
  });

  it("retires global session runtimes and ignores missing ids", async () => {
    await getOrCreateSessionMcpRuntime({
      sessionId: "session-retire",
      sessionKey: "agent:test:session-retire",
      workspaceDir: "/workspace",
    });
    expect(testing.getCachedSessionIds()).toContain("session-retire");

    await expect(
      retireSessionMcpRuntime({ sessionId: " session-retire ", reason: "test" }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).not.toContain("session-retire");

    await expect(retireSessionMcpRuntime({ sessionId: " ", reason: "test" })).resolves.toBe(false);
  });

  it("keeps an ordinary session-key mapping when an unbound mutation probe retires", async () => {
    const ordinary = await getOrCreateSessionMcpRuntime({
      sessionId: "session-ordinary",
      sessionKey: "agent:test:ordinary",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    await getOrCreateSessionMcpRuntime({
      sessionId: "cron-authority:probe",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });

    await retireSessionMcpRuntime({
      sessionId: "cron-authority:probe",
      reason: "scheduled-authority-snapshot-complete",
    });

    expect(peekSessionMcpRuntime({ sessionKey: "agent:test:ordinary" })).toBe(ordinary);
  });

  it("preserves a runtime while a bounded app view lease is active", async () => {
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-view-lease",
      sessionKey: "agent:test:session-view-lease",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    const release = runtime.acquireLease?.();
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "clear on reset" }],
      },
    );

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-view-lease",
        reason: "embedded-run-end",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-view-lease");
    expect(runtime.pendingMcpAppModelContext).toMatchObject({ text: "clear on reset" });
    expect(() =>
      updateMcpAppModelContext(
        runtime,
        {},
        {
          content: [{ type: "text", text: "still live between turns" }],
        },
      ),
    ).not.toThrow();

    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(testing.getCachedSessionIds()).not.toContain("session-view-lease");
  });

  it("revokes App context across reset while a view lease defers retirement", async () => {
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-view-reset",
      sessionKey: "agent:test:session-view-reset",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    const release = runtime.acquireLease?.();
    updateMcpAppModelContext(
      runtime,
      {},
      {
        content: [{ type: "text", text: "clear on reset" }],
      },
    );

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-view-reset",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
        retainAcrossReuse: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-view-reset");
    expect(runtime.pendingMcpAppModelContext).toBeUndefined();
    expect(() =>
      updateMcpAppModelContext(
        runtime,
        {},
        {
          content: [{ type: "text", text: "stale after reset" }],
        },
      ),
    ).toThrow("unavailable for this session");
    const reused = await getOrCreateSessionMcpRuntime({
      sessionId: "session-view-reset",
      sessionKey: "agent:test:session-view-reset",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    expect(reused).toBe(runtime);
    expect(reused.mcpAppModelContextRevoked).toBe(true);

    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(testing.getCachedSessionIds()).not.toContain("session-view-reset");
  });

  it("completes deferred retirement when a materialized run releases its lease", async () => {
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-run-lease",
      sessionKey: "agent:test:session-run-lease",
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-run-lease",
        reason: "gateway-session-cleanup",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-run-lease");

    await materialized.dispose();
    expect(testing.getCachedSessionIds()).not.toContain("session-run-lease");
  });

  it.each(["run", "app"] as const)(
    "keeps an active MCP child and database lock until its %s lease retires",
    async (retirementPath) => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-deferred-run-"));
      const serverPath = path.join(tempDir, "server.mjs");
      const logPath = path.join(tempDir, "server.log");
      const pidPath = path.join(tempDir, "server.pid");
      const databasePath = path.join(tempDir, "locked.sqlite");
      const appRetirement = retirementPath === "app";
      await writeListToolsMcpServer({
        filePath: serverPath,
        logPath,
        pidPath,
        databasePath,
        capabilities: { tools: {}, resources: {} },
        resourceReadResult: {
          contents: [
            {
              uri: "ui://fixture/app",
              mimeType: "text/html;profile=mcp-app",
              text: "<html><body>lease fixture</body></html>",
            },
          ],
        },
      });
      let materialized: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
      let lockProbe: DatabaseSync | undefined;

      try {
        const runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-run-child",
          sessionKey: "agent:test:session-run-child",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              apps: { enabled: appRetirement },
              servers: {
                child: { command: process.execPath, args: [serverPath] },
              },
            },
          },
        });
        materialized = await materializeBundleMcpToolsForRun({ runtime });
        const appView = appRetirement
          ? await fetchMcpAppView({
              runtime,
              serverName: "child",
              toolName: "slow_tool",
              uiResourceUri: "ui://fixture/app",
              toolInput: {},
              toolResult: { content: [] },
            })
          : undefined;
        if (appRetirement) {
          expect(appView).toBeDefined();
        }
        await waitForFileText(pidPath, "", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
        const pid = Number.parseInt((await fs.readFile(pidPath, "utf8")).trim(), 10);
        const { DatabaseSync } = await import("node:sqlite");
        const database = new DatabaseSync(databasePath);
        lockProbe = database;
        database.exec("PRAGMA busy_timeout = 0");
        expect(() => database.exec("BEGIN IMMEDIATE")).toThrow(/database is locked|SQLITE_BUSY/iu);

        await retireSessionMcpRuntime({
          sessionId: "session-run-child",
          reason: "gateway-session-cleanup",
          preserveActiveLeases: true,
        });
        expect(() => process.kill(pid, 0)).not.toThrow();
        expect(testing.getCachedSessionIds()).toContain("session-run-child");

        await materialized.dispose();
        materialized = undefined;
        if (appView) {
          expect(() => process.kill(pid, 0)).not.toThrow();
          expect(() => database.exec("BEGIN IMMEDIATE")).toThrow(
            /database is locked|SQLITE_BUSY/iu,
          );
          const view = expectDefined(getMcpAppViewLease(appView.viewId, runtime), "MCP App view");
          // Exercise the real expiry/deletion owner, not a manual retirement completion.
          const clock = vi.spyOn(Date, "now").mockReturnValue(view.expiresAtMs);
          try {
            expect(getMcpAppViewLease(appView.viewId, runtime)).toBeUndefined();
          } finally {
            clock.mockRestore();
          }
        }
        await waitForPredicate(
          () => {
            try {
              process.kill(pid, 0);
              return false;
            } catch {
              return true;
            }
          },
          "deferred MCP child process exit",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );
        expect(testing.getCachedSessionIds()).not.toContain("session-run-child");
        expect(() => database.exec("BEGIN IMMEDIATE")).not.toThrow();
        database.exec("ROLLBACK");
      } finally {
        mcpUiResourceTesting.clearViewStore();
        await retireSessionMcpRuntime({ sessionId: "session-run-child", reason: "test-cleanup" });
        lockProbe?.close();
        await materialized?.dispose();
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );

  it("keeps a run-mode subagent runtime alive for an approved follow-up turn", async () => {
    const sessionId = "session-subagent-followup";
    const sessionKey = "agent:test:session-subagent-followup";
    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId,
      sessionKey,
      workspaceDir: "/workspace",
      cfg: { mcp: {} },
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime });
    expect(runtime.activeLeases).toBe(1);

    await expect(
      retireSessionMcpRuntimeForSessionKey({
        sessionKey,
        reason: "subagent-run-cleanup",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain(sessionId);

    const followUp = await materializeBundleMcpToolsForRun({ runtime });
    expect(runtime.activeLeases).toBe(2);

    await materialized.dispose();
    expect(testing.getCachedSessionIds()).toContain(sessionId);

    await followUp.dispose();
    expect(runtime.activeLeases).toBe(0);
    expect(testing.getCachedSessionIds()).not.toContain(sessionId);
  });

  it("cancels deferred retirement when a later run reuses the runtime", async () => {
    const manager = testing.createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
    const params = {
      sessionId: "session-reused-after-view",
      sessionKey: "agent:test:session-reused-after-view",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {} } },
    };
    const runtime = await manager.getOrCreate(params);
    const release = runtime.acquireLease?.();

    expect(manager.deferRetirement(params.sessionId)).toBe(true);
    await expect(manager.getOrCreate(params)).resolves.toBe(runtime);

    release?.();
    await expect(manager.completeDeferredRetirement(params.sessionId, runtime)).resolves.toBe(
      false,
    );
    expect(manager.listSessionIds()).toContain(params.sessionId);
    await manager.disposeAll();
  });

  it("keeps required retirement armed across late runtime creation and reuse", async () => {
    const manager = testing.createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
    const params = {
      sessionId: "session-required-retirement",
      sessionKey: "agent:test:session-required-retirement",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {} } },
    };

    expect(manager.deferRetirement(params.sessionId, { retainAcrossReuse: true })).toBe(true);
    const firstRuntime = await manager.getOrCreate(params);
    const release = expectDefined(
      firstRuntime.acquireLease,
      "firstRuntime.acquireLease test invariant",
    )();
    await expect(manager.completeDeferredRetirement(params.sessionId, firstRuntime)).resolves.toBe(
      false,
    );
    release();
    await expect(manager.completeDeferredRetirement(params.sessionId, firstRuntime)).resolves.toBe(
      true,
    );
    expect(manager.listSessionIds()).not.toContain(params.sessionId);

    const lateRuntime = await manager.getOrCreate(params);
    await expect(manager.completeDeferredRetirement(params.sessionId, lateRuntime)).resolves.toBe(
      true,
    );
    expect(manager.listSessionIds()).not.toContain(params.sessionId);

    await manager.disposeSession(params.sessionId);
    const reusableRuntime = await manager.getOrCreate(params);
    await expect(
      manager.completeDeferredRetirement(params.sessionId, reusableRuntime),
    ).resolves.toBe(false);
    await manager.disposeAll();
  });

  it("keeps a real requester-scoped MCP transport alive during an idle sweep", async () => {
    const proof = await startRequesterScopedMcpProofServer();
    const resolverTesting = await import("./mcp-connection-resolver.js");
    let firstTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>;
    let secondTools: Awaited<ReturnType<typeof materializeRequesterScopedMcpToolsForHarnessRun>>;
    let nowMs = 100_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    let resolveCount = 0;
    const releaseResolution = createDeferred();
    const resolutionStarted = createDeferred();
    resolverTesting.testing.setMcpServerConnectionResolversForTest([
      {
        serverName: "real-requester",
        resolve: async () => {
          resolveCount += 1;
          if (resolveCount === 2) {
            resolutionStarted.resolve();
            await releaseResolution.promise;
          }
          return {
            url: proof.url,
            headers: { Authorization: "Bearer proof-token" },
          };
        },
      },
    ]);
    resolverTesting.testing.setMcpConnectionRevalidateMsForTest(1);
    const declaredServer = {
      transport: "streamable-http" as const,
      url: "https://placeholder.invalid/mcp",
    };
    const params = makeRequesterParams(
      "session-real-requester-sweep",
      {
        mcp: { servers: { "real-requester": declaredServer } },
      },
      "proof-requester",
    );
    const singletonStore = globalThis as Record<PropertyKey, unknown>;
    const hadRuntimeManager = Object.hasOwn(singletonStore, SESSION_MCP_RUNTIME_MANAGER_KEY);
    const previousRuntimeManager = singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
    const manager = testing.createSessionMcpRuntimeManager({
      now: () => nowMs,
      enableIdleSweepTimer: false,
    });
    singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = manager;

    try {
      firstTools = expectDefined(
        await materializeRequesterScopedMcpToolsForHarnessRun(params),
        "first requester tools",
      );
      const runtimeKey = expectDefined(manager.listRuntimeKeys()[0], "first requester runtime key");
      const firstRuntime = expectDefined(
        manager.peekSession({ sessionId: runtimeKey }),
        "first requester runtime",
      );
      const firstTool = expectDefined(firstTools.tools[0], "first requester tool");
      const firstSessionId = readMcpText(
        await firstTool.execute("first-requester-call", {}),
        "first MCP result",
      );
      await firstTools.dispose();
      firstTools = undefined;

      nowMs += 2;
      const secondRequest = materializeRequesterScopedMcpToolsForHarnessRun(params);
      await resolutionStarted.promise;

      const idleTtlMs = 10 * 60 * 1000;
      nowMs += idleTtlMs;
      expect(await manager.sweepIdleRuntimes()).toBe(0);
      expect(manager.listRuntimeKeys()).toHaveLength(1);

      releaseResolution.resolve();
      secondTools = expectDefined(await secondRequest, "second requester tools");
      expect(manager.peekSession({ sessionId: runtimeKey })).toBe(firstRuntime);
      const secondTool = expectDefined(secondTools.tools[0], "second requester tool");
      expect(
        readMcpText(await secondTool.execute("second-requester-call", {}), "second MCP result"),
      ).toBe(firstSessionId);
      expect(proof.session.current).toBe(firstSessionId);
      await secondTools.dispose();
      secondTools = undefined;

      nowMs += idleTtlMs;
      expect(await manager.sweepIdleRuntimes()).toBe(1);
      expect(manager.listRuntimeKeys()).toEqual([]);
      expect(proof.session.closed).toBe(firstSessionId);
    } finally {
      releaseResolution.resolve();
      await Promise.allSettled([firstTools?.dispose(), secondTools?.dispose()]);
      await testing.resetSessionMcpRuntimeManager();
      if (hadRuntimeManager) {
        singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY] = previousRuntimeManager;
      } else {
        delete singletonStore[SESSION_MCP_RUNTIME_MANAGER_KEY];
      }
      clock.mockRestore();
      await proof.close();
    }
  });

  it("retires global session runtimes by session key", async () => {
    await getOrCreateSessionMcpRuntime({
      sessionId: "session-retire-key",
      sessionKey: "agent:test:session-retire-key",
      workspaceDir: "/workspace",
    });
    expect(testing.getCachedSessionIds()).toContain("session-retire-key");

    await expect(
      retireSessionMcpRuntimeForSessionKey({
        sessionKey: " agent:test:session-retire-key ",
        reason: "test",
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).not.toContain("session-retire-key");

    await expect(
      retireSessionMcpRuntimeForSessionKey({ sessionKey: "agent:test:missing", reason: "test" }),
    ).resolves.toBe(false);
  });

  it("production createSessionMcpRuntime acquireLease release does not refresh lastUsedAt", () => {
    const runtime = createSessionMcpRuntime({
      sessionId: "session-lease-timestamp-check",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {} } },
    });
    const lastUsedBefore = runtime.lastUsedAt;
    if (!runtime.acquireLease) {
      throw new Error("Expected production session MCP runtime to expose acquireLease");
    }
    const release = runtime.acquireLease();
    release();
    expect(runtime.lastUsedAt).toBe(lastUsedBefore);
  });
});

describe("requester-scoped MCP connection resolution", () => {
  afterEach(async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest();
    resolverTesting.setMcpConnectionResolverTimeoutMsForTest();
    resolverTesting.setMcpConnectionRevalidateMsForTest();
    vi.useRealTimers();
  });

  it.each([
    ["static", 1],
    ["full", 2],
    ["requester-only", 1],
  ] as const)(
    "expires %s runtimes at ten idle minutes while preserving reuse and active leases",
    async (entrypoint, expectedExpired) => {
      let nowMs = 100_000;
      const clock = vi.spyOn(Date, "now").mockImplementation(() => nowMs);
      const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "user-mail",
          resolve: async () => ({ url: "https://mcp.example.test/user" }),
        },
      ]);
      const manager = testing.createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
      const sessionKey = "agent:test:session-fixed-idle";
      const params: RuntimeParams = {
        sessionId: "session-fixed-idle",
        sessionKey,
        workspaceDir: "/workspace",
        ...(entrypoint === "static" ? {} : { requesterSenderId: "sender-a" }),
        cfg: {
          mcp: {
            servers: {
              shared: { command: "true" },
              ...(entrypoint === "static"
                ? {}
                : { "user-mail": { transport: "streamable-http" as const } }),
            },
          },
        },
      };
      const getRuntime = () =>
        entrypoint === "requester-only"
          ? manager.getOrCreateRequesterScoped(params).then((handle) => handle?.runtime)
          : manager.getOrCreate(params);
      try {
        await getRuntime();
        nowMs += 10 * 60 * 1000 - 1;
        expect(await manager.sweepIdleRuntimes()).toBe(0);

        const reused = expectDefined(await getRuntime(), "admitted MCP runtime");
        expect(reused.lastUsedAt).toBe(nowMs);
        nowMs += 10 * 60 * 1000 - 1;
        expect(await manager.sweepIdleRuntimes()).toBe(0);
        const release = expectDefined(reused.acquireLease, "MCP runtime lease")();
        nowMs += 1;
        expect(await manager.sweepIdleRuntimes()).toBe(0);
        expect(manager.listSessionIds()).toContain(params.sessionId);

        release();
        expect(await manager.sweepIdleRuntimes()).toBe(expectedExpired);
        expect(manager.listRuntimeKeys()).toEqual([]);
        expect(manager.resolveSessionId(sessionKey)).toBeUndefined();
      } finally {
        await manager.disposeAll();
        clock.mockRestore();
      }
    },
  );

  it("sweeps admitted runtimes on the fixed idle timer and stops maintenance after disposal", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const now = vi.fn(() => Date.now());
    const manager = testing.createSessionMcpRuntimeManager({ now });
    const params: RuntimeParams = {
      sessionId: "session-idle-timer",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {} } },
    };
    try {
      await manager.getOrCreate(params);
      await manager.getOrCreate(params);
      now.mockClear();
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000 - 1);
      expect(manager.listSessionIds()).toEqual([params.sessionId]);
      expect(now).toHaveBeenCalledTimes(9);
      await vi.advanceTimersByTimeAsync(1);
      expect(manager.listSessionIds()).toEqual([]);
      expect(now).toHaveBeenCalledTimes(10);

      await manager.disposeAll();
      now.mockClear();
      await vi.advanceTimersByTimeAsync(60 * 1000);
      expect(now).not.toHaveBeenCalled();
    } finally {
      await manager.disposeAll();
    }
  });

  it("keys requester-scoped runtimes per sender while sharing static servers", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) => ({
          url: `https://mcp.example.test/${ctx.requesterSenderId}`,
          headers: { Authorization: `Bearer ${ctx.requesterSenderId}` },
        }),
      },
    ]);

    const created: Array<{
      sessionId: string;
      requesterScope?: SessionMcpRuntime["requesterScope"];
      include?: string[];
      exclude?: string[];
    }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({
        sessionId: params.sessionId,
        requesterScope: params.requesterScope,
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = (sender: string) =>
      makeRequesterParams("session-shared", cfg as never, sender, {
        sessionKey: "agent:test:session-shared",
        agentAccountId: "bot-1",
      });
    await manager.getOrCreate(params("sender-a"));
    await manager.getOrCreate(params("sender-a"));
    await manager.getOrCreate(params("sender-b"));

    // Same requester reuses both static and requester-scoped entries; other sender adds one.
    expect(created).toEqual([
      {
        sessionId: "session-shared",
        requesterScope: undefined,
        include: undefined,
        exclude: ["user-mail"],
      },
      {
        sessionId: "session-shared",
        requesterScope: {
          requesterSenderId: "sender-a",
          agentAccountId: "bot-1",
          messageChannel: "telegram",
        },
        include: ["user-mail"],
        exclude: undefined,
      },
      {
        sessionId: "session-shared",
        requesterScope: {
          requesterSenderId: "sender-b",
          agentAccountId: "bot-1",
          messageChannel: "telegram",
        },
        include: ["user-mail"],
        exclude: undefined,
      },
    ]);
    expect(manager.listSessionIds()).toEqual(["session-shared"]);
    expect(manager.listRuntimeKeys()).toHaveLength(3);

    await manager.disposeAll();
  });

  it("keeps the tools.effective config summary in fingerprint parity with the peeked runtime", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    const { resolveSessionMcpConfigSummary } = await import("./agent-bundle-mcp-tools.js");
    const manager = testing.createSessionMcpRuntimeManager();
    const expectBareRuntimeParity = async (params: {
      sessionId: string;
      cfg: NonNullable<RuntimeParams["cfg"]>;
      expectedServerNames: string[];
      toolOverrides?: RuntimeParams["toolOverrides"];
      requesterSenderId?: string;
    }) => {
      const summary = resolveSessionMcpConfigSummary({
        workspaceDir: "/workspace",
        cfg: params.cfg,
        ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
      });
      await manager.getOrCreate({
        sessionId: params.sessionId,
        workspaceDir: "/workspace",
        cfg: params.cfg,
        ...(params.toolOverrides ? { toolOverrides: params.toolOverrides } : {}),
        ...(params.requesterSenderId ? { requesterSenderId: params.requesterSenderId } : {}),
      });
      expect(summary.serverNames).toEqual(params.expectedServerNames);
      expect(summary.fingerprint).toBe(
        manager.peekSession({ sessionId: params.sessionId })?.configFingerprint,
      );
    };
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http", url: "https://static.example.test" },
        },
      },
    } satisfies NonNullable<RuntimeParams["cfg"]>;

    await expectBareRuntimeParity({
      sessionId: "session-parity-static",
      cfg,
      expectedServerNames: ["shared", "user-mail"],
    });

    const toolOverrides = { mcpServers: { shared: false } };
    await expectBareRuntimeParity({
      sessionId: "session-parity-overridden",
      cfg,
      expectedServerNames: ["user-mail"],
      toolOverrides,
    });

    await expectBareRuntimeParity({
      sessionId: "session-parity-denials",
      cfg,
      expectedServerNames: ["shared", "user-mail"],
      toolOverrides: { mcpToolsDeny: { shared: ["private", "private"] } },
    });

    await expectBareRuntimeParity({
      sessionId: "session-parity-empty",
      cfg: {},
      expectedServerNames: [],
    });

    // Full-set declaration order owns safe-name collision suffixes even though
    // requester-scoped OAuth servers stay out of the bare runtime partition.
    await expectBareRuntimeParity({
      sessionId: "session-parity-oauth",
      cfg: {
        mcp: {
          servers: {
            "shared name": { command: "true" },
            "shared-name": {
              transport: "streamable-http",
              auth: "oauth",
              oauth: { identity: "per-requester" },
              url: "https://scoped.example.test",
            },
          },
        },
      },
      expectedServerNames: ["shared name", "shared-name"],
    });

    // With a resolver registered, tools.effective peeks the bare static-partition
    // runtime; summary parity keeps it from reporting stale-config forever.
    resolverTesting.setMcpServerConnectionResolversForTest([
      { serverName: "user-mail", resolve: async () => null },
    ]);
    await expectBareRuntimeParity({
      sessionId: "session-parity-scoped",
      cfg,
      expectedServerNames: ["shared", "user-mail"],
      requesterSenderId: "sender-a",
    });

    await manager.disposeAll();
  });

  it("skips connection resolve on requester cache hits", async () => {
    let resolveCalls = 0;
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        pluginId: "mail-plugin",
        serverName: "user-mail",
        resolve: async (ctx) => {
          resolveCalls += 1;
          return {
            url: `https://mcp.example.test/${ctx.requesterSenderId}`,
            headers: { Authorization: `Bearer ${ctx.requesterSenderId}` },
          };
        },
      },
    ]);

    const createRuntime: RuntimeFactory = makeManagedRuntime;
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-resolve-once", cfg as never, "sender-a");
    await manager.getOrCreate(params);
    await manager.getOrCreate(params);

    expect(resolveCalls).toBe(1);
    await manager.disposeAll();
  });

  it("omits a throwing resolver without rejecting static MCP materialization", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        pluginId: "broken-plugin",
        serverName: "user-mail",
        resolve: async () => {
          throw new Error("provider unavailable");
        },
      },
    ]);

    const created: Array<{ include?: string[]; exclude?: string[] }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    await expect(
      manager.getOrCreate({
        sessionId: "session-throw",
        workspaceDir: "/workspace",
        cfg: cfg as never,
        requesterSenderId: "sender-a",
        messageChannel: "telegram",
      }),
    ).resolves.toBeDefined();

    expect(created).toEqual([{ include: undefined, exclude: ["user-mail"] }]);
    expect(manager.listRuntimeKeys()).toHaveLength(1);

    await manager.disposeAll();
  });

  it("omits requester-scoped servers without requester context or when resolve returns null", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) =>
          ctx.requesterSenderId === "allowed" ? { url: "https://mcp.example.test/allowed" } : null,
      },
    ]);

    const created: Array<{ include?: string[]; exclude?: string[] }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    await manager.getOrCreate({
      sessionId: "session-fail-closed",
      workspaceDir: "/workspace",
      cfg: cfg as never,
    });
    await manager.getOrCreate(
      makeRequesterParams("session-fail-closed", cfg as never, "denied", {
        messageChannel: "slack",
      }),
    );
    await manager.getOrCreate(
      makeRequesterParams("session-fail-closed", cfg as never, "allowed", {
        messageChannel: "slack",
      }),
    );

    // Static entry is reused; only the allowed requester materializes a scoped runtime.
    expect(created).toEqual([
      { include: undefined, exclude: ["user-mail"] },
      { include: ["user-mail"], exclude: undefined },
    ]);

    await manager.disposeAll();
  });

  it("keeps config fingerprints stable across alternating requesters", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) => ({
          url: `https://mcp.example.test/${ctx.requesterSenderId}`,
          headers: { Authorization: `Bearer ${ctx.requesterSenderId}` },
        }),
      },
    ]);

    const fingerprints: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      fingerprints.push(params.configFingerprint ?? "missing");
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": {
            transport: "streamable-http",
            toolFilter: { include: ["send*"] },
          },
        },
      },
    };

    await manager.getOrCreate(makeRequesterParams("session-fingerprint", cfg as never, "alice"));
    await manager.getOrCreate(makeRequesterParams("session-fingerprint", cfg as never, "bob"));
    await manager.getOrCreate(makeRequesterParams("session-fingerprint", cfg as never, "alice"));

    // Empty static reconcile + two requester creates; requester fingerprints match.
    expect(fingerprints).toHaveLength(3);
    expect(fingerprints[0]).toMatch(SHA256_HEX_PATTERN);
    expect(fingerprints[1]).toBe(fingerprints[2]);
    expect(fingerprints[1]).toMatch(SHA256_HEX_PATTERN);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
    expect(manager.listRuntimeKeys()).toHaveLength(3);

    await manager.disposeAll();
  });

  it("omits a stalled resolver without hanging static materialization", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpConnectionResolverTimeoutMsForTest(25);
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        pluginId: "hang-plugin",
        serverName: "user-mail",
        resolve: () => new Promise(() => {}),
      },
    ]);

    const created: Array<{ include?: string[]; exclude?: string[] }> = [];
    const createRuntime: RuntimeFactory = (params) => {
      created.push({
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    vi.useFakeTimers();
    const pending = manager.getOrCreate(
      makeRequesterParams("session-timeout", cfg as never, "sender-a"),
    );
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBeDefined();
    expect(created).toEqual([{ include: undefined, exclude: ["user-mail"] }]);
    await manager.disposeAll();
  });

  it("upgrades a partially resolved requester runtime when more servers resolve", async () => {
    let resolveRound = 0;
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "mail-a",
        resolve: async () => ({ url: "https://mcp.example.test/a" }),
      },
      {
        serverName: "mail-b",
        resolve: async () => {
          resolveRound += 1;
          return resolveRound >= 2 ? { url: "https://mcp.example.test/b" } : null;
        },
      },
    ]);

    const createdIncludes: string[][] = [];
    const createRuntime: RuntimeFactory = (params) => {
      if (params.includeServerNames) {
        createdIncludes.push([...params.includeServerNames].toSorted());
      }
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "mail-a": { transport: "streamable-http" },
          "mail-b": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-partial", cfg as never, "sender-a");
    await manager.getOrCreate(params);
    expect(createdIncludes).toEqual([["mail-a"]]);

    await manager.getOrCreate(params);
    expect(createdIncludes).toEqual([["mail-a"], ["mail-a", "mail-b"]]);
    // Static part was created once and not rebuilt when the requester side upgraded.
    expect(manager.listRuntimeKeys().filter((key) => !key.startsWith("{"))).toEqual([
      "session-partial",
    ]);

    await manager.disposeAll();
  });

  it("routes callTool on a fresh combined runtime without a prior getCatalog", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      },
    ]);

    const createRuntime: RuntimeFactory = (params) => {
      const serverName = params.includeServerNames?.has("user-mail")
        ? "user-mail"
        : params.excludeServerNames?.has("user-mail")
          ? "shared"
          : "shared";
      const toolName = serverName === "user-mail" ? "send" : "shared_tool";
      return {
        ...makeManagedRuntime(params, [{ toolName, description: toolName }], serverName),
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            [serverName]: {
              serverName,
              launchSummary: serverName,
              toolCount: 1,
            },
          },
          tools: [
            {
              serverName,
              safeServerName: serverName,
              toolName,
              description: toolName,
              inputSchema: { type: "object", properties: {} },
              fallbackDescription: toolName,
            },
          ],
        }),
        callTool: async (calledServer, calledTool) => ({
          content: [{ type: "text", text: `${calledServer}:${calledTool}` }],
          isError: false,
        }),
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const runtime = await manager.getOrCreate({
      sessionId: "session-combined-call",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

    await expect(runtime.callTool("user-mail", "send", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "user-mail:send" }],
    });
    await expect(runtime.callTool("shared", "shared_tool", {})).resolves.toMatchObject({
      content: [{ type: "text", text: "shared:shared_tool" }],
    });

    await manager.disposeAll();
  });

  it.each([
    ["full", 3],
    ["requester-only", 2],
  ] as const)(
    "evicts LRU idle requester runtimes past the per-session cap via %s materialization",
    async (entrypoint, expectedRuntimeCount) => {
      const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "user-mail",
          resolve: async (ctx) => ({ url: `https://mcp.example.test/${ctx.requesterSenderId}` }),
        },
      ]);

      const disposedSenders: string[] = [];
      let syntheticLastUsedAt = 100_000;
      const createRuntime: RuntimeFactory = (params) => {
        const sender = params.requesterScope?.requesterSenderId;
        // Distinct ascending lastUsedAt per runtime so LRU ordering is deterministic.
        const lastUsedAt = (syntheticLastUsedAt += 1_000);
        return {
          ...makeManagedRuntime(params),
          get lastUsedAt() {
            return lastUsedAt;
          },
          markUsed: () => {},
          dispose: async () => {
            if (sender) {
              disposedSenders.push(sender);
            }
          },
        };
      };
      const manager = testing.createSessionMcpRuntimeManager({
        createRuntime,
        // Pin the sweep clock near the synthetic lastUsedAt values so the idle
        // TTL sweep never fires; this test exercises only the cap eviction.
        now: () => 150_000,
        maxIdleRequesterRuntimesPerSession: 2,
      });
      const cfg = {
        mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
      };

      for (const sender of ["sender-a", "sender-b", "sender-c"]) {
        const runtimeParams = makeRequesterParams("session-cap", cfg as never, sender);
        if (entrypoint === "full") {
          await manager.getOrCreate(runtimeParams);
        } else {
          await manager.getOrCreateRequesterScoped(runtimeParams);
        }
      }

      // sender-a is the least recently used zero-lease scoped runtime.
      expect(disposedSenders).toEqual(["sender-a"]);
      const runtimeKeys = manager.listRuntimeKeys();
      expect(runtimeKeys).toHaveLength(expectedRuntimeCount);
      expect(runtimeKeys.includes("session-cap")).toBe(entrypoint === "full");
      expect(
        runtimeKeys
          .filter((key) => key.startsWith("{"))
          .map((key) => (JSON.parse(key) as { requesterSenderId: string }).requesterSenderId),
      ).toEqual(["sender-b", "sender-c"]);

      await manager.disposeAll();
    },
  );

  it("re-merges the combined catalog after a part refreshes on tools/list_changed", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      },
    ]);

    const makeCatalog = (serverName: string, toolName: string) => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: { serverName, launchSummary: serverName, toolCount: 1 },
      },
      tools: [
        {
          serverName,
          safeServerName: serverName,
          toolName,
          description: toolName,
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: toolName,
        },
      ],
    });
    const swapCatalogByServer = new Map<string, (toolName: string) => void>();
    const createRuntime: RuntimeFactory = (params) => {
      const serverName = params.includeServerNames?.has("user-mail") ? "user-mail" : "shared";
      let current = makeCatalog(serverName, serverName === "user-mail" ? "send" : "shared_tool");
      swapCatalogByServer.set(serverName, (toolName) => {
        current = makeCatalog(serverName, toolName);
      });
      return {
        ...makeManagedRuntime(params, [{ toolName: "unused", description: "unused" }]),
        peekCatalog: () => current,
        getCatalog: async () => current,
        getServerRequestTimeoutMs: () => (serverName === "user-mail" ? 90_000 : 60_000),
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const runtime = await manager.getOrCreate({
      sessionId: "session-combined-refresh",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

    const before = await runtime.getCatalog();
    expect(before.tools.map((tool) => tool.toolName).toSorted()).toEqual(["send", "shared_tool"]);

    // A part replacing its catalog (tools/list_changed refresh) must invalidate
    // the merged facade cache instead of serving the stale combined catalog.
    swapCatalogByServer.get("user-mail")?.("send_v2");
    const after = await runtime.getCatalog();
    expect(after.tools.map((tool) => tool.toolName).toSorted()).toEqual(["send_v2", "shared_tool"]);
    expect(runtime.getServerRequestTimeoutMs?.("user-mail")).toBe(90_000);
    expect(
      runtime
        .peekCatalog()
        ?.tools.map((tool) => tool.toolName)
        .toSorted(),
    ).toEqual(["send_v2", "shared_tool"]);

    await manager.disposeAll();
  });

  it("disposes cached scoped runtime when revalidation resolves empty", async () => {
    let allow = true;
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpConnectionRevalidateMsForTest(1_000);
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () =>
          allow
            ? {
                url: "https://mcp.example.test/user",
                headers: { Authorization: "Bearer test-auth-token" },
              }
            : null,
      },
    ]);

    let nowMs = 50_000;
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      const label = params.requesterScope ? "scoped" : "static";
      return {
        ...makeManagedRuntime(params),
        dispose: async () => {
          disposed.push(label);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => nowMs,
      enableIdleSweepTimer: false,
    });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-revoke", cfg as never, "sender-a");
    await manager.getOrCreate(params);
    expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);

    allow = false;
    nowMs += 2_000;
    const after = await manager.getOrCreate(params);

    expect(disposed).toContain("scoped");
    expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(false);
    expect(manager.listRuntimeKeys()).toEqual(["session-revoke"]);
    // Static part still works.
    const catalog = await after.getCatalog();
    expect(Object.keys(catalog.servers)).toEqual(["bundleProbe"]);

    await manager.disposeAll();
  });

  it("serializes disposeSession with in-flight requester resolve", async () => {
    let releaseResolve: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => {
          await gate;
          return { url: "https://mcp.example.test/user" };
        },
      },
    ]);

    const createRuntime: RuntimeFactory = makeManagedRuntime;
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const pending = manager.getOrCreate({
      sessionId: "session-race-dispose",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            shared: { command: "true" },
            "user-mail": { transport: "streamable-http" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

    // Static may install; dispose is chained after the exclusive requester section.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    const disposePromise = manager.disposeSession("session-race-dispose");
    releaseResolve?.();
    await pending;
    await disposePromise;
    expect(manager.listRuntimeKeys()).toEqual([]);
    expect(testing.getBookkeepingSizes(manager).requesterWorkChains).toBe(0);

    await manager.disposeAll();
  });

  it("serializes concurrent requester installs so the last resolution wins", async () => {
    let call = 0;
    let clock = 0;
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const { hashMcpResolvedConnections, testing: resolverTesting } =
      await import("./mcp-connection-resolver.js");
    // Tiny revalidate window; monotonic clock advances every now() so the next
    // exclusive section is past the window and re-resolves.
    resolverTesting.setMcpConnectionRevalidateMsForTest(1);
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => {
          call += 1;
          const token = call === 1 ? "test-auth-token" : "secret-token";
          if (call === 1) {
            await firstGate;
          }
          return {
            url: "https://mcp.example.test/user",
            headers: { Authorization: `Bearer ${token}` },
          };
        },
      },
    ]);

    const builtHashes: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      if (params.connectionOverrides) {
        builtHashes.push(hashMcpResolvedConnections(params.connectionOverrides));
      }
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => {
        clock += 10;
        return clock;
      },
      enableIdleSweepTimer: false,
    });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-serialize", cfg as never, "sender-a");
    const first = manager.getOrCreate(params);
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const second = manager.getOrCreate(params);

    // Second is queued behind the first exclusive section. First installs the first credential, then
    // second re-resolves the rotated credential and replaces — last serialized resolution wins.
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
    releaseFirst?.();
    await Promise.all([first, second]);

    expect(call).toBe(2);
    expect(builtHashes).toHaveLength(2);
    expect(builtHashes[0]).not.toBe(builtHashes[1]);
    expect(manager.listRuntimeKeys().filter((key) => key.startsWith("{"))).toHaveLength(1);

    await manager.disposeAll();
    expect(Object.values(testing.getBookkeepingSizes(manager)).every((n) => n === 0)).toBe(true);
  });

  it("clears internal bookkeeping maps after disposeAll", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      },
    ]);
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime: makeManagedRuntime,
    });
    await manager.getOrCreate({
      sessionId: "session-bookkeeping",
      workspaceDir: "/workspace",
      cfg: {
        mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(testing.getBookkeepingSizes(manager).runtimes).toBeGreaterThan(0);
    await manager.disposeAll();
    expect(testing.getBookkeepingSizes(manager)).toEqual({
      runtimes: 0,
      connectionMeta: 0,
      createInFlight: 0,
      requesterWorkChains: 0,
      sessionKeys: 0,
      deferredRetirement: 0,
      advertisedScopedCatalogs: 0,
    });
  });

  it("revalidates credentials past the revalidation window without rebuilding on unchanged hash", async () => {
    let resolveCalls = 0;
    let token = "test-auth-token";
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpConnectionRevalidateMsForTest(1_000);
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => {
          resolveCalls += 1;
          return {
            url: "https://mcp.example.test/user",
            headers: { Authorization: `Bearer ${token}` },
          };
        },
      },
    ]);

    let nowMs = 10_000;
    let createCount = 0;
    const createRuntime: RuntimeFactory = (params) => {
      createCount += 1;
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => nowMs,
      enableIdleSweepTimer: false,
    });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-revalidate", cfg as never, "sender-a");
    await manager.getOrCreate(params);
    expect(resolveCalls).toBe(1);
    expect(createCount).toBe(2); // empty static + requester

    // Within revalidation window: no resolver call.
    nowMs += 500;
    await manager.getOrCreate(params);
    expect(resolveCalls).toBe(1);
    expect(createCount).toBe(2);

    // Past window, unchanged credentials: resolve once, no rebuild.
    nowMs += 1_000;
    await manager.getOrCreate(params);
    expect(resolveCalls).toBe(2);
    expect(createCount).toBe(2);

    // Past window with rotated header: rebuild requester runtime.
    token = "secret-token";
    nowMs += 1_000;
    await manager.getOrCreate(params);
    expect(resolveCalls).toBe(3);
    expect(createCount).toBe(3);

    await manager.disposeAll();
  });

  it("uses full-set safe names independent of which servers resolve", async () => {
    const { assignSafeServerNames } = await import("./agent-bundle-mcp-names.js");
    const fullSet = assignSafeServerNames(["mail.prod", "mail-prod", "shared"]);
    // Declaration order: mail.prod declared first claims the unsuffixed base,
    // matching legacy collision ownership for existing configs.
    expect(fullSet.get("mail.prod")).toBe("mail-prod");
    expect(fullSet.get("mail-prod")).toBe("mail-prod-2");
    expect(fullSet.get("shared")).toBe("shared");

    let resolveBoth = true;
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "mail-prod",
        resolve: async () => (resolveBoth ? { url: "https://mcp.example.test/mail-prod" } : null),
      },
    ]);

    const passedMaps: Array<ReadonlyMap<string, string> | undefined> = [];
    const createRuntime: RuntimeFactory = (params) => {
      passedMaps.push(params.safeServerNamesByServer);
      const isScoped = Boolean(params.requesterScope);
      const serverName = isScoped ? "mail-prod" : "mail.prod";
      const safe = params.safeServerNamesByServer?.get(serverName) ?? serverName;
      return {
        ...makeManagedRuntime(params, [{ toolName: "send", description: "send" }], serverName),
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            [serverName]: {
              serverName,
              safeServerName: safe,
              launchSummary: serverName,
              toolCount: 1,
            },
          },
          tools: [
            {
              serverName,
              safeServerName: safe,
              toolName: "send",
              inputSchema: { type: "object", properties: {} },
              fallbackDescription: "send",
            },
          ],
          policyTools: [
            {
              serverName,
              safeServerName: safe,
              toolName: "send",
              inputSchema: { type: "object", properties: {} },
              fallbackDescription: "send",
            },
            {
              serverName,
              safeServerName: safe,
              toolName: "delete",
              inputSchema: { type: "object", properties: {} },
              fallbackDescription: "delete",
              excludedFromOpenClawCatalog: true,
            },
          ],
        }),
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "mail.prod": { command: "true" },
          "mail-prod": { transport: "streamable-http" },
        },
      },
    };

    const runtimeA = await manager.getOrCreate(
      makeRequesterParams("session-safe-names", cfg as never, "sender-a"),
    );
    resolveBoth = false;
    const runtimeB = await manager.getOrCreate(
      makeRequesterParams("session-safe-names", cfg as never, "sender-b"),
    );

    // Every create for this session received the same full-set assignments;
    // declaration order gives "mail.prod" (declared first) the unsuffixed base.
    expect(passedMaps.length).toBeGreaterThan(1);
    for (const map of passedMaps) {
      expect(map?.get("mail.prod")).toBe("mail-prod");
      expect(map?.get("mail-prod")).toBe("mail-prod-2");
    }

    const catalogA = await runtimeA.getCatalog();
    const catalogB = await runtimeB.getCatalog();
    expect(catalogA.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
    // B may only have static part if scoped omitted; shared names still match full-set map.
    if (catalogA.servers["mail-prod"]) {
      expect(catalogA.servers["mail-prod"]?.safeServerName).toBe("mail-prod-2");
    }
    expect(catalogB.servers["mail.prod"]?.safeServerName).toBe("mail-prod");

    // Merge preserves precomputed names (no further re-suffix).
    const merged = testing.mergeMcpToolCatalogs([catalogA, catalogB]);
    expect(merged.servers["mail.prod"]?.safeServerName).toBe("mail-prod");
    expect(
      new Set(
        merged.policyTools
          ?.filter((tool) => tool.toolName === "delete")
          .map((tool) => tool.safeServerName),
      ),
    ).toEqual(new Set(["mail-prod", "mail-prod-2"]));

    await manager.disposeAll();
  });

  it("reconciles a stale bare runtime when every server becomes requester-scoped", async () => {
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => ({
      ...makeManagedRuntime(params),
      dispose: async () => {
        disposed.push(
          params.includeServerNames
            ? `include:${[...params.includeServerNames].toSorted().join(",") || "empty"}`
            : "full",
        );
      },
    });
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });

    // No resolver yet: bare session runtime owns the only server.
    await manager.getOrCreate({
      sessionId: "session-stale-bare",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "user-mail": { command: "true" },
          },
        },
      } as never,
    });
    expect(manager.listRuntimeKeys()).toEqual(["session-stale-bare"]);
    expect(manager.peekSession({ sessionId: "session-stale-bare" })).toBeDefined();

    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      },
    ]);

    await manager.getOrCreate({
      sessionId: "session-stale-bare",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

    // Stale bare runtime is disposed and replaced by the empty static entry.
    expect(disposed).toContain("full");
    expect(manager.peekSession({ sessionId: "session-stale-bare" })).toBeDefined();
    const bare = manager.peekSession({ sessionId: "session-stale-bare" });
    expect(bare?.requesterScope).toBeUndefined();
    expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);

    await manager.disposeAll();
  });

  it("does not put resolved URLs into catalog descriptions for overridden servers", async () => {
    const secretUrl = "https://secret-host.example/signed/path?token=placeholder";
    const runtime = createSessionMcpRuntime({
      sessionId: "session-no-url-desc",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "user-mail": {
              transport: "streamable-http",
              url: "https://placeholder.example",
            },
          },
        },
      },
      connectionOverrides: new Map([
        ["user-mail", { url: secretUrl, headers: { Authorization: "Bearer test-auth-token" } }],
      ]),
    });
    try {
      const catalog = await runtime.getCatalog();
      const summary =
        catalog.servers["user-mail"]?.launchSummary ??
        catalog.diagnostics?.[0]?.launchSummary ??
        "";
      expect(summary).toBe("user-mail: requester-scoped connection");
      expect(summary).not.toContain("secret-host.example");
      expect(summary).not.toContain("signed/path");
      expect(summary).not.toContain("?token=");
      for (const tool of catalog.tools) {
        expect(tool.fallbackDescription ?? "").not.toContain("secret-host.example");
        expect(tool.fallbackDescription ?? "").not.toContain("signed/path");
      }
    } finally {
      await runtime.dispose();
    }
  });

  it("preserves active leases on requester-scoped runtimes when retiring a session", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/user" }),
      },
    ]);

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-lease-scoped",
      sessionKey: "agent:test:session-lease-scoped",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "user-mail": { transport: "streamable-http" },
          },
        },
      },
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    // Returned runtime is the scoped part; bare empty runtime has zero leases.
    expect(runtime.requesterScope?.requesterSenderId).toBe("sender-a");
    const release = runtime.acquireLease?.();
    expect(runtime.activeLeases).toBeGreaterThan(0);

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-lease-scoped",
        reason: "test-preserve-scoped-lease",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-lease-scoped");
    expect(testing.getCachedRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);

    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(testing.getCachedSessionIds()).not.toContain("session-lease-scoped");
  });

  it("rebuilds partitions when full-set safe-name assignments change", async () => {
    const fingerprints: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      fingerprints.push(params.configFingerprint ?? "");
      return makeManagedRuntime(params);
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "mail-prod",
        resolve: async () => ({ url: "https://mcp.example.test/mail" }),
      },
    ]);

    await manager.getOrCreate({
      sessionId: "session-fp-safe",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "mail.prod": { command: "true" },
            "mail-prod": { transport: "streamable-http" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    const afterFirst = fingerprints.length;
    expect(afterFirst).toBeGreaterThanOrEqual(2);

    await manager.getOrCreate({
      sessionId: "session-fp-safe",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            "mail.prod": { command: "true" },
            "mail-prod": { transport: "streamable-http" },
            // New colliding base changes full-set safe-name assignments.
            mail_prod: { command: "true" },
          },
        },
      } as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(fingerprints.length).toBeGreaterThan(afterFirst);
    // New partition fingerprints differ from the first create batch.
    expect(
      fingerprints.slice(afterFirst).some((fp) => !fingerprints.slice(0, afterFirst).includes(fp)),
    ).toBe(true);

    await manager.disposeAll();
  });

  it("rejects anonymous requester identities before touching existing requester state", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) => ({
          url: `https://mcp.example.test/${ctx.requesterSenderId}`,
        }),
      },
    ]);
    const created: Array<{
      requesterScope?: SessionMcpRuntime["requesterScope"];
      include?: string[];
      exclude?: string[];
    }> = [];
    const dispose = vi.fn(async () => {});
    let nowMs = 100_000;
    const createRuntime: RuntimeFactory = (params) => {
      const createdAt = nowMs;
      created.push({
        requesterScope: params.requesterScope,
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return {
        ...makeManagedRuntime(params, [{ toolName: "probe", description: "probe" }], "user-mail"),
        get lastUsedAt() {
          return createdAt;
        },
        markUsed: () => {},
        dispose,
      };
    };
    const now = vi.fn(() => nowMs);
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime, now });
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const sessionId = "session-scoped-only";
    const sessionKey = "agent:main:session-scoped-only";
    const scoped = await manager.getOrCreateRequesterScoped(
      makeRequesterParams(sessionId, cfg as never, "sender-a", { sessionKey }),
    );
    expect(scoped?.runtime.requesterScope?.requesterSenderId).toBe("sender-a");
    await vi.waitFor(() =>
      expect(testing.getBookkeepingSizes(manager).requesterWorkChains).toBe(0),
    );
    const runtimeKeys = manager.listRuntimeKeys();
    const bookkeeping = testing.getBookkeepingSizes(manager);
    expect(runtimeKeys).toHaveLength(1);
    expect(runtimeKeys[0]).toMatch(/^\{/);
    expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
    expect(created).toHaveLength(1);
    expect(bookkeeping).toMatchObject({
      runtimes: 1,
      connectionMeta: 1,
      requesterWorkChains: 0,
      sessionKeys: 1,
    });

    now.mockClear();
    nowMs += 10 * 60 * 1000 + 1;
    for (const [requesterSenderId, attemptedSessionId] of [
      [undefined, "session-missing"],
      ["  ", "session-blank"],
      [null, "session-null"],
    ] as const) {
      await expect(
        manager.getOrCreateRequesterScoped({
          sessionId: attemptedSessionId,
          sessionKey,
          requesterSenderId,
          workspaceDir: "/workspace",
          cfg: cfg as never,
        }),
      ).resolves.toBeUndefined();
      expect(manager.resolveSessionId(sessionKey)).toBe(sessionId);
    }

    expect(now).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    expect(manager.listRuntimeKeys()).toEqual(runtimeKeys);
    expect(testing.getBookkeepingSizes(manager)).toEqual(bookkeeping);
    // The existing requester partition remains the only runtime; no static or
    // anonymous replacement runtime was created.
    expect(created).toEqual([
      {
        requesterScope: {
          requesterSenderId: "sender-a",
          messageChannel: "telegram",
        },
        include: ["user-mail"],
        exclude: undefined,
      },
    ]);

    await manager.disposeAll();
  });

  it("reuses one requester runtime across full and requester-only entrypoints", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    let resolveCount = 0;
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) => {
          resolveCount += 1;
          return { url: `https://mcp.example.test/${ctx.requesterSenderId}` };
        },
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "probe", description: "probe" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const params = makeRequesterParams("session-reuse", cfg as never, "sender-a");
    const full = await manager.getOrCreate(params);
    const fullRuntimeKey = manager.listRuntimeKeys().find((key) => key.startsWith("{"));
    const requesterOnly = await manager.getOrCreateRequesterScoped(params);
    const requesterOnlyRuntimeKey = manager.listRuntimeKeys().find((key) => key.startsWith("{"));
    expect(requesterOnly?.runtime).toBe(full);
    expect(resolveCount).toBe(1);
    expect(requesterOnlyRuntimeKey).toBe(fullRuntimeKey);
    expect(requesterOnly?.runtime.configFingerprint).toBe(full.configFingerprint);
    expect(manager.listRuntimeKeys()).toHaveLength(2);

    await manager.disposeAll();
  });

  it("keeps advertised scoped catalog stable across senders and clears on dispose", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async (ctx) =>
          ctx.requesterSenderId === "authed" ? { url: "https://mcp.example.test/authed" } : null,
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    expect(manager.getAdvertisedScopedCatalog("session-adv")).toBeNull();

    const authed = await manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv", cfg as never, "authed"),
    );
    expect(authed).toBeDefined();
    const catalog = await authed!.runtime.getCatalog();
    manager.rememberAdvertisedScopedCatalog(authed!, catalog);

    const advertised = manager.getAdvertisedScopedCatalog("session-adv");
    expect(advertised?.tools.map((tool) => tool.toolName)).toEqual(["inbox"]);

    // Unauthed sender: no runtime, but advertised catalog stays.
    await expect(
      manager.getOrCreateRequesterScoped({
        sessionId: "session-adv",
        workspaceDir: "/workspace",
        cfg: cfg as never,
        requesterSenderId: "guest",
        messageChannel: "telegram",
      }),
    ).resolves.toBeUndefined();
    expect(manager.getAdvertisedScopedCatalog("session-adv")?.tools.map((t) => t.toolName)).toEqual(
      ["inbox"],
    );

    await manager.disposeSession("session-adv");
    expect(manager.getAdvertisedScopedCatalog("session-adv")).toBeNull();
  });

  it("clears advertised scoped catalog when its MCP config changes", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/authed" }),
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfgA = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http", toolFilter: { include: ["read*"] } },
        },
      },
    };
    const cfgB = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http", toolFilter: { include: ["send*"] } },
        },
      },
    };

    const runtime = await manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-config", cfgA as never, "authed"),
    );
    manager.rememberAdvertisedScopedCatalog(runtime!, await runtime!.runtime.getCatalog());
    expect(manager.getAdvertisedScopedCatalog("session-adv-config")?.tools).toHaveLength(1);

    await manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-config", cfgB as never, "authed"),
    );
    expect(manager.getAdvertisedScopedCatalog("session-adv-config")).toBeNull();
  });

  it("clears advertised scoped catalog when the last scoped server is removed", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/authed" }),
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const scopedConfig = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };
    const staticConfig = {
      mcp: {
        servers: {
          shared: { command: "true" },
        },
      },
    };

    const runtime = await manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-removal", scopedConfig as never, "authed"),
    );
    manager.rememberAdvertisedScopedCatalog(runtime!, await runtime!.runtime.getCatalog());
    expect(manager.getAdvertisedScopedCatalog("session-adv-removal")?.tools).toHaveLength(1);

    await expect(
      manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-removal", staticConfig as never, "guest"),
      ),
    ).resolves.toBeUndefined();
    expect(manager.getAdvertisedScopedCatalog("session-adv-removal")).toBeNull();
  });

  it("reconciles cached scoped catalog before a senderless turn", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => ({ url: "https://mcp.example.test/authed" }),
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const scopedConfig = {
      mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
    };
    const staticConfig = {
      mcp: { servers: { shared: { command: "true" } } },
    };

    const runtime = await manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-senderless", scopedConfig as never, "authed"),
    );
    manager.rememberAdvertisedScopedCatalog(runtime!, await runtime!.runtime.getCatalog());

    await expect(
      manager.getOrCreateRequesterScoped(
        makeRequesterParams("session-adv-senderless", staticConfig as never, "", {
          requesterSenderId: undefined,
        }),
      ),
    ).resolves.toBeUndefined();
    expect(manager.getAdvertisedScopedCatalog("session-adv-senderless")).toBeNull();
  });

  it("rejects a late catalog publication from an older configuration", async () => {
    const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
    let releaseOldResolve!: () => void;
    const oldResolve = new Promise<void>((resolve) => {
      releaseOldResolve = resolve;
    });
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    let resolveCount = 0;
    resolverTesting.setMcpServerConnectionResolversForTest([
      {
        serverName: "user-mail",
        resolve: async () => {
          resolveCount += 1;
          if (resolveCount === 1) {
            markOldStarted();
            await oldResolve;
          }
          return { url: "https://mcp.example.test/authed" };
        },
      },
    ]);
    const createRuntime: RuntimeFactory = (params) =>
      makeManagedRuntime(params, [{ toolName: "inbox", description: "read inbox" }], "user-mail");
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const oldConfig = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
          shared: { command: "first" },
        },
      },
    };
    const newConfig = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
          shared: { command: "second" },
        },
      },
    };

    const oldRequest = manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-race", oldConfig as never, "same-requester"),
    );
    await oldStarted;
    const newRequest = manager.getOrCreateRequesterScoped(
      makeRequesterParams("session-adv-race", newConfig as never, "same-requester"),
    );
    releaseOldResolve();
    const oldRuntime = await oldRequest;
    const newRuntime = await newRequest;
    expect(newRuntime!.runtime).toBe(oldRuntime!.runtime);
    manager.rememberAdvertisedScopedCatalog(oldRuntime!, await oldRuntime!.runtime.getCatalog());
    expect(manager.getAdvertisedScopedCatalog("session-adv-race")).toBeNull();
  });

  it(
    "clears removed scoped catalog through the harness after a real MCP transport run",
    { timeout: 15_000 },
    async () => {
      const server = http.createServer((request, response) => {
        if (request.method === "DELETE") {
          response.writeHead(204).end();
          return;
        }
        if (request.method !== "POST") {
          response.writeHead(405).end();
          return;
        }
        let body = "";
        request.setEncoding("utf8");
        request.on("data", (chunk) => {
          body += chunk;
        });
        request.on("end", () => {
          const message = JSON.parse(body) as { id?: string | number; method?: string };
          if (message.method === "notifications/initialized") {
            response.writeHead(202).end();
            return;
          }
          response.setHeader("content-type", "application/json");
          response.setHeader("mcp-session-id", "session-proof");
          response.writeHead(200).end(
            JSON.stringify(
              message.method === "initialize"
                ? {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      protocolVersion: "2025-03-26",
                      capabilities: { tools: {} },
                      serverInfo: { name: "catalog-proof-server", version: "1.0.0" },
                    },
                  }
                : {
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      tools: [
                        {
                          name: "inbox",
                          description: "read inbox",
                          inputSchema: { type: "object", properties: {} },
                        },
                      ],
                    },
                  },
            ),
          );
        });
      });
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      const { testing: resolverTesting } = await import("./mcp-connection-resolver.js");
      resolverTesting.setMcpServerConnectionResolversForTest([
        {
          serverName: "user-mail",
          resolve: async () => ({ url: `http://127.0.0.1:${address.port}/mcp` }),
        },
      ]);
      const scopedConfig = {
        mcp: { servers: { "user-mail": { transport: "streamable-http" } } },
      };
      const staticConfig = {
        mcp: { servers: { shared: { command: "true" } } },
      };

      try {
        const first = await materializeRequesterScopedMcpToolsForHarnessRun({
          sessionId: "session-harness-removal",
          workspaceDir: "/workspace",
          cfg: scopedConfig as never,
          requesterSenderId: "authed",
        });
        expect(first?.advertisedTools.map((tool) => tool.name)).toEqual(["user-mail__inbox"]);
        await first?.dispose();

        const afterRemoval = await materializeRequesterScopedMcpToolsForHarnessRun({
          sessionId: "session-harness-removal",
          workspaceDir: "/workspace",
          cfg: staticConfig as never,
          requesterSenderId: "guest",
        });
        expect(afterRemoval).toBeUndefined();
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});

describe("disposeSession timeout", () => {
  it(
    "force-closes transport and client when terminateSession hangs past the timeout",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-force-close-"));
      const serverPath = path.join(tempDir, "hanging-terminate.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeExecutable(
        serverPath,
        `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "hanging-terminate-server", version: "1.0.0" },
          },
        });
      } else if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }] },
        });
      } else {
        log("recv " + String(message.method ?? "response"));
      }
    }
  }
});

// Keep process alive forever and ignore all shutdown signals
process.on("SIGTERM", () => { log("ignored SIGTERM"); });
process.on("SIGINT", () => { log("ignored SIGINT"); });
process.stdin.on("end", () => {
  log("stdin-end");
  setInterval(() => {}, 60_000);
});`,
      );

      const runtime = await makeStdioRuntime(
        "session-force-close-timeout",
        "hangingTerminate",
        serverPath,
      );

      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      const start = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);

      await retireSessionMcpRuntime({
        sessionId: "session-force-close-timeout",
        reason: "test cleanup",
      });
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  );

  it(
    "completes disposal even when the MCP server process ignores shutdown",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-dispose-timeout-"));
      const serverPath = path.join(tempDir, "hanging-close.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeExecutable(
        serverPath,
        `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) return;
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      const message = JSON.parse(line);
      if (message.method === "initialize") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
            capabilities: { tools: {} },
            serverInfo: { name: "hanging-close-server", version: "1.0.0" },
          },
        });
      } else if (message.method === "tools/list") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }] },
        });
      }
    }
  }
});

// Ignore all shutdown signals — simulate a stuck process
process.on("SIGTERM", () => { log("ignored SIGTERM"); });
process.on("SIGINT", () => { log("ignored SIGINT"); });
process.stdin.on("end", () => {
  log("stdin closed but staying alive");
  // Keep the process alive indefinitely
  setInterval(() => {}, 60_000);
});`,
      );

      const runtime = await makeStdioRuntime("session-dispose-timeout", "hangingClose", serverPath);

      const catalog = await runtime.getCatalog();
      expect(catalog.tools).toHaveLength(1);

      const start = Date.now();
      await runtime.dispose();
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(1_000);

      await fs.rm(tempDir, { recursive: true, force: true });
    },
  );

  it(
    "does not recycle a stateless streamable-http server on HTTP 404",
    { timeout: 15_000 },
    async () => {
      let initializeCount = 0;
      const callSessionIds: Array<string | undefined> = [];
      const server = http.createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body) as {
            id?: number | string;
            method?: string;
            params?: { protocolVersion?: string };
          };
          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          if (message.method === "tools/call") {
            const sessionId = req.headers["mcp-session-id"];
            callSessionIds.push(typeof sessionId === "string" ? sessionId : undefined);
            res.writeHead(404).end("Session not found");
            return;
          }

          res.setHeader("content-type", "application/json");
          if (message.method === "initialize") {
            initializeCount += 1;
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "stateless-404-server", version: "1.0.0" },
                },
              }),
            );
            return;
          }
          if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
            return;
          }
          res.writeHead(405).end();
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      let runtime: SessionMcpRuntime | undefined;

      try {
        runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-stateless-streamable-http-404",
          sessionKey: "agent:test:session-stateless-streamable-http-404",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                stateless: {
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  transport: "streamable-http",
                },
              },
            },
          },
        });

        expect((await runtime.getCatalog()).tools).toHaveLength(1);
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow(
            "Session not found",
          );
        }
        await expect(runtime.callTool("stateless", "probe", {})).rejects.toThrow(
          'bundle-mcp server "stateless" is paused after repeated tool failures',
        );
        expect(initializeCount).toBe(1);
        expect(callSessionIds).toEqual([undefined, undefined, undefined]);
        expect(runtime.peekCatalog()?.diagnostics).toBeUndefined();
      } finally {
        await runtime?.dispose();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it(
    "reconnects a stateful streamable-http server after its session expires",
    { timeout: 15_000 },
    async () => {
      let activeServerSessionId: string | undefined;
      let initializeCount = 0;
      const callAttempts: Array<{ attempt: unknown; sessionId: string | undefined }> = [];
      const staleTerminations: string[] = [];
      const invalidAuthHeaders: Array<string | undefined> = [];

      const server = http.createServer((req, res) => {
        const authHeader = req.headers["x-mcp-recovery"];
        if (authHeader !== "proof") {
          invalidAuthHeaders.push(Array.isArray(authHeader) ? authHeader.join(",") : authHeader);
          res.writeHead(401).end();
          return;
        }
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method === "DELETE") {
          const sessionId = req.headers["mcp-session-id"];
          if (typeof sessionId === "string" && sessionId !== activeServerSessionId) {
            staleTerminations.push(sessionId);
            res.writeHead(404).end("Session not found");
            return;
          }
          res.writeHead(204).end();
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }

        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body) as {
            id?: number | string;
            method?: string;
            params?: { arguments?: { attempt?: unknown }; protocolVersion?: string };
          };
          if (message.method === "initialize") {
            initializeCount += 1;
            activeServerSessionId = `server-session-${initializeCount}`;
            res.setHeader("mcp-session-id", activeServerSessionId);
            res.setHeader("content-type", "application/json");
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "stateful-recovery-server", version: "1.0.0" },
                },
              }),
            );
            return;
          }

          const requestSessionId = req.headers["mcp-session-id"];
          const sessionId = typeof requestSessionId === "string" ? requestSessionId : undefined;
          if (message.method === "tools/call") {
            callAttempts.push({ attempt: message.params?.arguments?.attempt, sessionId });
          }
          if (!sessionId || sessionId !== activeServerSessionId) {
            res.writeHead(404).end("Session not found");
            return;
          }
          if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
            return;
          }
          res.setHeader("mcp-session-id", sessionId);
          res.setHeader("content-type", "application/json");
          if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
            return;
          }
          if (message.method === "tools/call") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  content: [{ type: "text", text: `recovered ${sessionId}` }],
                },
              }),
            );
            return;
          }
          res.writeHead(405).end();
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const address = server.address() as { port: number };
      let runtime: SessionMcpRuntime | undefined;

      try {
        runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-stateful-streamable-http-recovery",
          sessionKey: "agent:test:session-stateful-streamable-http-recovery",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                stateful: {
                  url: `http://127.0.0.1:${address.port}/mcp`,
                  transport: "streamable-http",
                  headers: { "x-mcp-recovery": "proof" },
                },
              },
            },
          },
        });

        expect((await runtime.getCatalog()).tools).toHaveLength(1);
        await expect(
          runtime.callTool("stateful", "probe", { attempt: "before" }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: "recovered server-session-1" }],
        });

        // Restart invalidates the server-side session without closing the HTTP
        // transport. A failed mutating request must never be silently replayed.
        activeServerSessionId = undefined;
        await expect(runtime.callTool("stateful", "probe", { attempt: "expired" })).rejects.toThrow(
          "Session not found",
        );
        expect(runtime.peekCatalog()?.diagnostics).toEqual([
          expect.objectContaining({ serverName: "stateful" }),
        ]);

        await runtime.getCatalog();
        await waitForPredicate(
          () => initializeCount === 2 && !runtime?.peekCatalog()?.diagnostics?.length,
          "stateful MCP server to replace its expired HTTP session",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

        await expect(
          runtime.callTool("stateful", "probe", { attempt: "after" }),
        ).resolves.toMatchObject({
          content: [{ type: "text", text: "recovered server-session-2" }],
        });
        expect(callAttempts).toEqual([
          { attempt: "before", sessionId: "server-session-1" },
          { attempt: "expired", sessionId: "server-session-1" },
          { attempt: "after", sessionId: "server-session-2" },
        ]);
        expect(staleTerminations).toEqual(["server-session-1"]);
        expect(invalidAuthHeaders).toEqual([]);
      } finally {
        await runtime?.dispose();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it(
    "keeps catalog recovery single-flight while another server is recycled",
    { timeout: 15_000 },
    async () => {
      const startServer = async (label: string) => {
        let sessionGeneration = 0;
        let listCount = 0;
        let activeLists = 0;
        let maxActiveLists = 0;
        let hangCalls = true;
        const pendingLists: Array<{
          id: string | number;
          response: http.ServerResponse;
          sessionId: string;
        }> = [];
        const server = http.createServer((request, response) => {
          if (request.method === "GET") {
            response.writeHead(405).end();
            return;
          }
          if (request.method === "DELETE") {
            response.writeHead(204).end();
            return;
          }
          if (request.method !== "POST") {
            response.writeHead(405).end();
            return;
          }
          let body = "";
          request.setEncoding("utf8");
          request.on("data", (chunk) => {
            body += chunk;
          });
          request.on("end", () => {
            const message = JSON.parse(body) as {
              id: string | number;
              method: string;
              params?: { protocolVersion?: string };
            };
            if (message.method === "initialize") {
              sessionGeneration += 1;
              const sessionId = `${label}-${sessionGeneration}`;
              response.setHeader("content-type", "application/json");
              response.setHeader("mcp-session-id", sessionId);
              response.writeHead(200).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                    capabilities: { tools: {} },
                    serverInfo: { name: label, version: "1.0.0" },
                  },
                }),
              );
              return;
            }
            if (message.method === "notifications/initialized") {
              response.writeHead(202).end();
              return;
            }
            const rawSessionId = request.headers["mcp-session-id"];
            const sessionId = typeof rawSessionId === "string" ? rawSessionId : "missing";
            if (message.method === "tools/call") {
              if (hangCalls) {
                return;
              }
              response.setHeader("content-type", "application/json");
              response.setHeader("mcp-session-id", sessionId);
              response.writeHead(200).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: message.id,
                  result: {
                    content: [],
                    structuredContent: { revision: sessionId },
                  },
                }),
              );
              return;
            }
            if (message.method === "tools/list") {
              listCount += 1;
              if (listCount === 1) {
                response.setHeader("content-type", "application/json");
                response.setHeader("mcp-session-id", sessionId);
                response.writeHead(200).end(
                  JSON.stringify({
                    jsonrpc: "2.0",
                    id: message.id,
                    result: {
                      tools: [
                        {
                          name: "probe",
                          inputSchema: { type: "object" },
                          outputSchema: {
                            type: "object",
                            properties: { revision: { const: sessionId } },
                            required: ["revision"],
                          },
                        },
                      ],
                    },
                  }),
                );
                return;
              }
              activeLists += 1;
              maxActiveLists = Math.max(maxActiveLists, activeLists);
              pendingLists.push({ id: message.id, response, sessionId });
            }
          });
        });
        await new Promise<void>((resolve) => {
          server.listen(0, "127.0.0.1", resolve);
        });
        const address = server.address() as { port: number };
        return {
          url: `http://127.0.0.1:${address.port}/mcp`,
          activeLists: () => activeLists,
          maxActiveLists: () => maxActiveLists,
          allowCalls: () => {
            hangCalls = false;
          },
          releaseLists: () => {
            for (const pending of pendingLists.splice(0)) {
              pending.response.setHeader("content-type", "application/json");
              pending.response.setHeader("mcp-session-id", pending.sessionId);
              pending.response.writeHead(200).end(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: pending.id,
                  result: {
                    tools: [
                      {
                        name: "probe",
                        inputSchema: { type: "object" },
                        outputSchema: {
                          type: "object",
                          properties: { revision: { const: pending.sessionId } },
                          required: ["revision"],
                        },
                      },
                    ],
                  },
                }),
              );
              activeLists -= 1;
            }
          },
          close: async () => {
            server.closeAllConnections();
            await new Promise<void>((resolve) => {
              server.close(() => resolve());
            });
          },
        };
      };

      const recovering = await startServer("recovering");
      const trigger = await startServer("trigger");
      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);
      const runtime = createSessionMcpRuntime({
        sessionId: "session-catalog-single-flight",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              recovering: {
                url: recovering.url,
                transport: "streamable-http",
                requestTimeoutMs: 50,
              },
              trigger: {
                url: trigger.url,
                transport: "streamable-http",
                requestTimeoutMs: 50,
              },
            },
          },
        },
      });
      const timeOutServer = async (serverName: string) => {
        for (let attempt = 0; attempt < 3; attempt += 1) {
          await expect(runtime.callTool(serverName, "probe", {})).rejects.toThrow();
        }
      };

      try {
        const initialCatalog = await runtime.getCatalog();
        expect(initialCatalog.tools, JSON.stringify(initialCatalog)).toHaveLength(2);
        await timeOutServer("recovering");
        await runtime.getCatalog();
        await waitForPredicate(
          () => recovering.activeLists() === 1,
          "recovering server catalog request",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

        await timeOutServer("trigger");
        await runtime.getCatalog();
        await Promise.race([
          waitForPredicate(
            () => recovering.maxActiveLists() > 1,
            "overlapping catalog request",
            500,
          ).catch(() => undefined),
          new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
          }),
        ]);
        expect(recovering.maxActiveLists()).toBe(1);

        recovering.allowCalls();
        trigger.allowCalls();
        recovering.releaseLists();
        trigger.releaseLists();
        await waitForPredicate(
          () => recovering.activeLists() === 0 && trigger.activeLists() === 0,
          "catalog requests to complete",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );
        const publishedCatalog = expectDefined(runtime.peekCatalog(), "published catalog");
        expect(publishedCatalog.tools.map((tool) => `${tool.serverName}:${tool.toolName}`)).toEqual(
          ["recovering:probe", "trigger:probe"],
        );
        await expect(runtime.callTool("recovering", "probe", {})).resolves.toMatchObject({
          structuredContent: { revision: expect.stringMatching(/^recovering-/) },
        });
      } finally {
        recovering.releaseLists();
        trigger.releaseLists();
        await runtime.dispose();
        await Promise.all([recovering.close(), trigger.close()]);
      }
    },
  );

  it(
    "force-closes streamable-http transport when DELETE hangs past the timeout",
    { timeout: 15_000 },
    async () => {
      testing.setBundleMcpDisposeTimeoutMsForTest(50);
      const sessionId = "test-session-" + Date.now();
      const server = http.createServer((req, res) => {
        if (req.method === "GET") {
          res.writeHead(405).end();
          return;
        }
        if (req.method === "DELETE") {
          // Never respond — simulates a hung terminateSession() DELETE.
          return;
        }
        if (req.method !== "POST") {
          res.writeHead(405).end();
          return;
        }
        let body = "";
        req.on("data", (chunk: Buffer) => {
          body += chunk.toString();
        });
        req.on("end", () => {
          const message = JSON.parse(body);
          res.setHeader("content-type", "application/json");
          res.setHeader("mcp-session-id", sessionId);
          if (message.method === "initialize") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
                  capabilities: { tools: {} },
                  serverInfo: { name: "hanging-delete-server", version: "1.0.0" },
                },
              }),
            );
          } else if (message.method === "notifications/initialized") {
            res.writeHead(202).end();
          } else if (message.method === "tools/list") {
            res.writeHead(200).end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: message.id,
                result: {
                  tools: [{ name: "probe", description: "probe", inputSchema: { type: "object" } }],
                },
              }),
            );
          } else {
            res.writeHead(200).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
          }
        });
      });

      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const addr = server.address() as { port: number };

      try {
        const runtime = await getOrCreateSessionMcpRuntime({
          sessionId: "session-streamable-http-dispose",
          sessionKey: "agent:test:session-streamable-http-dispose",
          workspaceDir: "/workspace",
          cfg: {
            mcp: {
              servers: {
                hangingDelete: {
                  url: `http://127.0.0.1:${addr.port}/mcp`,
                  transport: "streamable-http",
                },
              },
            },
          },
        });

        const catalog = await runtime.getCatalog();
        expect(catalog.tools).toHaveLength(1);

        const start = Date.now();
        await runtime.dispose();
        const elapsed = Date.now() - start;

        expect(elapsed).toBeLessThan(1_000);
      } finally {
        server.close();
      }
    },
  );

  it(
    "starts MCP server catalog loading concurrently",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async () => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-parallel-");
      const releasePath = path.join(tempDir, "release-list-tools");
      const serverPaths = Array.from({ length: 3 }, (_, i) => {
        const serverPath = path.join(tempDir, `slow-server-${i}.mjs`);
        const logPath = path.join(tempDir, `server-${i}.log`);
        return { serverPath, logPath, serverName: `slowServer${i}` };
      });

      await Promise.all(
        serverPaths.map(({ serverPath, logPath }) =>
          writeListToolsMcpServer({
            filePath: serverPath,
            logPath,
            listToolsReleasePath: releasePath,
          }),
        ),
      );

      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-parallel-catalog-test",
        sessionKey: "agent:test:session-parallel-catalog-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: Object.fromEntries(
              serverPaths.map(({ serverName, serverPath }) => [
                serverName,
                {
                  command: process.execPath,
                  args: [serverPath],
                  connectionTimeoutMs: 2_000,
                },
              ]),
            ),
          },
        },
      });

      const catalogPromise = runtime.getCatalog();
      try {
        await Promise.all(
          serverPaths.map(({ logPath }) =>
            waitForFileText(logPath, "tools/list cursor", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS),
          ),
        );
        await fs.writeFile(releasePath, "released", "utf8");
        const catalog = await catalogPromise;

        expect(Object.keys(catalog.servers)).toHaveLength(serverPaths.length);
        expect(catalog.tools.map((t) => t.toolName)).toEqual([
          "slow_tool",
          "slow_tool",
          "slow_tool",
        ]);
      } finally {
        await fs.writeFile(releasePath, "released", "utf8").catch(() => {});
        await catalogPromise.catch(() => {});
        await runtime.dispose();
      }
    },
  );

  it(
    "awaits in-progress MCP session connections after catalog invalidation",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async () => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-inflight-connect-");
      const invalidatingServer = {
        serverName: "invalidatingServer",
        serverPath: path.join(tempDir, "invalidating-server.mjs"),
        logPath: path.join(tempDir, "invalidating-server.log"),
      };
      const slowConnectServer = {
        serverName: "slowConnectServer",
        serverPath: path.join(tempDir, "slow-connect-server.mjs"),
        logPath: path.join(tempDir, "slow-connect-server.log"),
      };

      await writeListToolsMcpServer({
        filePath: invalidatingServer.serverPath,
        logPath: invalidatingServer.logPath,
        capabilities: { tools: { listChanged: true } },
        notifyListChangedOnInitialized: true,
      });
      await writeListToolsMcpServer({
        filePath: slowConnectServer.serverPath,
        logPath: slowConnectServer.logPath,
        initializeDelayMs: 200,
      });

      testing.setBundleMcpCatalogListTimeoutMsForTest(4_000);

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-inflight-connect-test",
        sessionKey: "agent:test:session-inflight-connect-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: Object.fromEntries(
              [invalidatingServer, slowConnectServer].map(({ serverName, serverPath }) => [
                serverName,
                {
                  command: process.execPath,
                  args: [serverPath],
                  connectionTimeoutMs: 2_000,
                },
              ]),
            ),
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
        await waitForFileText(
          invalidatingServer.logPath,
          "notify tools/list_changed",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

        const secondCatalog = await runtime.getCatalog();
        await firstCatalog;

        expect(Object.keys(secondCatalog.servers).toSorted()).toEqual([
          invalidatingServer.serverName,
          slowConnectServer.serverName,
        ]);
        expect(secondCatalog.diagnostics ?? []).toEqual([]);
      } finally {
        await runtime.dispose();
      }
    },
  );

  it(
    "retires timed-out shared MCP sessions before later catalog retries",
    { timeout: 8_000 },
    async () => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-timeout-retire-");
      const triggerServerPath = path.join(tempDir, "trigger-server.mjs");
      const triggerLogPath = path.join(tempDir, "trigger.log");
      const slowServerPath = path.join(tempDir, "slow-server.mjs");
      const slowLogPath = path.join(tempDir, "slow.log");
      const firstConnectMarkerPath = path.join(tempDir, "first-connect.marker");

      await writeExecutable(
        triggerServerPath,
        `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(triggerLogPath)};
let buffer = "";
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "timeout-trigger", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    log("sent initial tools/list_changed");
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "poke", inputSchema: { type: "object", properties: {} } }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    log("sent call tools/list_changed");
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: false, content: [{ type: "text", text: "poked" }] },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
      );

      await writeExecutable(
        slowServerPath,
        `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(slowLogPath)};
const markerPath = ${JSON.stringify(firstConnectMarkerPath)};
let buffer = "";
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
async function claimFirstConnect() {
  try {
    await fs.writeFile(markerPath, String(process.pid), { flag: "wx" });
    return true;
  } catch {
    return false;
  }
}
const firstConnect = await claimFirstConnect();
async function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    const response = {
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "timeout-slow", version: "1.0.0" },
      },
    };
    if (firstConnect) {
      log("slow first initialize");
      return;
    }
    log("fast retry initialize");
    send(response);
    return;
  }
  if (message.method === "tools/list") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "slow_tool", inputSchema: { type: "object", properties: {} } }],
      },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      void handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
      );

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-timeout-retire-test",
        sessionKey: "agent:test:session-timeout-retire-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              trigger: {
                command: process.execPath,
                args: [triggerServerPath],
                connectionTimeoutMs: 2_000,
              },
              slow: {
                command: process.execPath,
                args: [slowServerPath],
                connectionTimeoutMs: 1_000,
              },
            },
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
        await waitForFileText(firstConnectMarkerPath, "", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
        await waitForFileText(
          triggerLogPath,
          "sent initial tools/list_changed",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

        const secondCatalogPromise = runtime.getCatalog();
        const [firstCatalogResult, secondCatalog] = await Promise.all([
          firstCatalog,
          secondCatalogPromise,
        ]);

        // The notification refresh is serialized after the timed-out first generation,
        // so callers now receive the newest clean catalog rather than its stale diagnostic.
        expect(firstCatalogResult.servers.slow).toBeDefined();
        expect(secondCatalog.servers.trigger).toBeDefined();
        expect(secondCatalog.servers.slow).toBeDefined();
        await expect(runtime.callTool("trigger", "poke", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "poked" }],
          isError: false,
        });
        await waitForFileText(
          triggerLogPath,
          "sent call tools/list_changed",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );
        await waitForPredicate(
          () => runtime.peekCatalog() === null,
          "manual list_changed to retry timed-out server",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

        const retriedCatalog = await runtime.getCatalog();

        expect(retriedCatalog.diagnostics ?? []).toEqual([]);
        expect(retriedCatalog.servers.slow).toBeDefined();
        expect(retriedCatalog.tools.map((tool) => tool.toolName).toSorted()).toEqual([
          "poke",
          "slow_tool",
        ]);
        await waitForFileText(
          slowLogPath,
          "fast retry initialize",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );
      } finally {
        await runtime.dispose();
      }
    },
  );

  it(
    "serializes invalidated catalog generations on one session",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS * 2 },
    async () => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-overlap-generation-");
      const serverPath = path.join(tempDir, "overlap-server.mjs");
      const logPath = path.join(tempDir, "server.log");

      await writeExecutable(
        serverPath,
        `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(logPath)};
let buffer = "";
let listCount = 0;
function log(line) {
  void fs.appendFile(logPath, line + "\\n", "utf8").catch(() => {});
}
function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}
function handle(message) {
  if (!message || typeof message !== "object") {
    return;
  }
  log("recv " + String(message.method ?? "unknown"));
  if (message.method === "initialize") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-03-26",
        capabilities: { tools: { listChanged: true } },
        serverInfo: { name: "overlap-generation", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
    log("sent tools/list_changed");
    return;
  }
  if (message.method === "tools/list") {
    listCount += 1;
    const currentList = listCount;
    log("tools/list " + currentList);
    if (currentList === 1) {
      setTimeout(() => {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            tools: [{ name: "ok_tool", inputSchema: [] }],
          },
        });
      }, 100);
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        tools: [{ name: "ok_tool", inputSchema: { type: "object", properties: {} } }],
      },
    });
    return;
  }
  if (message.method === "tools/call") {
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { isError: false, content: [{ type: "text", text: "still connected" }] },
    });
  }
}
process.stdin.setEncoding("utf8");
function shutdown() {
  process.exit(0);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf("\\n");
    if (newline < 0) {
      return;
    }
    const line = buffer.slice(0, newline).replace(/\\r$/, "");
    buffer = buffer.slice(newline + 1);
    if (line.trim()) {
      handle(JSON.parse(line));
    }
  }
});
process.stdin.on("end", shutdown);
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);`,
      );

      const runtime = await makeStdioRuntime(
        "session-overlap-generation-test",
        "overlap",
        serverPath,
      );

      try {
        const firstCatalog = runtime.getCatalog();
        await waitForFileText(logPath, "sent tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
        await waitForFileText(logPath, "tools/list 1", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);

        const secondCatalog = await runtime.getCatalog();
        const firstCatalogResult = await firstCatalog;

        expect(firstCatalogResult.diagnostics ?? []).toEqual([]);
        expect(firstCatalogResult.tools.map((tool) => tool.toolName)).toEqual(["ok_tool"]);
        expect(secondCatalog.diagnostics ?? []).toEqual([]);
        expect(secondCatalog.tools.map((tool) => tool.toolName)).toEqual(["ok_tool"]);

        await expect(runtime.callTool("overlap", "ok_tool", {})).resolves.toMatchObject({
          content: [{ type: "text", text: "still connected" }],
          isError: false,
        });
      } finally {
        await runtime.dispose();
      }
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
