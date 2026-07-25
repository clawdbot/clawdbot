/** Tests session-scoped MCP runtime catalog, transport, validation, and lifecycle behavior. */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withTestTimeout } from "../../test/helpers/promise.js";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  completeDeferredSessionMcpRuntimeRetirement,
  createBundleMcpJsonSchemaValidator,
  createSessionMcpRuntime,
  testing,
} from "./agent-bundle-mcp-runtime.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
} from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";
import { updateMcpAppModelContext } from "./mcp-app-model-context.js";

vi.mock("./embedded-agent-mcp.js", () => ({
  loadEmbeddedAgentMcpConfig: (params: {
    cfg?: { mcp?: { servers?: Record<string, unknown> } };
  }) => ({
    diagnostics: [],
    mcpServers: params.cfg?.mcp?.servers ?? {},
  }),
}));

const tempDirs: string[] = [];
const appMetadataTempDirs = useAutoCleanupTempDirTracker(afterEach);

type RuntimeFactoryOptions = NonNullable<
  Parameters<typeof testing.createSessionMcpRuntimeManager>[0]
>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;
const LIST_TOOLS_SERVER_LOG_TIMEOUT_MS = 2_000;
const LIST_TOOLS_TEST_DEADLINE_MS = 4_000;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

async function writeListToolsMcpServer(params: {
  filePath: string;
  logPath: string;
  delayMs?: number;
  initializeDelayMs?: number;
  hang?: boolean;
  inputSchema?: unknown;
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
    _meta?: Record<string, unknown>;
  }>;
  capabilities?: Record<string, unknown>;
  databasePath?: string;
  pidPath?: string;
  notifyListChangedOnInitialized?: boolean;
  notifyListChangedAfterFirstList?: boolean;
  exitOnListCall?: number;
  listToolsMethodNotFound?: boolean;
  listToolsJsonRpcErrorMessage?: string;
  callToolIsError?: boolean;
  callToolJsonRpcError?: boolean;
  resourceListJsonRpcError?: boolean;
  resourceReadJsonRpcError?: boolean;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(params.logPath)};
const delayMs = ${params.delayMs ?? 0};
const initializeDelayMs = ${params.initializeDelayMs ?? 0};
const hang = ${params.hang === true};
const capabilities = ${JSON.stringify(params.capabilities ?? { tools: {} })};
const databasePath = ${JSON.stringify(params.databasePath)};
const pidPath = ${JSON.stringify(params.pidPath)};
const notifyListChangedOnInitialized = ${params.notifyListChangedOnInitialized === true};
const notifyListChangedAfterFirstList = ${params.notifyListChangedAfterFirstList === true};
const exitOnListCall = ${params.exitOnListCall ?? 0};
const listToolsMethodNotFound = ${params.listToolsMethodNotFound === true};
const listToolsJsonRpcErrorMessage = ${JSON.stringify(params.listToolsJsonRpcErrorMessage)};
const tools = ${JSON.stringify(
      params.tools ?? [
        {
          name: "slow_tool",
          description: "Returned after a slow catalog response.",
          inputSchema: params.inputSchema ?? { type: "object", properties: {} },
        },
      ],
    )};
const callToolIsError = ${params.callToolIsError === true};
const callToolJsonRpcError = ${params.callToolJsonRpcError === true};
const resourceListJsonRpcError = ${params.resourceListJsonRpcError === true};
const resourceReadJsonRpcError = ${params.resourceReadJsonRpcError === true};

let buffer = "";
let listCount = 0;
let pendingTimer;
let keepAlive;
let database;
if (databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  database = new DatabaseSync(databasePath);
  database.exec("PRAGMA busy_timeout = 0; CREATE TABLE IF NOT EXISTS lock_probe (value TEXT); BEGIN IMMEDIATE; INSERT INTO lock_probe VALUES ('held')");
}
if (pidPath) {
  await fs.writeFile(pidPath, String(process.pid), "utf8");
}
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
    log("delay tools/list " + delayMs);
    pendingTimer = setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools,
        },
      });
      if (notifyListChangedAfterFirstList && currentListCount === 1) {
        log("notify tools/list_changed");
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      }
    }, delayMs);
  }
  if (message.method === "tools/call") {
    if (callToolJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "tool request failed" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: {
        isError: callToolIsError,
        content: [{ type: "text", text: callToolIsError ? "tool failed" : "tool ok" }],
      },
    });
  }
  if (message.method === "resources/list") {
    if (resourceListJsonRpcError) {
      send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "resource request failed" },
      });
      return;
    }
    send({
      jsonrpc: "2.0",
      id: message.id,
      result: { resources: [] },
    });
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
      result: { contents: [{ uri: message.params?.uri, text: "resource ok" }] },
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
  predicate: () => boolean,
  description: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function waitForErrorMessage(
  action: () => Promise<unknown>,
  expectedText: string,
  timeoutMs: number,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let lastMessage = "";
  while (Date.now() < deadline) {
    try {
      await action();
    } catch (error) {
      lastMessage = error instanceof Error ? error.message : String(error);
      if (lastMessage.includes(expectedText)) {
        return lastMessage;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
  }
  throw new Error(`Timed out waiting for ${expectedText}; saw ${JSON.stringify(lastMessage)}`);
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
    const tempDir = appMetadataTempDirs.make("bundle-mcp-app-metadata-");
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-slow-listtools-server-timeout",
      sessionKey: "agent:test:session-slow-listtools-server-timeout",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            slowListTools: {
              command: process.execPath,
              args: [serverPath],
              connectionTimeoutMs: 1_000,
            },
          },
        },
      },
    });

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

  it("times out default-config hung bundle MCP tools/list using the internal catalog timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-timeout-"));
    const serverPath = path.join(tempDir, "hanging-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(50);
    await writeListToolsMcpServer({ filePath: serverPath, logPath, hang: true });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-listtools-server-timeout",
      sessionKey: "agent:test:session-listtools-server-timeout",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            hangingListTools: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-invalid-schema",
      sessionKey: "agent:test:session-invalid-schema",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            fuzzplugin: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-diagnostic-redaction",
      sessionKey: "agent:test:session-diagnostic-redaction",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            diagnostic: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();
      const diagnostic = catalog.diagnostics?.[0];
      expect(diagnostic?.serverName).toBe("diagnostic");
      expect(diagnostic?.message).toContain("Authorization: Bearer ");
      expect(diagnostic?.message).toContain("…");
      expect(diagnostic?.message).not.toContain(secret);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-tool-filter",
      sessionKey: "agent:test:session-tool-filter",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            docs: {
              command: process.execPath,
              args: [serverPath],
              toolFilter: {
                include: ["*_docs", "admin_*"],
                exclude: ["admin_*"],
              },
            },
          },
        },
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-utf16-metadata",
      sessionKey: "agent:test:session-utf16-metadata",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            metadata: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toHaveLength(1);
      expect(catalog.tools[0]?.description).toBe(`${safePrefix}...`);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects adversarial MCP tool filters without regex backtracking", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-linear-filter-"));
    const serverPath = path.join(tempDir, "linear-filter.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      tools: [
        {
          name: `${"a".repeat(64)}c`,
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-linear-tool-filter",
      sessionKey: "agent:test:session-linear-tool-filter",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            docs: {
              command: process.execPath,
              args: [serverPath],
              toolFilter: { include: [`${"*a".repeat(24)}*b`] },
            },
          },
        },
      },
    });

    try {
      expect((await runtime.getCatalog()).tools).toEqual([]);
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-unadvertised-tools",
      sessionKey: "agent:test:session-unadvertised-tools",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            legacy: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-refresh-diagnostic",
      sessionKey: "agent:test:session-refresh-diagnostic",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            volatile: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
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

  it("fails fast with an attributable error after an MCP child process exits", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-child-exit-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    await writeListToolsMcpServer({ filePath: serverPath, logPath, pidPath });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-child-exit",
      sessionKey: "agent:test:session-child-exit",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            child: { command: process.execPath, args: [serverPath] },
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
      process.kill(pid);

      const message = await waitForErrorMessage(
        () => runtime.callTool("child", "slow_tool", {}),
        "is disconnected",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );
      expect(message).toBe('bundle-mcp server "child" is disconnected: mcp transport closed');
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("retires a reused MCP session that exits during catalog refresh", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-refresh-exit-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { tools: { listChanged: true } },
      notifyListChangedAfterFirstList: true,
      exitOnListCall: 2,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-refresh-exit",
      sessionKey: "agent:test:session-refresh-exit",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            child: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });

    try {
      expect((await runtime.getCatalog()).tools).toHaveLength(1);
      await waitForFileText(logPath, "notify tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      await waitForPredicate(
        () => runtime.peekCatalog() === null,
        "list_changed to invalidate the catalog",
        LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
      );

      const refreshedCatalog = await runtime.getCatalog();
      expect(refreshedCatalog.tools).toEqual([]);
      expect(refreshedCatalog.diagnostics?.[0]?.serverName).toBe("child");
      await expect(runtime.callTool("child", "slow_tool", {})).rejects.toThrow(
        'bundle-mcp server "child" is not connected',
      );
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-inflight-invalidated",
      sessionKey: "agent:test:session-inflight-invalidated",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            changing: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

    try {
      const firstCatalog = await runtime.getCatalog();
      expect(firstCatalog.tools.map((tool) => tool.toolName)).toEqual(["old_tool"]);
      await waitForFileText(logPath, "sent tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
      expect(runtime.peekCatalog()).toBeNull();

      const secondCatalog = await runtime.getCatalog();
      expect(secondCatalog.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);
      expect(runtime.peekCatalog()?.tools.map((tool) => tool.toolName)).toEqual(["new_tool"]);
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("keeps resource-only MCP servers available for utility tools", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-resource-only-"));
    const serverPath = path.join(tempDir, "resource-only.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      capabilities: { resources: { listChanged: true } },
      listToolsMethodNotFound: true,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-resource-only",
      sessionKey: "agent:test:session-resource-only",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            notes: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

    try {
      const catalog = await runtime.getCatalog();

      expect(catalog.tools).toEqual([]);
      expect(catalog.servers.notes).toMatchObject({
        serverName: "notes",
        toolCount: 0,
        resources: { listChanged: true },
      });
      await waitForFileText(logPath, "recv initialize", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-error-backoff",
      sessionKey: "agent:test:session-error-backoff",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            failing: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

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

  it("pauses MCP servers after repeated tool request failures", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-request-failure-backoff-"));
    const serverPath = path.join(tempDir, "request-failure-backoff.mjs");
    const logPath = path.join(tempDir, "server.log");
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      callToolJsonRpcError: true,
    });

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-request-failure-backoff",
      sessionKey: "agent:test:session-request-failure-backoff",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            failing: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-utility-failure-backoff",
      sessionKey: "agent:test:session-utility-failure-backoff",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            failing: {
              command: process.execPath,
              args: [serverPath],
            },
          },
        },
      },
    });

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

    const runtime = await getOrCreateSessionMcpRuntime({
      sessionId: "session-preview-failure",
      sessionKey: "agent:test:session-preview-failure",
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            failing: { command: process.execPath, args: [serverPath] },
          },
        },
      },
    });

    try {
      if (!runtime.readResource) {
        throw new Error("Expected test runtime to expose resource utilities");
      }
      for (let index = 0; index < 3; index += 1) {
        await expect(
          runtime.readResource("failing", "ui://demo/app", { failureBackoff: "ignore" }),
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
      const runtime = makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]);
      created.push(runtime);
      return {
        ...runtime,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
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
      const runtime = makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]);
      return {
        ...runtime,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        agentDir: params.agentDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
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
      const base = makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]);
      let cachedCatalog: ReturnType<SessionMcpRuntime["peekCatalog"]> = null;
      return {
        ...base,
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
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
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
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
      ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
      sessionId: params.sessionId,
      sessionKey: params.sessionKey,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
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

  it("keeps an active MCP child and its database lock until deferred retirement completes", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-deferred-run-"));
    const serverPath = path.join(tempDir, "server.mjs");
    const logPath = path.join(tempDir, "server.log");
    const pidPath = path.join(tempDir, "server.pid");
    const databasePath = path.join(tempDir, "locked.sqlite");
    await writeListToolsMcpServer({ filePath: serverPath, logPath, pidPath, databasePath });
    let materialized: Awaited<ReturnType<typeof materializeBundleMcpToolsForRun>> | undefined;
    let lockProbe: DatabaseSync | undefined;

    try {
      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-run-child",
        sessionKey: "agent:test:session-run-child",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              child: { command: process.execPath, args: [serverPath] },
            },
          },
        },
      });
      materialized = await materializeBundleMcpToolsForRun({ runtime });
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
      lockProbe?.close();
      await materialized?.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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
      sessionId: "session-shared",
      sessionKey: "agent:test:session-shared",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
      agentAccountId: "bot-1",
    });
    await manager.getOrCreate({
      sessionId: "session-shared",
      sessionKey: "agent:test:session-shared",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
      agentAccountId: "bot-1",
    });
    await manager.getOrCreate({
      sessionId: "session-shared",
      sessionKey: "agent:test:session-shared",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-b",
      messageChannel: "telegram",
      agentAccountId: "bot-1",
    });

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
    const cfg = {
      mcp: {
        servers: {
          shared: { command: "true" },
          "user-mail": { transport: "streamable-http", url: "https://static.example.test" },
        },
      },
    };

    // Static-only config: the summary must match the bare runtime byte-for-byte.
    const staticRuntime = await manager.getOrCreate({
      sessionId: "session-parity-static",
      workspaceDir: "/workspace",
      cfg: cfg as never,
    });
    expect(
      resolveSessionMcpConfigSummary({ workspaceDir: "/workspace", cfg: cfg as never }).fingerprint,
    ).toBe(staticRuntime.configFingerprint);

    // With a resolver registered, tools.effective peeks the bare static-partition
    // runtime; summary parity keeps it from reporting stale-config forever.
    resolverTesting.setMcpServerConnectionResolversForTest([
      { serverName: "user-mail", resolve: async () => null },
    ]);
    await manager.getOrCreate({
      sessionId: "session-parity-scoped",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
    });
    const peeked = manager.peekSession({ sessionId: "session-parity-scoped" });
    expect(peeked?.configFingerprint).toBe(
      resolveSessionMcpConfigSummary({ workspaceDir: "/workspace", cfg: cfg as never }).fingerprint,
    );

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

    const createRuntime: RuntimeFactory = (params) => ({
      ...makeRuntime([{ toolName: "probe", description: "probe" }]),
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
      requesterScope: params.requesterScope,
    });
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    await manager.getOrCreate({
      sessionId: "session-resolve-once",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    await manager.getOrCreate({
      sessionId: "session-resolve-once",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
      };
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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
      };
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
    await manager.getOrCreate({
      sessionId: "session-fail-closed",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "denied",
      messageChannel: "slack",
    });
    await manager.getOrCreate({
      sessionId: "session-fail-closed",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "allowed",
      messageChannel: "slack",
    });

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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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

    await manager.getOrCreate({
      sessionId: "session-fingerprint",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "alice",
      messageChannel: "telegram",
    });
    await manager.getOrCreate({
      sessionId: "session-fingerprint",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "bob",
      messageChannel: "telegram",
    });
    await manager.getOrCreate({
      sessionId: "session-fingerprint",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "alice",
      messageChannel: "telegram",
    });

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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
      };
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
    const pending = manager.getOrCreate({
      sessionId: "session-timeout",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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

    await manager.getOrCreate({
      sessionId: "session-partial",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(createdIncludes).toEqual([["mail-a"]]);

    await manager.getOrCreate({
      sessionId: "session-partial",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
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
      const base = makeRuntime([{ toolName, description: toolName }], serverName);
      return {
        ...base,
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
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

  it("evicts LRU idle requester runtimes past the per-session cap", async () => {
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
      const base = makeRuntime([{ toolName: "probe", description: "probe" }]);
      // Distinct ascending lastUsedAt per runtime so LRU ordering is deterministic.
      const lastUsedAt = (syntheticLastUsedAt += 1_000);
      return {
        ...base,
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
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
      await manager.getOrCreate({
        sessionId: "session-cap",
        workspaceDir: "/workspace",
        cfg: cfg as never,
        requesterSenderId: sender,
        messageChannel: "telegram",
      });
    }

    // sender-a is the least recently used zero-lease scoped runtime.
    expect(disposedSenders).toEqual(["sender-a"]);
    // Bare static reconcile key + two newest requester keys survive.
    expect(manager.listRuntimeKeys()).toHaveLength(3);

    await manager.disposeAll();
  });

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
        ...makeRuntime([{ toolName: "unused", description: "unused" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
        peekCatalog: () => current,
        getCatalog: async () => current,
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
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
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

    await manager.getOrCreate({
      sessionId: "session-revoke",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(manager.listRuntimeKeys().some((key) => key.startsWith("{"))).toBe(true);

    allow = false;
    nowMs += 2_000;
    const after = await manager.getOrCreate({
      sessionId: "session-revoke",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

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

    const createRuntime: RuntimeFactory = (params) => ({
      ...makeRuntime([{ toolName: "probe", description: "probe" }]),
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
      requesterScope: params.requesterScope,
    });
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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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

    const first = manager.getOrCreate({
      sessionId: "session-serialize",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });

    const second = manager.getOrCreate({
      sessionId: "session-serialize",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });

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
      createRuntime: (params) => ({
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      }),
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
      idleTtl: 0,
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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
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
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    await manager.getOrCreate({
      sessionId: "session-revalidate",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(resolveCalls).toBe(1);
    expect(createCount).toBe(2); // empty static + requester

    // Within revalidation window: no resolver call.
    nowMs += 500;
    await manager.getOrCreate({
      sessionId: "session-revalidate",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(resolveCalls).toBe(1);
    expect(createCount).toBe(2);

    // Past window, unchanged credentials: resolve once, no rebuild.
    nowMs += 1_000;
    await manager.getOrCreate({
      sessionId: "session-revalidate",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(resolveCalls).toBe(2);
    expect(createCount).toBe(2);

    // Past window with rotated header: rebuild requester runtime.
    token = "secret-token";
    nowMs += 1_000;
    await manager.getOrCreate({
      sessionId: "session-revalidate",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
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
        ...makeRuntime([{ toolName: "send", description: "send" }], serverName),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
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

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-safe-names",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    resolveBoth = false;
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-safe-names",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-b",
      messageChannel: "telegram",
    });

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

    await manager.disposeAll();
  });

  it("reconciles a stale bare runtime when every server becomes requester-scoped", async () => {
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => ({
      ...makeRuntime([{ toolName: "probe", description: "probe" }]),
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
      requesterScope: params.requesterScope,
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
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }]),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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

  it("getOrCreateRequesterScoped returns undefined without senderId and never creates static transports", async () => {
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
    const createRuntime: RuntimeFactory = (params) => {
      created.push({
        requesterScope: params.requesterScope,
        include: params.includeServerNames ? [...params.includeServerNames] : undefined,
        exclude: params.excludeServerNames ? [...params.excludeServerNames] : undefined,
      });
      return {
        ...makeRuntime([{ toolName: "probe", description: "probe" }], "user-mail"),
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
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
      manager.getOrCreateRequesterScoped({
        sessionId: "session-scoped-only",
        workspaceDir: "/workspace",
        cfg: cfg as never,
      }),
    ).resolves.toBeUndefined();
    expect(created).toEqual([]);

    const scoped = await manager.getOrCreateRequesterScoped({
      sessionId: "session-scoped-only",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(scoped?.requesterScope?.requesterSenderId).toBe("sender-a");
    // Only the requester partition — no bare static runtime entry.
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
    expect(manager.listRuntimeKeys().every((key) => key.startsWith("{"))).toBe(true);

    await manager.disposeAll();
  });

  it("reuses requester cache keys for getOrCreateRequesterScoped", async () => {
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
    const createRuntime: RuntimeFactory = (params) => ({
      ...makeRuntime([{ toolName: "probe", description: "probe" }], "user-mail"),
      sessionId: params.sessionId,
      workspaceDir: params.workspaceDir,
      configFingerprint: params.configFingerprint ?? "fingerprint",
      requesterScope: params.requesterScope,
    });
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    const first = await manager.getOrCreateRequesterScoped({
      sessionId: "session-reuse",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    const second = await manager.getOrCreateRequesterScoped({
      sessionId: "session-reuse",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "sender-a",
      messageChannel: "telegram",
    });
    expect(first).toBe(second);
    expect(resolveCount).toBe(1);
    expect(manager.listRuntimeKeys()).toHaveLength(1);

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
    const createRuntime: RuntimeFactory = (params) => {
      const runtime = makeRuntime([{ toolName: "inbox", description: "read inbox" }], "user-mail");
      return {
        ...runtime,
        sessionId: params.sessionId,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        requesterScope: params.requesterScope,
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({ createRuntime });
    const cfg = {
      mcp: {
        servers: {
          "user-mail": { transport: "streamable-http" },
        },
      },
    };

    expect(manager.getAdvertisedScopedCatalog("session-adv")).toBeNull();

    const authed = await manager.getOrCreateRequesterScoped({
      sessionId: "session-adv",
      workspaceDir: "/workspace",
      cfg: cfg as never,
      requesterSenderId: "authed",
      messageChannel: "telegram",
    });
    expect(authed).toBeDefined();
    const catalog = await authed!.getCatalog();
    manager.rememberAdvertisedScopedCatalog("session-adv", catalog);

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

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-force-close-timeout",
        sessionKey: "agent:test:session-force-close-timeout",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              hangingTerminate: {
                command: process.execPath,
                args: [serverPath],
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

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-dispose-timeout",
        sessionKey: "agent:test:session-dispose-timeout",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              hangingClose: {
                command: process.execPath,
                args: [serverPath],
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

      await fs.rm(tempDir, { recursive: true, force: true });
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
    "parallelizes MCP server catalog loading across multiple slow servers",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
    async () => {
      const tempDir = makeTempDir(tempDirs, "bundle-mcp-parallel-");
      const delays = [200, 400, 600];
      const serverPaths = delays.map((delay, i) => {
        const serverPath = path.join(tempDir, `slow-server-${i}.mjs`);
        const logPath = path.join(tempDir, `server-${i}.log`);
        return { serverPath, logPath, delay, serverName: `slowServer${i}` };
      });

      await Promise.all(
        serverPaths.map(({ serverPath, logPath, delay }) =>
          writeListToolsMcpServer({ filePath: serverPath, logPath, delayMs: delay }),
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

      try {
        const sumDelays = delays.reduce((a, b) => a + b, 0);
        const maxDelay = Math.max(...delays);
        const parallelBudgetMs = maxDelay + 500;

        const t0 = performance.now();
        const catalog = await runtime.getCatalog();
        const wallTime = performance.now() - t0;

        // Must have successfully connected to all servers
        expect(Object.keys(catalog.servers)).toHaveLength(delays.length);
        expect(catalog.tools.map((t) => t.toolName)).toEqual([
          "slow_tool",
          "slow_tool",
          "slow_tool",
        ]);

        // Sequential listing would have to wait roughly sumDelays before overhead;
        // parallel listing should stay near the slowest server plus launch overhead.
        expect(wallTime).toBeLessThan(parallelBudgetMs);
        expect(parallelBudgetMs).toBeLessThan(sumDelays);

        expect(wallTime).toBeGreaterThanOrEqual(maxDelay * 0.7);
      } finally {
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
async function isFirstConnect() {
  try {
    const handle = await fs.open(markerPath, "wx");
    await handle.close();
    return true;
  } catch {
    return false;
  }
}
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
    if (await isFirstConnect()) {
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
                connectionTimeoutMs: 150,
              },
            },
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
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

        const firstSlowDiagnostic = firstCatalogResult.diagnostics?.find(
          (diag) => diag.serverName === "slow",
        );
        expect(firstSlowDiagnostic?.message).toContain("timed out");
        expect(firstCatalogResult.servers.slow).toBeUndefined();
        expect(secondCatalog.servers.trigger).toBeDefined();
        const secondSlowDiagnostic = secondCatalog.diagnostics?.find(
          (diag) => diag.serverName === "slow",
        );
        // A loaded runner can let generation one retire the timed-out client before
        // generation two adopts it. Both the shared timeout and fast replacement are valid.
        if (secondSlowDiagnostic) {
          expect(secondSlowDiagnostic.message).toContain("timed out");
          expect(secondCatalog.servers.slow).toBeUndefined();
        } else {
          expect(secondCatalog.servers.slow).toBeDefined();
        }
        await waitForFileText(
          slowLogPath,
          "slow first initialize",
          LIST_TOOLS_SERVER_LOG_TIMEOUT_MS,
        );

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
    "does not dispose sessions shared with a newer catalog generation",
    { timeout: LIST_TOOLS_TEST_DEADLINE_MS },
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

      const runtime = await getOrCreateSessionMcpRuntime({
        sessionId: "session-overlap-generation-test",
        sessionKey: "agent:test:session-overlap-generation-test",
        workspaceDir: "/workspace",
        cfg: {
          mcp: {
            servers: {
              overlap: {
                command: process.execPath,
                args: [serverPath],
              },
            },
          },
        },
      });

      try {
        const firstCatalog = runtime.getCatalog();
        await waitForFileText(logPath, "sent tools/list_changed", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);
        await waitForFileText(logPath, "tools/list 1", LIST_TOOLS_SERVER_LOG_TIMEOUT_MS);

        const secondCatalog = await runtime.getCatalog();
        const firstCatalogResult = await firstCatalog;

        expect(firstCatalogResult.diagnostics?.[0]?.serverName).toBe("overlap");
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
