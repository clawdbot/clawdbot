// Tool schema runtime tests cover provider plugin schema normalization and
// compact diagnostics for invalid provider-facing tool schemas.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Hoisted mocks let the module under test import logger/provider runtime once
  // while each case controls plugin diagnostics.
  inspectProviderToolSchemasWithPlugin: vi.fn(),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  resolveProviderToolSchemaNormalizeCacheKey: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: mocks.inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
  resolveProviderToolSchemaNormalizeCacheKey: mocks.resolveProviderToolSchemaNormalizeCacheKey,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

const {
  getProviderToolSchemaCacheStatsForTest,
  logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas,
  resetProviderToolSchemaCacheForTest,
  setProviderToolSchemaCacheMaxEntriesForTest,
} = await import("./tool-schema-runtime.js");

function makeTool(name: string, parameters: unknown, execute = vi.fn()) {
  return {
    name,
    parameters,
    execute,
  };
}

type MockProviderTool = ReturnType<typeof makeTool> & {
  parameters?: {
    properties?: unknown;
  };
};

describe("tool schema runtime diagnostics", () => {
  beforeEach(() => {
    resetProviderToolSchemaCacheForTest();
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReset();
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue("hook:default");
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
  });

  it("stays quiet when a provider reports no diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).not.toHaveBeenCalled();
  });

  it("passes through provider runtime loading policy for normalization", () => {
    const tools = [{ name: "alpha" }] as never;
    const runtimeHandle = { provider: "example", plugin: { id: "example-plugin" } } as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockReturnValueOnce(tools);

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    ).toBe(tools);

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "example",
        runtimeHandle,
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("does not resolve cache keys by loading runtime plugins when loading is disabled", () => {
    const tools = [{ name: "alpha" }] as never;
    mocks.normalizeProviderToolSchemasWithPlugin.mockReturnValueOnce(tools);

    expect(
      normalizeProviderToolSchemas({
        provider: "example",
        tools,
        allowRuntimePluginLoad: false,
      }),
    ).toBe(tools);

    expect(mocks.resolveProviderToolSchemaNormalizeCacheKey).not.toHaveBeenCalled();
    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "example",
        allowRuntimePluginLoad: false,
      }),
    );
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      bypass: 1,
      hit: 0,
      miss: 0,
      store: 0,
    });
  });

  it("logs one summarized warning for provider tool schema diagnostics", () => {
    mocks.inspectProviderToolSchemasWithPlugin.mockReturnValueOnce([
      { toolName: "alpha", toolIndex: 0, violations: ["one", "two"] },
      { toolName: "beta", toolIndex: 1, violations: ["one"] },
    ]);

    logProviderToolSchemaDiagnostics({
      provider: "example",
      tools: [{ name: "alpha" }, { name: "beta" }] as never,
    });

    expect(mocks.log.info).not.toHaveBeenCalled();
    expect(mocks.log.warn).toHaveBeenCalledTimes(1);
    expect(mocks.log.warn).toHaveBeenCalledWith(
      "provider tool schema diagnostics: 2 tools for example: alpha (2 violations), beta (1 violation)",
      {
        provider: "example",
        toolCount: 2,
        diagnosticCount: 2,
        tools: ["0:alpha", "1:beta"],
        diagnostics: [
          { index: 0, tool: "alpha", violations: ["one", "two"], violationCount: 2 },
          { index: 1, tool: "beta", violations: ["one"], violationCount: 1 },
        ],
      },
    );
  });
});

describe("tool schema runtime cache", () => {
  beforeEach(() => {
    resetProviderToolSchemaCacheForTest();
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReset();
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue("hook:default");
    mocks.log.info.mockReset();
    mocks.log.warn.mockReset();
  });

  it("reuses cached provider-normalized parameters without reusing execute closures", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(
      ({ context }: { context: { tools: MockProviderTool[] } }) =>
        context.tools.map((tool) => ({
          ...tool,
          parameters: {
            type: "object",
            properties: tool.parameters?.properties ?? {},
            additionalProperties: false,
          },
        })),
    );
    const firstExecute = vi.fn();
    const secondExecute = vi.fn();

    const first = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: { provider: "openai", api: "openai-responses" } as never,
      tools: [
        makeTool("alpha", { type: "object", properties: { q: { type: "string" } } }, firstExecute),
      ] as never,
    });
    const second = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: { provider: "openai", api: "openai-responses" } as never,
      tools: [
        makeTool("alpha", { properties: { q: { type: "string" } }, type: "object" }, secondExecute),
      ] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(1);
    expect(first[0]?.parameters).toEqual(second[0]?.parameters);
    expect(second[0]?.execute).toBe(secondExecute);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      hit: 1,
      miss: 1,
      store: 1,
    });
  });

  it("changes cache keys for provider, model API, and tool schema signatures", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => context.tools);

    normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-chat-completions",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [
        makeTool("alpha", { type: "object", properties: { q: { type: "string" } } }),
      ] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(4);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      hit: 0,
      miss: 4,
      store: 4,
    });
  });

  it("caches only provider hooks with an internal compat-family cache key", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => context.tools);
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue("compat:openai");

    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(1);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      hit: 1,
      miss: 1,
      store: 1,
    });
  });

  it("bypasses unknown provider hooks without a compat-family cache key", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => context.tools);
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue(null);

    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(2);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      bypass: 2,
      hit: 0,
      miss: 0,
      store: 0,
    });
  });

  it("bypasses the cache when no provider hook cache key is available and when disabled", () => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => context.tools);
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue(null);

    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "example",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    mocks.resolveProviderToolSchemaNormalizeCacheKey.mockReturnValue("hook:disabled");
    normalizeProviderToolSchemas({
      provider: "openai",
      env: { OPENCLAW_TOOL_SCHEMA_CACHE: "0" },
      tools: [makeTool("alpha", { type: "object" })] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(3);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      bypass: 3,
      hit: 0,
      miss: 0,
      store: 0,
    });
  });

  it("returns cloned cached parameters and evicts oldest entries", () => {
    setProviderToolSchemaCacheMaxEntriesForTest(1);
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(
      ({ context }: { context: { tools: MockProviderTool[] } }) =>
        context.tools.map((tool) => ({
          ...tool,
          parameters: {
            type: "object",
            properties: { cached: { type: "string" } },
          },
        })),
    );

    const first = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    const second = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    const secondTool = second[0];
    expect(secondTool).toBeDefined();
    (secondTool.parameters as { properties?: Record<string, unknown> }).properties = {};
    const third = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("beta", { type: "object" })] as never,
    });
    normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      tools: [makeTool("alpha", { type: "object" })] as never,
    });

    expect(first[0]?.parameters).toEqual(third[0]?.parameters);
    expect(third[0]?.parameters).toEqual({
      type: "object",
      properties: { cached: { type: "string" } },
    });
    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(3);
    expect(getProviderToolSchemaCacheStatsForTest()).toMatchObject({
      hit: 2,
      miss: 3,
      store: 3,
      size: 1,
    });
  });
});
