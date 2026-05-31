import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBundleMcpJsonSchemaValidator } from "./agent-bundle-mcp-runtime.js";
import { cleanupBundleMcpHarness } from "./agent-bundle-mcp-test-harness.js";
import {
  testing,
  getOrCreateSessionMcpRuntime,
  materializeBundleMcpToolsForRun,
  retireSessionMcpRuntime,
  retireSessionMcpRuntimeForSessionKey,
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

type RuntimeFactoryOptions = NonNullable<
  Parameters<typeof testing.createSessionMcpRuntimeManager>[0]
>;
type RuntimeFactory = NonNullable<RuntimeFactoryOptions["createRuntime"]>;
const LIST_TOOLS_SERVER_LOG_TIMEOUT_MS = 2_000;
const LIST_TOOLS_TEST_DEADLINE_MS = 4_000;

async function writeListToolsMcpServer(params: {
  filePath: string;
  logPath: string;
  delayMs?: number;
  hang?: boolean;
  inputSchema?: unknown;
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>;
  capabilities?: Record<string, unknown>;
  listToolsMethodNotFound?: boolean;
  callToolIsError?: boolean;
  callToolJsonRpcError?: boolean;
  resourceListJsonRpcError?: boolean;
}): Promise<void> {
  await writeExecutable(
    params.filePath,
    `#!/usr/bin/env node
import fs from "node:fs/promises";

const logPath = ${JSON.stringify(params.logPath)};
const delayMs = ${params.delayMs ?? 0};
const hang = ${params.hang === true};
const capabilities = ${JSON.stringify(params.capabilities ?? { tools: {} })};
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

let buffer = "";
let pendingTimer;
let keepAlive;
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
        capabilities,
        serverInfo: { name: "test-list-tools", version: "1.0.0" },
      },
    });
    return;
  }
  if (message.method === "notifications/initialized") {
    return;
  }
  if (message.method === "tools/list") {
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
    log("delay tools/list " + delayMs);
    pendingTimer = setTimeout(() => {
      send({
        jsonrpc: "2.0",
        id: message.id,
        result: {
          tools,
        },
      });
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
    await new Promise((resolve) => setTimeout(resolve, 10));
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
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
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
  await cleanupBundleMcpHarness();
});

describe("session MCP runtime", () => {
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

  it("keeps MCP tools/list responses that exceed the connection timeout but finish within the internal catalog timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-slow-listtools-"));
    const serverPath = path.join(tempDir, "slow-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(700);
    await writeListToolsMcpServer({
      filePath: serverPath,
      logPath,
      delayMs: 250,
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
              connectionTimeoutMs: 150,
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
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("delay tools/list 250");
    } finally {
      await runtime.dispose();
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("times out default-config hung bundle MCP tools/list using the internal catalog timeout", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "bundle-mcp-listtools-timeout-"));
    const serverPath = path.join(tempDir, "hanging-list-tools.mjs");
    const logPath = path.join(tempDir, "server.log");
    testing.setBundleMcpCatalogListTimeoutMsForTest(100);
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
      await Promise.race([catalogResult, new Promise((resolve) => setTimeout(resolve, 1000))]);
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
            dofbot: {
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
      expect(catalog.diagnostics?.[0]?.serverName).toBe("dofbot");
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
      await expect(fs.readFile(logPath, "utf8")).resolves.toContain("recv tools/list");
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

  it("reuses repeated materialization and recreates after explicit disposal", async () => {
    const created: SessionMcpRuntime[] = [];
    const disposed: string[] = [];
    const createRuntime: RuntimeFactory = (params) => {
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

    const runtimeA = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
    });
    const runtimeB = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
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
    expect(manager.listSessionIds()).toEqual(["session-a"]);

    await manager.disposeSession("session-a");
    expect(disposed).toEqual(["session-a"]);

    const runtimeC = await manager.getOrCreate({
      sessionId: "session-a",
      sessionKey: "agent:test:session-a",
      workspaceDir: "/workspace",
    });
    await materializeBundleMcpToolsForRun({ runtime: runtimeC });

    expect(runtimeC).not.toBe(runtimeA);
    expect(created).toHaveLength(2);

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
    const resultA = await toolsA.tools[0].execute(
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
    const resultB = await toolsB.tools[0].execute(
      "call-configured-probe-b",
      {},
      undefined,
      undefined,
    );

    expect(runtimeA).not.toBe(runtimeB);
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
            lastUsedAt = now;
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
});
