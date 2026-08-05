// Doctor runtime error tests cover error handling in core runtime checks.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnyAgentTool } from "../agents/tools/common.js";
import { setPluginToolMeta } from "../plugins/tools.js";

const mocks = vi.hoisted(() => ({
  createBundleMcpToolRuntime: vi.fn(),
  createOpenClawCodingTools: vi.fn(),
  disposeBundleRuntime: vi.fn(),
  loadModelCatalog: vi.fn(async (): Promise<Array<Record<string, unknown>>> => []),
  normalizeProviderToolSchemasWithPlugin: vi.fn(),
  resolveDefaultModelForAgent: vi.fn(() => ({ provider: "openai", model: "gpt-5.5" })),
}));

vi.mock("../agents/model-catalog.js", () => ({
  findModelInCatalog: (
    catalog: Array<{ provider?: string; id?: string }>,
    provider: string,
    modelId: string,
  ) => catalog.find((entry) => entry.provider === provider && entry.id === modelId),
}));

vi.mock("../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: mocks.loadModelCatalog,
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

const { collectRuntimeToolSchemaFindings } = await import("./doctor-core-checks.runtime.js");

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

describe("doctor runtime tool schema error handling", () => {
  beforeEach(() => {
    mocks.createOpenClawCodingTools.mockReset().mockReturnValue([]);
    mocks.createBundleMcpToolRuntime.mockReset().mockResolvedValue({
      tools: [],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.disposeBundleRuntime.mockReset().mockResolvedValue(undefined);
    mocks.loadModelCatalog.mockClear();
    mocks.normalizeProviderToolSchemasWithPlugin
      .mockReset()
      .mockImplementation(({ context }) => context.tools);
    mocks.resolveDefaultModelForAgent.mockClear();
  });

  it("reports agent runtime tool construction failures without aborting schema checks", async () => {
    mocks.createOpenClawCodingTools.mockImplementationOnce(() => {
      throw new Error("fuzzplugin startup failed");
    });

    await expect(collectRuntimeToolSchemaFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message: "Agent main runtime tool schema validation could not load the runtime tool set.",
      path: "agents.main.tools",
      requirement: "fuzzplugin startup failed",
      fixHint:
        "Fix provider/plugin tool loading errors, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.createBundleMcpToolRuntime).toHaveBeenCalledTimes(1);
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports agent runtime tool normalization failures without aborting doctor", async () => {
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      tool("fuzzplugin_move_angles", { type: "object", properties: {} }),
    ]);
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => {
      const tools = context.tools as AnyAgentTool[];
      if (tools.some((entry) => entry.name === "fuzzplugin_move_angles")) {
        throw new Error("fuzzplugin schema normalization failed");
      }
      return tools;
    });

    await expect(collectRuntimeToolSchemaFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent main runtime tool schema validation could not normalize the runtime tool set.",
      path: "agents.main.tools",
      requirement: "fuzzplugin schema normalization failed",
      fixHint:
        "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports unreadable agent runtime tool schemas without aborting doctor", async () => {
    const unreadable = tool("fuzzplugin_unreadable", { type: "object", properties: {} });
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    mocks.createOpenClawCodingTools.mockReturnValueOnce([
      unreadable,
      tool("healthy", { type: "object", properties: {} }),
    ]);

    await expect(collectRuntimeToolSchemaFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message:
        "Agent main tool fuzzplugin_unreadable has an unsupported input schema for runtime projection.",
      path: "tools.fuzzplugin_unreadable",
      target: "fuzzplugin_unreadable",
      requirement: "fuzzplugin_unreadable.parameters is unreadable",
      fixHint:
        "Disable or update the offending plugin/tool so its parameters are a JSON object schema, then rerun doctor.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });

  it("reports bundle MCP runtime tool normalization failures without aborting doctor", async () => {
    mocks.createBundleMcpToolRuntime.mockResolvedValueOnce({
      tools: [bundleMcpTool("fuzzplugin__move_angles", { type: "object", properties: {} })],
      dispose: mocks.disposeBundleRuntime,
    });
    mocks.normalizeProviderToolSchemasWithPlugin.mockImplementation(({ context }) => {
      const tools = context.tools as AnyAgentTool[];
      if (tools.some((entry) => entry.name === "fuzzplugin__move_angles")) {
        throw new Error("fuzzplugin MCP schema normalization failed");
      }
      return tools;
    });

    await expect(collectRuntimeToolSchemaFindings({})).resolves.toContainEqual({
      checkId: "core/doctor/runtime-tool-schemas",
      severity: "error",
      message: "Configured MCP tool schema validation could not normalize the runtime tool set.",
      path: "mcp.servers",
      requirement: "fuzzplugin MCP schema normalization failed",
      fixHint:
        "Fix provider/plugin schema normalization errors, then rerun doctor before relying on assistant tool startup.",
    });
    expect(mocks.disposeBundleRuntime).toHaveBeenCalledTimes(1);
  });
});
