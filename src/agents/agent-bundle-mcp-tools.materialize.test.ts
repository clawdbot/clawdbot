/** Tests materializing MCP catalog tools into agent tool definitions and results. */

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { expectDefined } from "@openclaw/normalization-core";
import { validateToolArguments } from "openclaw/plugin-sdk/llm";
import { afterEach, describe, expect, it } from "vitest";
import { getPluginToolMeta } from "../plugins/tool-metadata.js";
import {
  buildBundleMcpToolsFromCatalog,
  createBundleMcpToolRuntime,
  materializeBundleMcpToolsForRun,
} from "./agent-bundle-mcp-materialize.js";
import type {
  McpCatalogTool,
  McpToolCatalogDiagnostic,
  SessionMcpRuntime,
} from "./agent-bundle-mcp-types.js";
import { applyEmbeddedAttemptToolsAllow } from "./embedded-agent-runner/run/attempt-tool-construction-plan.js";
import { getMcpAppViewLease } from "./mcp-ui-resource.js";
import { testing as mcpUiResourceTesting } from "./mcp-ui-resource.test-support.js";
import { isToolResultError } from "./tool-result-error.js";

const MCP_APP_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

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

async function executeMcpToolResult(result: CallToolResult) {
  const runtime = await materializeBundleMcpToolsForRun({
    runtime: makeToolRuntime({ result }),
  });
  return await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
    "call-bundle-probe",
    {},
    undefined,
    undefined,
  );
}

describe("createBundleMcpToolRuntime", () => {
  afterEach(() => {
    mcpUiResourceTesting.clearViewStore();
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
    expect(runtime.appTools?.map((tool) => tool.name)).toEqual([
      "demo__app_tool",
      "demo__hidden_tool",
      "demo__model_tool",
    ]);
    expect(getPluginToolMeta(runtime.appTools![0]!)?.mcp?.codexApproval).toEqual({ mode: "auto" });
    expect(
      applyEmbeddedAttemptToolsAllow(runtime.appTools ?? [], ["demo__model_tool"], {
        toolMeta: (tool) => getPluginToolMeta(tool),
      }).map((tool) => tool.name),
    ).toEqual(["demo__model_tool"]);
  });

  it("attaches app previews without converting typed image results to text", async () => {
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
        _meta: { "ui/state": { selected: true } },
      },
    });
    sessionRuntime.sessionKey = "agent:main:main";
    sessionRuntime.mcpAppsEnabled = true;
    sessionRuntime.readResource = async () => ({
      contents: [
        {
          uri: "ui://demo/app",
          mimeType: MCP_APP_RESOURCE_MIME_TYPE,
          text: "<html>demo</html>",
        },
      ],
    });
    const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });
    materialized.restrictAppTools?.(materialized.tools);

    const result = await expectDefined(
      materialized.tools[0],
      "materialized.tools[0] test invariant",
    ).execute("call-1", {}, undefined, undefined);
    expect(result.content).toEqual([{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]);
    expect(result.details).toMatchObject({
      mcpAppPreview: {
        mcpApp: {
          viewId: expect.stringMatching(/^mcp-app-/u),
          serverName: "demo",
          toolName: "show",
          uiResourceUri: "ui://demo/app",
          toolCallId: "call-1",
          originSessionKey: "agent:main:main",
          resultMetaState: "unavailable",
        },
      },
    });
    const viewId = (result.details as { mcpAppPreview?: { mcpApp?: { viewId?: string } } })
      .mcpAppPreview?.mcpApp?.viewId;
    expect(
      getMcpAppViewLease(
        expectDefined(viewId, "MCP App preview view id test invariant"),
        sessionRuntime,
      )?.allowedAppToolNames,
    ).toEqual(new Set(["show"]));
  });

  it("never mints app views for tools from requester-scoped servers", async () => {
    const tool: McpCatalogTool = {
      serverName: "user-mail",
      safeServerName: "user-mail",
      toolName: "show",
      inputSchema: { type: "object" },
      fallbackDescription: "show",
      uiResourceUri: "ui://user-mail/app",
    };
    const sessionRuntime = makeToolRuntime({ tools: [tool], serverName: "user-mail" });
    sessionRuntime.mcpAppsEnabled = true;
    // View recovery (peek + transcript reconstruction) has no requester
    // identity, so scoped servers stay fail-closed at view creation.
    sessionRuntime.isRequesterScopedServer = (serverName) => serverName === "user-mail";
    const materialized = await materializeBundleMcpToolsForRun({ runtime: sessionRuntime });

    const result = await expectDefined(
      materialized.tools[0],
      "materialized.tools[0] test invariant",
    ).execute("call-1", {}, undefined, undefined);
    expect(result.details ?? {}).not.toHaveProperty("mcpAppPreview");
  });

  it("materializes bundle MCP tools and executes them", async () => {
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime(),
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["bundleProbe__bundle_probe"]);
    expect(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").executionMode).toBe(
      "sequential",
    );
    expect(runtime.tools[0]?.resultContentSource).toBe("network");
    expect(
      getPluginToolMeta(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant")),
    ).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "bundleProbe",
        safeServerName: "bundleProbe",
        toolName: "bundle_probe",
        operation: "tool",
      },
    });
    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );
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

    expect(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").executionMode).toBe(
      "parallel",
    );
  });

  it("preserves recovery text alongside structuredContent", async () => {
    const result = await executeMcpToolResult({
      content: [{ type: "text", text: "authentication expired; run login" }],
      structuredContent: { retryable: true },
      isError: false,
    });

    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "retryable": true\n}' },
      { type: "text", text: "authentication expired; run login" },
    ]);
    expect(result.details).toEqual({
      mcpServer: "bundleProbe",
      mcpTool: "bundle_probe",
      structuredContent: { retryable: true },
    });
  });

  it("preserves text and non-text MCP content alongside structuredContent", async () => {
    const structuredContent = { description: "captured screenshot" };
    const result = await executeMcpToolResult({
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
    });

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
  });

  it("deduplicates exact structured JSON mirrors without dropping near matches", async () => {
    const structuredContent = { zeta: 2, alpha: 1 };
    const result = await executeMcpToolResult({
      content: [
        { type: "text", text: JSON.stringify(structuredContent, null, 2) },
        { type: "text", text: 'Result metadata: {"alpha":1,"zeta":2}' },
      ],
      structuredContent,
    });

    expect(result.content).toEqual([
      {
        type: "text",
        text: 'structuredContent:\n{\n  "alpha": 1,\n  "zeta": 2\n}',
      },
      { type: "text", text: 'Result metadata: {"alpha":1,"zeta":2}' },
    ]);
  });

  it("marks isError through the tool-result owner while preserving recovery text", async () => {
    const result = await executeMcpToolResult({
      content: [{ type: "text", text: "authentication expired; run login" }],
      structuredContent: { retryable: true },
      isError: true,
    });

    expect(result.content).toContainEqual({
      type: "text",
      text: "authentication expired; run login",
    });
    expect(result.details).toMatchObject({
      status: "error",
      structuredContent: { retryable: true },
    });
    expect(isToolResultError(result)).toBe(true);
  });

  it("renders structured-only results in deterministic key order", async () => {
    const result = await executeMcpToolResult({
      content: [],
      structuredContent: { zeta: 2, alpha: 1 },
    });

    expect(result.content).toEqual([
      { type: "text", text: 'structuredContent:\n{\n  "alpha": 1,\n  "zeta": 2\n}' },
    ]);
  });

  it("keeps text-only results unchanged", async () => {
    const result = await executeMcpToolResult({
      content: [{ type: "text", text: "plain result" }],
    });

    expect(result.content).toEqual([{ type: "text", text: "plain result" }]);
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

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

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

    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
      "call-bundle-probe",
      {},
      undefined,
      undefined,
    );

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

  it("reuses one-shot reserved names for App-only policy projections", async () => {
    function* reservedToolNames() {
      yield "demo__app_tool";
    }
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        serverName: "demo",
        tools: [
          {
            serverName: "demo",
            safeServerName: "demo",
            toolName: "app_tool",
            inputSchema: { type: "object" },
            fallbackDescription: "app",
            uiVisibility: ["app"],
          },
        ],
      }),
      reservedToolNames: reservedToolNames(),
    });

    expect(runtime.tools).toEqual([]);
    expect(runtime.appTools?.map((tool) => tool.name)).toEqual(["demo__app_tool-2"]);
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
    const publicResults = {
      prompts_get: {
        description: "Brief the user",
        messages: [
          {
            role: "user",
            content: {
              type: "text",
              text: "Summarize MCP",
              annotations: { audience: ["assistant"] },
              _meta: { promptBlock: "preserved" },
            },
          },
        ],
      },
      prompts_list: {
        prompts: [{ name: "brief", _meta: { promptEntry: "preserved" } }],
        nextCursor: "prompt-page-two",
      },
      resources_list: {
        resources: [
          {
            uri: "memo://one",
            name: "memo",
            annotations: { priority: 0.5 },
            _meta: { resourceEntry: "preserved" },
          },
        ],
        nextCursor: "resource-page-two",
      },
      resources_read: {
        contents: [{ uri: "memo://one", text: "memo text", _meta: { content: "preserved" } }],
      },
    };
    const privateResults = Object.fromEntries(
      Object.entries(publicResults).map(([operation, value]) => [
        operation,
        { ...value, _meta: { privateState: `${operation}-must-not-leak` } },
      ]),
    );
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
        listResources: async () => privateResults.resources_list,
        readResource: async () => privateResults.resources_read,
        listPrompts: async () => privateResults.prompts_list,
        getPrompt: async () => privateResults.prompts_get,
      },
    });

    expect(runtime.tools.map((tool) => tool.name)).toEqual([
      "knowledge__prompts_get",
      "knowledge__prompts_list",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);

    for (const [operation, args] of [
      ["prompts_get", { name: "brief" }],
      ["prompts_list", {}],
      ["resources_list", {}],
      ["resources_read", { uri: "memo://one" }],
    ] as const) {
      const tool = expectDefined(
        runtime.tools.find((candidate) => candidate.name === `knowledge__${operation}`),
        `${operation} utility tool`,
      );
      const result = await tool.execute(`call-${operation}`, args, undefined, undefined);
      expectTextContentBlock(result.content[0], JSON.stringify(publicResults[operation], null, 2));
      expect(result.details).toMatchObject({
        mcpServer: "knowledge",
        mcpOperation: operation,
        untrustedMcpOutput: true,
      });
      expect(tool.resultContentSource).toBe("network");
      expect(expectDefined(privateResults[operation], `${operation} private source`)._meta).toEqual(
        {
          privateState: `${operation}-must-not-leak`,
        },
      );
    }

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
    await expect(
      expectDefined(tools[0], "tools[0] test invariant").execute(
        "inventory-only",
        {},
        undefined,
        undefined,
      ),
    ).rejects.toThrow("bundle-mcp catalog projection cannot execute tools");
  });

  it("projects session-denied tools only for read-only inventory", () => {
    const catalog = {
      version: 1,
      generatedAt: 0,
      servers: {
        knowledge: {
          serverName: "knowledge",
          safeServerName: "knowledge",
          launchSummary: "knowledge",
          toolCount: 0,
          resources: { listChanged: false },
          deniedToolNames: ["resources_read"],
        },
      },
      tools: [
        {
          serverName: "knowledge",
          safeServerName: "knowledge",
          toolName: "alpha?",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "Enabled knowledge tool",
        },
      ],
      sessionDeniedTools: [
        {
          serverName: "knowledge",
          safeServerName: "knowledge",
          toolName: "alpha!",
          inputSchema: { type: "object", properties: {} },
          fallbackDescription: "Denied knowledge tool",
          deniedBySession: true,
        },
      ],
    } satisfies Parameters<typeof buildBundleMcpToolsFromCatalog>[0]["catalog"];

    expect(buildBundleMcpToolsFromCatalog({ catalog }).map((tool) => tool.name)).toEqual([
      "knowledge__alpha-",
      "knowledge__resources_list",
    ]);
    const inventoryTools = buildBundleMcpToolsFromCatalog({
      catalog,
      includeSessionDenied: true,
    });
    expect(inventoryTools.map((tool) => tool.name)).toEqual([
      "knowledge__alpha-",
      "knowledge__alpha--2",
      "knowledge__resources_list",
      "knowledge__resources_read",
    ]);
    expect(
      inventoryTools.map((tool) => ({
        name: tool.name,
        deniedBySession: getPluginToolMeta(tool)?.mcp?.deniedBySession,
      })),
    ).toEqual([
      { name: "knowledge__alpha-", deniedBySession: undefined },
      { name: "knowledge__alpha--2", deniedBySession: true },
      { name: "knowledge__resources_list", deniedBySession: undefined },
      { name: "knowledge__resources_read", deniedBySession: true },
    ]);
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
    expect(expectDefined(created[0], "created[0] test invariant").sessionId).toMatch(
      /^bundle-mcp:/,
    );
    expect(expectDefined(created[0], "created[0] test invariant").workspaceDir).toBe("/workspace");
    expect(
      expectDefined(created[0], "created[0] test invariant").cfg?.mcp?.servers?.configuredProbe
        ?.command,
    ).toBe("node");
    expect(
      expectDefined(created[0], "created[0] test invariant").cfg?.mcp?.servers?.configuredProbe
        ?.args,
    ).toEqual(["configured-probe.mjs"]);

    expect(runtime.tools.map((tool) => tool.name)).toEqual(["configuredProbe__bundle_probe"]);
    const result = await expectDefined(runtime.tools[0], "runtime.tools[0] test invariant").execute(
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
      validateToolArguments(expectDefined(runtime.tools[0], "runtime.tools[0] test invariant"), {
        type: "toolCall",
        id: "call-page",
        name: "notion__API-post-page",
        arguments: { parent: { page_id: "page-id" } },
      }),
    ).toEqual({ parent: { page_id: "page-id" } });
  });

  it("keeps root fields callable when an MCP input schema uses a root union (#128743)", async () => {
    const inputSchema = {
      type: "object",
      title: "MessagesReplyInput",
      additionalProperties: false,
      required: ["thread_id"],
      properties: {
        thread_id: { type: "string", minLength: 1, maxLength: 128 },
        body: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        body_file: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        task_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
        turn_grant_id: { anyOf: [{ type: "string" }, { type: "null" }], default: null },
      },
      anyOf: [
        { required: ["body"], properties: { body: { type: "string" } } },
        { required: ["body_file"], properties: { body_file: { type: "string" } } },
      ],
    };
    const runtime = await materializeBundleMcpToolsForRun({
      runtime: makeToolRuntime({
        serverName: "aihub",
        tools: [
          {
            serverName: "aihub",
            safeServerName: "aihub",
            toolName: "messages_reply",
            inputSchema,
            fallbackDescription: "Reply to a message",
          },
        ],
      }),
    });
    const tool = expectDefined(runtime.tools[0], "runtime.tools[0] test invariant");

    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-inline-body",
        name: tool.name,
        arguments: { thread_id: "thread-1", body: "hello" },
      }),
    ).not.toThrow();
    expect(() =>
      validateToolArguments(tool, {
        type: "toolCall",
        id: "call-body-file",
        name: tool.name,
        arguments: { thread_id: "thread-1", body_file: "/tmp/body.md" },
      }),
    ).not.toThrow();
  });
});
