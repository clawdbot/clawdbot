/** Tests materializing MCP catalog tools into agent tool definitions and results. */
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta } from "../plugins/tools.js";
import {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type { McpCatalogTool } from "./agent-bundle-mcp-types.js";
import type { McpToolCatalogDiagnostic } from "./agent-bundle-mcp-types.js";
import type { SessionMcpRuntime } from "./agent-bundle-mcp-types.js";

const mcpAppMocks = vi.hoisted(() => ({ fetchMcpAppView: vi.fn() }));

vi.mock("./mcp-ui-resource.js", () => ({
  fetchMcpAppView: mcpAppMocks.fetchMcpAppView,
  buildMcpAppCanvasPayload: (view: { viewId: string; title: string }) => ({
    kind: "canvas",
    view: { id: view.viewId, title: view.title },
    presentation: { target: "assistant_message", sandbox: "scripts" },
    mcpApp: { viewId: view.viewId },
  }),
}));

function expectTextContentBlock(block: unknown, text: string) {
  const content = block as { type?: string; text?: string } | undefined;
  expect(content?.type).toBe("text");
  expect(content?.text).toBe(text);
}

function makeToolRuntime(
  params: {
    tools?: McpCatalogTool[];
    serverName?: string;
    result?: CallToolResult;
    resultText?: string;
    diagnostics?: readonly McpToolCatalogDiagnostic[];
    supportsParallelToolCalls?: boolean;
  } = {},
): SessionMcpRuntime {
  const serverName = params.serverName ?? "bundleProbe";
  const tools = params.tools ?? [
    {
      serverName,
      safeServerName: serverName,
      toolName: "bundle_probe",
      description: "Bundle probe",
      inputSchema: { type: "object", properties: {} },
      fallbackDescription: "Bundle probe",
    },
  ];
  return {
    sessionId: "session-collision",
    workspaceDir: "/tmp",
    configFingerprint: "fingerprint",
    createdAt: 0,
    lastUsedAt: 0,
    markUsed: () => {},
    getCatalog: async () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
        },
      },
      tools,
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    peekCatalog: () => ({
      version: 1,
      generatedAt: 0,
      servers: {
        [serverName]: {
          serverName,
          launchSummary: serverName,
          toolCount: tools.length,
          supportsParallelToolCalls: params.supportsParallelToolCalls ?? false,
        },
      },
      tools,
      ...(params.diagnostics ? { diagnostics: params.diagnostics } : {}),
    }),
    callTool: async () =>
      params.result ?? {
        content: [{ type: "text", text: params.resultText ?? "FROM-BUNDLE" }],
        isError: false,
      },
    dispose: async () => {},
  };
}

describe("createBundleMcpToolRuntime", () => {
  beforeEach(() => {
    mcpAppMocks.fetchMcpAppView.mockReset();
  });

  it("keeps app-only MCP tools out of the model tool catalog", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "model_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "model",
            uiVisibility: ["model"],
          },
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "app_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "app",
            uiVisibility: ["app"],
          },
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "hidden_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "hidden",
            uiVisibility: [],
          },
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["demo__model_tool"]);
  });

  it("attaches app previews without converting typed image results to text", async () => {
    mcpAppMocks.fetchMcpAppView.mockResolvedValue({
      viewId: "cv_app",
      title: "Demo UI",
    });
    const tool: McpCatalogTool = {
      serverName: "demo",
      safeServerName: "demo",
      toolName: "show",
      inputSchema: { type: "object" },
      fallbackDescription: "show",
      uiResourceUri: "ui://demo/app",
    };
    const sessionRuntime = makeToolRuntime({
      tools: [tool],
      serverName: "demo",
      result: {
        content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      },
    });
    sessionRuntime.mcpAppsEnabled = true;
    const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });

    const result = await materialized.tools[0].execute("call-1", {}, undefined, undefined);
    expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(result.details).toMatchObject({
      mcpAppPreview: { mcpApp: { viewId: "cv_app" } },
    });
  });

  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(runtime.tools[0].executionMode).toBe("sequential");
    expect(getPluginToolMeta(runtime.tools[0])).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "bundleProbe",
        safeServerName: "bundleProbe",
        toolName: "bundle_probe",
        operation: "tool",
      },
    });
    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);
    expectTextContentBlock(result.content[0], "FROM-BUNDLE");
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("marks MCP tools parallel only when the server advertises parallel support", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        supportsParallelToolCalls: true,
      }),
    });

    expect(runtime.tools[0].executionMode).toBe("parallel");
  });

  it("keeps structuredContent visible when MCP tools also return text content", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "text", text: "pong" }],
          structuredContent: {
            threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
            content: "pong",
          },
          isError: false,
        },
      }),
    });

    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);

    expectTextContentBlock(
      result.content[0],
      `structuredContent:\n${JSON.stringify(
        {
          threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
          content: "pong",
        },
        null,
        2,
      )}`,
    );
    expect(result.content).toHaveLength(1);
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      structuredContent: {
        threadId: "019e6cdb-8e7f-7cb2-891f-9edb689f6fc7",
        content: "pong",
      },
    });
  });

  it("coerces non-text/image MCP tool-result blocks to text (resource_link/resource/audio)", async () => {
    // resource_link/resource/audio blocks have no base64 image source; if they
    // leaked into the provider image branch Anthropic would 400 on an image with
    // undefined data/media_type and poison the whole session history (#90710).
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [
            { type: "text", text: "intro" },
            {
              type: "resource_link",
              uri: "https://example.com/a.docx",
              name: "a.docx",
              title: "Quarterly report",
            },
            {
              type: "resource_link",
              uri: "https://example.com/bare",
              name: "",
            },
            {
              type: "resource",
              resource: { uri: "memo://one", text: "memo body" },
            },
            {
              type: "resource",
              resource: { uri: "blob://two", blob: "AAAA", mimeType: "application/pdf" },
            },
            { type: "audio", data: "AAAA", mimeType: "audio/mpeg" },
            { type: "image", data: "iVBOR", mimeType: "image/png" },
          ],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);

    expect(result.content).toEqual([
      { type: "text", text: "intro" },
      { type: "text", text: "[Quarterly report] https://example.com/a.docx" },
      { type: "text", text: "https://example.com/bare" },
      { type: "text", text: "memo body" },
      { type: "text", text: "blob://two" },
      { type: "text", text: "[audio audio/mpeg]" },
      { type: "image", data: "iVBOR", mimeType: "image/png" },
    ]);
  });

  it("coerces a malformed image block (missing base64 source) to text", async () => {
    // A real-world poison case: image block with undefined data/media_type.
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        result: {
          content: [{ type: "image" } as unknown as CallToolResult["content"][number]],
          isError: false,
        } as CallToolResult,
      }),
    });

    const result = await runtime.tools[0].execute("call-bundle-probe", {}, undefined, undefined);

    expect(result.content).toHaveLength(1);
    expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ type: "image" }) });
  });

  it("disambiguates bundle MCP tools that collide with existing tool names", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
      reservedToolNames: ["bundleProbe__bundle_probe"],
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe-2"]);
  });

  it("preserves catalog diagnostics when MCP servers fail tool listing", async () => {
    const diagnostics = [
      {
        serverName: "fuzzplugin",
        safeServerName: "fuzzplugin",
        launchSummary: "node fuzzplugin-mcp.mjs",
        message: 'tools[0].inputSchema.type expected "object"',
      },
    ];

    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({ tools: [], diagnostics }),
    });

    expect(runtime.tools).toEqual([]);
    expect(runtime.diagnostics).toEqual(diagnostics);
  });

  it("exposes MCP resource and prompt utility tools when advertised", async () => {
    const base = makeToolRuntime({ tools: [], serverName: "knowledge" });
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: true },
              prompts: { listChanged: true },
            },
          },
          tools: [],
        }),
        listResources: async () => [{ uri: "memo://one", name: "memo" }],
        readResource: async (_serverName, uri) => ({
          contents: [{ uri, text: "memo text" }],
        }),
        listPrompts: async () => [{ name: "brief" }],
        getPrompt: async (_serverName, name, args) => ({ name, args }),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    const read = await runtime.tools
      .find((tool) => tool.name === "knowledge__resources_read")!
      .execute("call-read", { uri: "memo://one" }, undefined, undefined);

    expectTextContentBlock(
      read.content[0],
      JSON.stringify({ contents: [{ uri: "memo://one", text: "memo text" }] }, null, 2),
    );
    expect(read.details).toMatchObject({
      mcpServer: "knowledge",
      mcpOperation: "resources_read",
      untrustedMcpOutput: true,
    });

    await expect(
      runtime.tools
        .find((tool) => tool.name === "knowledge__prompts_get")!
        .execute("call-prompt", { name: "brief", arguments: { count: 1 } }, undefined, undefined),
    ).rejects.toThrow("arguments.count must be a string");
  });

  it("applies per-server MCP tool filters to resource and prompt utility tools", async () => {
    const base = makeToolRuntime({ tools: [], serverName: "knowledge" });
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: {
        ...base,
        getCatalog: async () => ({
          version: 1,
          generatedAt: 0,
          servers: {
            knowledge: {
              serverName: "knowledge",
              safeServerName: "knowledge",
              launchSummary: "knowledge",
              toolCount: 0,
              resources: { listChanged: false },
              prompts: { listChanged: false },
              toolFilter: { include: ["resources_*"], exclude: ["resources_read"] },
            },
          },
          tools: [],
        }),
        listResources: async () => [],
        readResource: async () => ({ contents: [] }),
        listPrompts: async () => [],
        getPrompt: async () => ({ messages: [] }),
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["knowledge__resources_list"]);
  });

  it("projects resource and prompt utility tools for inventory-only catalogs", async () => {
    const tools = buildBundleMcpToolsFromCatalog({
      catalog: {
        version: 1,
        generatedAt: 0,
        servers: {
          knowledge: {
            serverName: "knowledge",
            safeServerName: "knowledge",
            launchSummary: "knowledge",
            toolCount: 0,
            resources: { listChanged: false },
            prompts: { listChanged: false },
          },
        },
        tools: [],
      },
    });

    expect(tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);
    await expect(tools[0].execute("inventory-only", {}, undefined, undefined)).rejects.toThrow(
      "bundle-mcp catalog projection cannot execute tools",
    );
  });

  it("materializes configured MCP tools through the session runtime boundary", async () => {
    const created: Parameters<
      NonNullable<Parameters<typeof createBundleMcpToolRuntime>[0]["createRuntime"]>
    >[0][] = [];
    const runtime = await createBundleMcpToolRuntime({
      workspaceDir: "/workspace",
      cfg: {
        mcp: {
          servers: {
            configuredProbe: {
              command: "node",
              args: ["configured-probe.mjs"],
              env: {
                BUNDLE_PROBE_TEXT: "FROM-CONFIG",
              },
            },
          },
        },
      },
      createRuntime: (params) => {
        created.push(params);
        return makeToolRuntime({
          serverName: "configuredProbe",
          resultText: "FROM-CONFIG",
        });
      },
    });

    expect(created).toHaveLength(1);
    expect(created[0].sessionId).toMatch(/^bundle-mcp:/);
    expect(created[0].workspaceDir).toBe("/workspace");
    expect(created[0].cfg?.mcp?.servers?.configuredProbe?.command).toBe("node");
    expect(created[0].cfg?.mcp?.servers?.configuredProbe?.args).toEqual(["configured-probe.mjs"]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
    const result = await runtime.tools[0].execute(
      "call-configured-probe",
      {},
      undefined,
      undefined,
    );
    expectTextContentBlock(result.content[0], "FROM-CONFIG");
    expect(result.details).toEqual({
      mcpServer: "configuredProbe",
      mcpTool: "bundle_probe",
    });
  });

  it("returns tools sorted alphabetically for stable prompt-cache keys", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "zeta",
            description: "z",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "z",
          },
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "alpha",
            description: "a",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "a",
          },
          {
            serverName: "multi",
            safeServerName: "multi",
            toolName: "mu",
            description: "m",
            inputSchema: { type: "object", properties: {} },
            fallbackDescription: "m",
          },
        ],
      }),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "multi__alpha",
      "multi__mu",
      "multi__zeta",
    ]);
  });

  it("normalizes local $ref schemas from MCP tools before exposing them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        tools: [
          {
            serverName: "notion",
            safeServerName: "notion",
            toolName: "API-post-page",
            description: "Create a page",
            inputSchema: {
              type: "object",
              required: ["parent"],
              properties: {
                parent: { $ref: "#/$defs/parentRequest" },
              },
              $defs: {
                parentRequest: {
                  oneOf: [
                    {
                      type: "object",
                      required: ["page_id"],
                      properties: { page_id: { type: "string" } },
                    },
                    {
                      type: "object",
                      required: ["database_id"],
                      properties: { database_id: { type: "string" } },
                    },
                  ],
                },
              },
            },
            fallbackDescription: "Create a page",
          },
        ],
      }),
    });

    expect(runtime.tools[0]?.parameters).toEqual({
      type: "object",
      required: ["parent"],
      properties: {
        parent: {
          oneOf: [
            {
              type: "object",
              required: ["page_id"],
              properties: { page_id: { type: "string" } },
            },
            {
              type: "object",
              required: ["database_id"],
              properties: { database_id: { type: "string" } },
            },
          ],
        },
      },
    });
    expect(
      validateToolArguments(runtime.tools[0], {
        type: "toolCall",
        id: "call-page",
        name: "notion__API-post-page",
        arguments: { parent: { page_id: "page-id" } },
      }),
    ).toEqual({ parent: { page_id: "page-id" } });
  });
});
