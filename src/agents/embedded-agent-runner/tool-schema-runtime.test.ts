// Tool schema runtime tests cover provider plugin schema normalization and
// compact diagnostics for invalid provider-facing tool schemas.
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  // Hoisted mocks let the module under test import logger/provider runtime once
  // while each case controls plugin diagnostics.
  inspectProviderToolSchemasWithPlugin: vi.fn(),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  log: {
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

vi.mock("../../plugins/provider-runtime.js", () => ({
  inspectProviderToolSchemasWithPlugin: mocks.inspectProviderToolSchemasWithPlugin,
  normalizeProviderToolSchemasWithPlugin: mocks.normalizeProviderToolSchemasWithPlugin,
}));

vi.mock("./logger.js", () => ({
  log: mocks.log,
}));

const { logProviderToolSchemaDiagnostics, normalizeProviderToolSchemas } =
  await import("./tool-schema-runtime.js");

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
    mocks.inspectProviderToolSchemasWithPlugin.mockReset();
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
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

describe("tool schema runtime normalization lifetime", () => {
  beforeEach(() => {
    mocks.normalizeProviderToolSchemasWithPlugin.mockReset();
  });

  it("normalizes structurally identical fresh tool sets without reusing execute closures", () => {
    let normalizationRun = 0;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(
      ({ context }: { context: { tools: MockProviderTool[] } }) => {
        normalizationRun += 1;
        return context.tools.map((tool) => ({
          ...tool,
          parameters: {
            type: "object",
            properties: tool.parameters?.properties ?? {},
            normalizationRun,
          },
        }));
      },
    );
    const firstExecute = vi.fn();
    const secondExecute = vi.fn();

    const first = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: { provider: "openai", api: "openai-responses" } as never,
      tools: [
        makeTool(
          "alpha",
          { type: "object", properties: { q: { type: "string" } } },
          firstExecute,
        ),
      ] as never,
    });
    const second = normalizeProviderToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: { provider: "openai", api: "openai-responses" } as never,
      tools: [
        makeTool(
          "alpha",
          { properties: { q: { type: "string" } }, type: "object" },
          secondExecute,
        ),
      ] as never,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(2);
    expect(first[0]?.parameters).toEqual(
      expect.objectContaining({
        normalizationRun: 1,
      }),
    );
    expect(second[0]?.parameters).toEqual(
      expect.objectContaining({
        normalizationRun: 2,
      }),
    );
    expect(first[0]?.execute).toBe(firstExecute);
    expect(second[0]?.execute).toBe(secondExecute);
  });

  it("runs custom provider normalization on every call for the same prepared handle", () => {
    let customRevision = 0;
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(
      ({ context }: { context: { tools: MockProviderTool[] } }) => {
        customRevision += 1;
        return context.tools.map((tool) => ({
          ...tool,
          parameters: {
            type: "object",
            title: `custom-${customRevision}`,
          },
        }));
      },
    );
    const runtimeHandle = {
      provider: "example",
      prepared: true,
      plugin: { id: "custom-provider" },
    } as never;
    const tools = [makeTool("alpha", { type: "object" })] as never;

    const first = normalizeProviderToolSchemas({
      provider: "example",
      tools,
      runtimeHandle,
    });
    const second = normalizeProviderToolSchemas({
      provider: "example",
      tools,
      runtimeHandle,
    });

    expect(mocks.normalizeProviderToolSchemasWithPlugin).toHaveBeenCalledTimes(2);
    expect(first[0]?.parameters).toEqual({
      type: "object",
      title: "custom-1",
    });
    expect(second[0]?.parameters).toEqual({
      type: "object",
      title: "custom-2",
    });
  });
});
