// Doctor runtime check tests cover runtime-backed doctor checks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  resolvePluginProviders: vi.fn((): Array<Record<string, unknown>> => []),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: (
    catalog: Array<{ provider?: string; id?: string }>,
    provider: string,
    modelId: string,
  ) => catalog.find((entry) => entry.provider === provider && entry.id === modelId),
  loadModelCatalog: mocks.loadModelCatalog,
}));

vi.mock("../agents/model-selection.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../agents/model-selection.js")>()),
  resolveDefaultModelForAgent: mocks.resolveDefaultModelForAgent,
}));

vi.mock("../agents/agent-bundle-mcp-tools.js", () => ({
  createBundleMcpToolRuntime: mocks.createBundleMcpToolRuntime,
}));

vi.mock("../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: mocks.createOpenClawCodingTools,
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: () => [],
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("../plugins/provider-discovery.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins/provider-discovery.js")>()),
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders: mocks.resolvePluginProviders,
}));

const { collectProviderCatalogProjectionFindings, collectRuntimeToolSchemaFindings } =
  await import("./doctor-core-checks.runtime.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

function bundleMcpTool(name: string, parameters: unknown): AnyAgentTool {
  const entry = tool(name, parameters);
  setPluginToolMeta(entry, { pluginId: "bundle-mcp", optional: false });
  return entry;
}

describe("doctor runtime tool schema checks", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockReturnValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.resolvePluginProviders.mockReset().mockReturnValue([]);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports active bundle MCP tool schemas that would be quarantined before a model turn", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [
        bundleMcpTool("fuzzplugin__healthy", { type: "object", properties: {} }),
        bundleMcpTool("fuzzplugin__move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent main tool fuzzplugin__move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("preserves direct OpenAI catalog transport while building doctor runtime models", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        compat: { supportsTools: true },
      },
    ]);
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("healthy", { type: "object", properties: {} }),
    ]);

    await collectRuntimeToolSchemaFindings({});

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: "openai-responses",
          model: expect.objectContaining({
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
          }),
        }),
      }),
    );
  });

  it("preserves ChatGPT OpenAI catalog transport while building doctor runtime models", async () => {
    mocks.loadModelCatalog.mockResolvedValueOnce([
      {
        provider: "openai",
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        compat: { supportsTools: true },
      },
    ]);
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("healthy", { type: "object", properties: {} }),
    ]);

    await collectRuntimeToolSchemaFindings({});

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        context: expect.objectContaining({
          modelApi: "openai-chatgpt-responses",
          model: expect.objectContaining({
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api",
          }),
        }),
      }),
    );
  });

  it("reports bundle MCP runtime diagnostics when tool listing fails schema validation", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        'Configured MCP server "fuzzplugin" could not expose runtime tools for schema validation.',
      path: "mcp.servers.fuzzplugin",
      requirement: 'tools[0].inputSchema.type: Invalid input: expected "object"',
      fixHint:
        "Fix or disable the offending MCP server, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports bundle MCP runtime diagnostics for exact MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["fuzzplugin__healthy"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.fuzzplugin",
      }),
    );
  });

  it("reports exact MCP allowlists when the safe server name contains the separator", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "my__server",
          safeServerName: "my__server",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["my__server__healthy"] },
        mcp: {
          servers: {
            my__server: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.my__server",
      }),
    );
  });

  it("reports bundle MCP runtime diagnostics for glob MCP tool allowlists", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { allow: ["*__healthy"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/runtime-tool-schemas",
        path: "mcp.servers.fuzzplugin",
      }),
    );
  });

  it("reports unsupported schemas exposed only to a non-default configured agent", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/shared-workspace" },
            { id: "worker", workspace: "/tmp/shared-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool fuzzplugin_move_angles has an unsupported input schema for runtime projection.",
      path: "tools.fuzzplugin_move_angles",
      target: "fuzzplugin_move_angles",
      requirement: 'fuzzplugin_move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main", toolPolicyAuditLogLevel: "debug" }),
    );
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "worker", toolPolicyAuditLogLevel: "debug" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("skips ACP-only agents because they do not use embedded tool projection", async () => {
    mocks.createOpenClawCodingTools.mockImplementation((options) =>
      options?.agentId === "acp-worker"
        ? [tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } })]
        : [tool("healthy", { type: "object", properties: {} })],
    );
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("acp")
          ? [bundleMcpTool("fuzzplugin__bad", { type: "array", items: { type: "number" } })]
          : [],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            {
              id: "acp-worker",
              workspace: "/tmp/acp-workspace",
              runtime: { type: "acp" },
            },
          ],
        },
      }),
    ).resolves.toEqual([]);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledTimes(1);
    expect(mocks.createOpenClawCodingTools).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: "main" }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
  });

  it("loads bundled MCP runtime once per distinct agent workspace", async () => {
    mocks.createOpenClawCodingTools.mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockImplementation(
      async (options: { workspaceDir: string }) => ({
        tools: options.workspaceDir.includes("worker")
          ? [
              bundleMcpTool("fuzzplugin__move_angles", {
                type: "array",
                items: { type: "number" },
              }),
            ]
          : [bundleMcpTool("healthy", { type: "object", properties: {} })],
        dispose: mocks.disposeBundleRuntime,
      }),
    );

    await expect(
      collectRuntimeToolSchemaFindings({
        agents: {
          list: [
            { id: "main", default: true, workspace: "/tmp/main-workspace" },
            { id: "worker", workspace: "/tmp/worker-workspace" },
          ],
        },
      }),
    ).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent worker tool fuzzplugin__move_angles from plugin bundle-mcp has an unsupported input schema for runtime projection.",
      path: "mcp.servers",
      target: "fuzzplugin__move_angles",
      requirement: 'fuzzplugin__move_angles.parameters.type must be "object"',
      fixHint:
        "Disable or update the offending MCP server/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(2);
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("main-workspace") }),
    );
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: expect.stringContaining("worker-workspace") }),
    );
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(2);
  });

  it("does not report bundle MCP schemas filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [
        bundleMcpTool("fuzzplugin__move_angles", {
          type: "array",
          items: { type: "number" },
        }),
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by the final runtime tool policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["bundle-mcp"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });

  it("does not report bundle MCP diagnostics filtered out by server-level deny policy", async () => {
    mocks.createBundleMcpToolRuntime.mockReturnValueOnce({
      tools: [],
      diagnostics: [
        {
          serverName: "fuzzplugin",
          safeServerName: "fuzzplugin",
          launchSummary: "node fuzzplugin-mcp.mjs",
          message: 'tools[0].inputSchema.type: Invalid input: expected "object"',
        },
      ],
      dispose: mocks.disposeBundleRuntime,
    });

    await expect(
      collectRuntimeToolSchemaFindings({
        tools: { deny: ["fuzzplugin__*"] },
        mcp: {
          servers: {
            fuzzplugin: { command: "node", args: ["fuzzplugin-mcp.mjs"] },
          },
        },
      }),
    ).resolves.toEqual([]);
  });
});

describe("doctor provider catalog projection checks", () => {
  beforeEach(() => {
    mocks.resolvePluginProviders.mockReset().mockReturnValue([]);
  });

  it("reports provider catalog rows that fail unified text projection", async () => {
    const providers = Object.defineProperty(
      {
        healthy: {
          api: "openai-completions" as const,
          baseUrl: "https://healthy.test/v1",
          models: [{ id: "healthy-model", name: "Healthy Model", maxTokens: 1 }],
        },
      },
      "broken",
      {
        enumerable: true,
        get() {
          throw new Error("provider catalog entry read failed");
        },
      },
    );
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/provider-catalog-projection",
      severity: "error",
      message: "Provider catalog broken entry cannot be read during doctor validation.",
      path: "plugins.entries.mockplugin",
      target: "broken",
      requirement: "provider catalog entry read failed",
      fixHint:
        "Fix the plugin provider catalog hook or disable the plugin, then rerun doctor before relying on model discovery.",
    });
  });

  it("loads full provider registrations for static catalog validation", async () => {
    await collectProviderCatalogProjectionFindings({});

    expect(mocks.resolvePluginProviders).toHaveBeenCalledWith(
      expect.not.objectContaining({
        discoveryEntriesOnly: true,
      }),
    );
  });

  it("reports provider catalog model rows with invalid ids", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ name: "Missing ID" }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports whitespace-only provider catalog model ids", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "   " }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports provider catalog model rows with invalid names", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models: [{ id: "mock-model", name: { label: "Mock" } }],
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model name.",
        requirement: "model name must be a string when present",
      }),
    );
  });

  it("reports provider catalog model lists with invalid shapes", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models: {},
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin models value is invalid during doctor validation.",
        requirement: "models must be an array",
      }),
    );
  });

  it("reports provider catalog model lists with invalid iterators", async () => {
    const models = [{ id: "mock-model" }];
    Object.defineProperty(models, Symbol.iterator, {
      value: () => {
        throw new Error("model iterator failed");
      },
    });
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: {
              api: "openai-completions" as const,
              baseUrl: "https://mockplugin.test/v1",
              models,
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin model rows cannot be enumerated during doctor validation.",
        requirement: "model iterator failed",
      }),
    );
  });

  it("reports provider catalog results without provider containers", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({ providers: undefined }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin result is invalid during doctor validation.",
        requirement: "result must include provider or providers object",
      }),
    );
  });

  it("reports invalid multi-provider catalog keys", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              " ": {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "mock-model" }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin provider key is invalid during doctor validation.",
        requirement: "provider key must be a non-empty trimmed string",
      }),
    );
  });

  it("reports falsy non-empty provider catalog results", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => false as never,
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin result is invalid during doctor validation.",
        requirement: "result must be an object",
      }),
    );
  });

  it("reports invalid provider catalog orders without aborting doctor", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "middle" as never,
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: " " }],
              },
            },
          }),
        },
      },
    ]);

    const findings = await collectProviderCatalogProjectionFindings({});
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin order is invalid during doctor validation.",
        requirement: "order must be simple, profile, paired, or late",
      }),
    );
    expect(findings).toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("validates static catalog rows when live catalog order access fails", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        get catalog() {
          throw new Error("live catalog order failed");
        },
        staticCatalog: {
          order: "simple",
          run: async () => ({
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: " " }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin model row 0 has an invalid model id.",
        requirement: "model id must be a non-empty trimmed string",
      }),
    );
  });

  it("reports static catalog hook access failures without aborting doctor", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          get run() {
            throw new Error("run getter failed");
          },
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin static catalog hook cannot be read during doctor validation.",
        requirement: "run getter failed",
      }),
    );
  });

  it("reports static catalog hooks with non-function run values", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: "not-callable",
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message:
          "Provider catalog mockplugin static catalog hook is invalid during doctor validation.",
        requirement: "static catalog run must be a function",
      }),
    );
  });

  it("reports revoked provider catalog result proxies without crashing doctor", async () => {
    const { proxy, revoke } = Proxy.revocable(
      {
        providers: {},
      },
      {},
    );
    revoke();
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          // Awaiting a promise resolved with a proxy reads "then", so revoked
          // catalog results fail at the hook boundary before result key checks.
          run: async () => proxy,
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin failed during doctor validation.",
        requirement: "Cannot perform 'get' on a proxy that has been revoked",
      }),
    );
  });

  it("reports present but invalid single-provider catalog branches", async () => {
    mocks.resolvePluginProviders.mockReturnValueOnce([
      {
        id: "mockplugin",
        pluginId: "mockplugin",
        label: "Mock",
        auth: [],
        staticCatalog: {
          order: "simple",
          run: async () => ({
            provider: undefined,
            providers: {
              mockplugin: {
                api: "openai-completions" as const,
                baseUrl: "https://mockplugin.test/v1",
                models: [{ id: "mock-model" }],
              },
            },
          }),
        },
      },
    ]);

    await expect(collectProviderCatalogProjectionFindings({})).resolves.toContainEqual(
      expect.objectContaining({
        checkId: "core/doctor/provider-catalog-projection",
        severity: "error",
        path: "plugins.entries.mockplugin",
        target: "mockplugin",
        message: "Provider catalog mockplugin provider value is invalid during doctor validation.",
        requirement: "provider must be an object",
      }),
    );
  });
});
