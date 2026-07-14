/** Tests session-scoped MCP runtime catalog, transport, validation, and lifecycle behavior. */
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../../test/helpers/temp-dir.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  completeDeferredSessionMcpRuntimeRetirement,
  createBundleMcpJsonSchemaValidator,
  createSessionMcpRuntime,
} from "./agent-bundle-mcp-runtime.js";
import { cleanupBundleMcpHarness } from "./agent-bundle-mcp-test-harness.js";
import {
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
  testing,
} from "./agent-bundle-mcp-tools.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";
import { writeExecutable } from "./bundle-mcp-shared.test-harness.js";

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
  pidPath?: string;
  notifyListChangedOnInitialized?: boolean;
  notifyListChangedAfterFirstList?: boolean;
  exitOnListCall?: number;
  listToolsMethodNotFound?: boolean;
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
const pidPath = ${JSON.stringify(params.pidPath)};
const notifyListChangedOnInitialized = ${params.notifyListChangedOnInitialized === true};
const notifyListChangedAfterFirstList = ${params.notifyListChangedAfterFirstList === true};
const exitOnListCall = ${params.exitOnListCall ?? 0};
const listToolsMethodNotFound = ${params.listToolsMethodNotFound === true};
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
  await cleanupBundleMcpHarness();
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
      const result = await Promise.race([
        catalogResult,
        new Promise<{ status: "pending" }>((resolve) => {
          setTimeout(() => resolve({ status: "pending" }), LIST_TOOLS_TEST_DEADLINE_MS);
        }),
      ]);

      expect(result.status).toBe("resolved");
      if (result.status === "resolved") {
        expect(result.catalog.tools).toEqual([]);
        expect(result.catalog.servers).toEqual({});
      }
    } finally {
      await runtime.dispose();
      await Promise.race([
        catalogResult,
        new Promise((resolve) => {
          setTimeout(resolve, 1000);
        }),
      ]);
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
      cfg: { mcp: { sessionIdleTtlMs: 0 } },
    });
    const release = runtime.acquireLease?.();

    await expect(
      retireSessionMcpRuntime({
        sessionId: "session-view-lease",
        reason: "embedded-run-end",
        preserveActiveLeases: true,
      }),
    ).resolves.toBe(true);
    expect(testing.getCachedSessionIds()).toContain("session-view-lease");

    release?.();
    await completeDeferredSessionMcpRuntimeRetirement(runtime);
    expect(testing.getCachedSessionIds()).not.toContain("session-view-lease");
  });

  it("cancels deferred retirement when a later run reuses the runtime", async () => {
    const manager = testing.createSessionMcpRuntimeManager({ enableIdleSweepTimer: false });
    const params = {
      sessionId: "session-reused-after-view",
      sessionKey: "agent:test:session-reused-after-view",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 0 } },
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

  it("evicts idle runtimes after the configured TTL but skips active leases", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      let lastUsedAt = now;
      let activeLeases = 0;
      return {
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        get lastUsedAt() {
          return lastUsedAt;
        },
        get activeLeases() {
          return activeLeases;
        },
        markUsed: () => {
          lastUsedAt = now;
        },
        acquireLease: () => {
          activeLeases += 1;
          return () => {
            activeLeases -= 1;
          };
        },
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => now,
      enableIdleSweepTimer: false,
    });

    const runtime = await manager.getOrCreate({
      sessionId: "session-idle",
      sessionKey: "agent:test:session-idle",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 50 } },
    });
    const releaseLease = runtime.acquireLease?.();

    now += 60;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(0);
    expect(manager.listSessionIds()).toEqual(["session-idle"]);

    releaseLease?.();
    now += 60;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(1);

    expect(disposed).toEqual(["session-idle"]);
    expect(manager.listSessionIds()).toStrictEqual([]);
    expect(manager.resolveSessionId("agent:test:session-idle")).toBeUndefined();
  });

  it("evicts immediately after release when TTL already elapsed during active lease", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
      let lastUsedAt = now;
      let activeLeases = 0;
      return {
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        get lastUsedAt() {
          return lastUsedAt;
        },
        get activeLeases() {
          return activeLeases;
        },
        markUsed: () => {
          lastUsedAt = now;
        },
        acquireLease: () => {
          activeLeases += 1;
          return () => {
            activeLeases -= 1;
          };
        },
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      };
    };
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime,
      now: () => now,
      enableIdleSweepTimer: false,
    });

    const runtime = await manager.getOrCreate({
      sessionId: "session-idle-post-release",
      sessionKey: "agent:test:session-idle-post-release",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 50 } },
    });
    const releaseLease = runtime.acquireLease?.();

    // TTL elapses while the lease is still held, so sweep skips active runtimes.
    now += 60;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(0);

    // Release must not reset lastUsedAt; the runtime is evictable on the very
    // next sweep without waiting another full TTL.
    releaseLease?.();
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(1);

    expect(disposed).toEqual(["session-idle-post-release"]);
    expect(manager.listSessionIds()).toStrictEqual([]);
  });

  it("keeps idle runtime eviction disabled when the TTL is zero", async () => {
    let now = 1_000;
    const disposed: string[] = [];
    const manager = testing.createSessionMcpRuntimeManager({
      createRuntime: (params) => ({
        ...makeRuntime([{ toolName: "bundle_probe", description: "Bundle MCP probe" }]),
        sessionId: params.sessionId,
        sessionKey: params.sessionKey,
        workspaceDir: params.workspaceDir,
        configFingerprint: params.configFingerprint ?? "fingerprint",
        dispose: async () => {
          disposed.push(params.sessionId);
        },
      }),
      now: () => now,
      enableIdleSweepTimer: false,
    });

    await manager.getOrCreate({
      sessionId: "session-no-ttl",
      workspaceDir: "/workspace",
      cfg: { mcp: { servers: {}, sessionIdleTtlMs: 0 } },
    });

    now += 60_000_000;
    await expect(manager.sweepIdleRuntimes()).resolves.toBe(0);
    expect(manager.listSessionIds()).toEqual(["session-no-ttl"]);
    expect(disposed).toStrictEqual([]);
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
