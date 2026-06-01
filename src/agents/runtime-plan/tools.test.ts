import type { AgentTool } from "openclaw/plugin-sdk/agent-core";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getPluginToolMeta, setPluginToolMeta } from "../../plugins/tools.js";
import type { RuntimeToolSchemaDiagnostic } from "../tool-schema-projection.js";
import { logAgentRuntimeToolDiagnostics, normalizeAgentRuntimeTools } from "./tools.js";
import type { AgentRuntimePlan } from "./types.js";

const mocks = vi.hoisted(() => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn(),
}));

vi.mock("../embedded-agent-runner/tool-schema-runtime.js", () => ({
  logProviderToolSchemaDiagnostics: mocks.logProviderToolSchemaDiagnostics,
  normalizeProviderToolSchemas: mocks.normalizeProviderToolSchemas,
}));

describe("AgentRuntimePlan tool policy helpers", () => {
  beforeEach(() => {
    mocks.logProviderToolSchemaDiagnostics.mockReset();
    mocks.normalizeProviderToolSchemas.mockReset();
  });

  it("uses RuntimePlan-owned tool normalization when a plan is available", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const normalized = [{ ...tools[0], name: "normalized" }] as AgentTool[];
    const model = createNativeOpenAIResponsesModel() as never;
    const normalize = vi.fn(() => normalized);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        workspaceDir: "/tmp/openclaw-runtime-plan-tools",
        model,
      }),
    ).toBe(normalized);
    expect(normalize).toHaveBeenCalledWith(tools, {
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      modelApi: "openai-responses",
      model,
    });
  });

  it("quarantines unreadable tools before RuntimePlan normalization", () => {
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const unreadable = { ...createParameterFreeTool(), name: "fuzzplugin_unreadable" } as AgentTool;
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    const tools = [unreadable, healthy];
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    const normalize = vi.fn((entries: AgentTool[]) => entries);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(normalize).toHaveBeenCalledWith([healthy], {
      workspaceDir: undefined,
      modelApi: undefined,
      model: undefined,
    });
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_unreadable",
          toolIndex: 0,
          violations: ["fuzzplugin_unreadable.parameters is unreadable"],
        },
      ],
    ]);
  });

  it("quarantines non-object schemas before provider schema normalization", () => {
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const arraySchema = {
      ...createParameterFreeTool("fuzzplugin_array_root"),
      parameters: { type: "array", items: { type: "number" } },
    } as unknown as AgentTool;
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools: entries }) => entries);

    expect(
      normalizeAgentRuntimeTools({
        tools: [arraySchema, healthy],
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [healthy],
        provider: "openai",
      }),
    );
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_array_root",
          toolIndex: 0,
          violations: ['fuzzplugin_array_root.parameters.type must be "object"'],
        },
      ],
    ]);
  });

  it("accepts legacy optional model fields while normalizing RuntimePlan context", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const normalize = vi.fn(() => tools);
    const runtimePlan = {
      tools: {
        normalize,
        logDiagnostics: vi.fn(),
      },
    } as unknown as AgentRuntimePlan;

    expect(
      normalizeAgentRuntimeTools({
        runtimePlan,
        tools,
        provider: "openai",
        modelApi: null,
      }),
    ).toBe(tools);
    expect(normalize).toHaveBeenCalledWith(tools, {
      workspaceDir: undefined,
      modelApi: undefined,
      model: undefined,
    });
  });

  it("falls back to legacy provider schema normalization when no plan is available", () => {
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([
      {
        ...createParameterFreeTool(),
        parameters: normalizedParameterFreeSchema(),
      },
    ]);

    const normalized = normalizeAgentRuntimeTools({
      tools: [createParameterFreeTool()] as AgentTool[],
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      model: createNativeOpenAIResponsesModel() as never,
    });

    expect(normalized[0]?.parameters).toEqual(normalizedParameterFreeSchema());
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledTimes(1);
    expect(mocks.normalizeProviderToolSchemas.mock.calls.at(0)?.[0]).toEqual({
      tools: [createParameterFreeTool()],
      provider: "openai",
      config: undefined,
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      env: process.env,
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: createNativeOpenAIResponsesModel(),
      allowRuntimePluginLoad: undefined,
    });
  });

  it("preserves plugin metadata when provider schema normalization clones tools", () => {
    const tool = createParameterFreeTool("fixture__lookup_note") as AgentTool;
    setPluginToolMeta(tool, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "fixture",
        safeServerName: "fixture",
        toolName: "lookup_note",
        operation: "tool",
      },
    });
    const normalized = {
      ...tool,
      parameters: normalizedParameterFreeSchema(),
    };
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeAgentRuntimeTools({
      tools: [tool],
      provider: "openai",
    });

    expect(result[0]).toBe(normalized);
    expect(getPluginToolMeta(result[0])).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "fixture",
        toolName: "lookup_note",
      },
    });
  });

  it("does not reread quarantined tools while preserving normalized metadata", () => {
    const unreadableName = {
      ...createParameterFreeTool("fuzzplugin_unreadable_name"),
    } as AgentTool;
    Object.defineProperty(unreadableName, "name", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin name getter exploded");
      },
    });
    const healthy = createParameterFreeTool("fixture__lookup_note") as AgentTool;
    setPluginToolMeta(healthy, {
      pluginId: "bundle-mcp",
      optional: false,
      mcp: {
        serverName: "fixture",
        safeServerName: "fixture",
        toolName: "lookup_note",
        operation: "tool",
      },
    });
    const normalized = {
      ...healthy,
      parameters: normalizedParameterFreeSchema(),
    };
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockReturnValueOnce([normalized]);

    const result = normalizeAgentRuntimeTools({
      tools: [unreadableName, healthy],
      provider: "openai",
      onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
    });

    expect(result).toEqual([normalized]);
    expect(getPluginToolMeta(result[0])).toMatchObject({
      pluginId: "bundle-mcp",
      mcp: {
        serverName: "fixture",
        toolName: "lookup_note",
      },
    });
    expect(diagnostics).toEqual([
      [
        {
          toolName: "tool[0]",
          toolIndex: 0,
          violations: ["tool[0].name is unreadable"],
        },
      ],
    ]);
  });

  it("quarantines unreadable tools before provider schema normalization", () => {
    const healthy = { ...createParameterFreeTool(), name: "healthy" } as AgentTool;
    const unreadable = { ...createParameterFreeTool(), name: "fuzzplugin_unreadable" } as AgentTool;
    Object.defineProperty(unreadable, "parameters", {
      enumerable: true,
      get() {
        throw new Error("fuzzplugin parameters getter exploded");
      },
    });
    const tools = [unreadable, healthy];
    const diagnostics: RuntimeToolSchemaDiagnostic[][] = [];
    mocks.normalizeProviderToolSchemas.mockImplementationOnce(({ tools: entries }) => entries);

    expect(
      normalizeAgentRuntimeTools({
        tools,
        provider: "openai",
        onPreNormalizationSchemaDiagnostics: (entries) => diagnostics.push([...entries]),
      }),
    ).toEqual([healthy]);
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: [healthy],
        provider: "openai",
      }),
    );
    expect(diagnostics).toEqual([
      [
        {
          toolName: "fuzzplugin_unreadable",
          toolIndex: 0,
          violations: ["fuzzplugin_unreadable.parameters is unreadable"],
        },
      ],
    ]);
  });

  it("can normalize without cold-loading provider runtime plugins", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];

    normalizeAgentRuntimeTools({
      tools,
      provider: "openai",
      allowProviderRuntimePluginLoad: false,
    });

    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        tools,
        provider: "openai",
        allowRuntimePluginLoad: false,
      }),
    );
  });

  it("routes diagnostics through RuntimePlan when a plan is available", () => {
    const tools = [createParameterFreeTool()] as AgentTool[];
    const model = createNativeOpenAIResponsesModel() as never;
    const logDiagnostics = vi.fn();
    const runtimePlan = {
      tools: {
        normalize: vi.fn(),
        logDiagnostics,
      },
    } as unknown as AgentRuntimePlan;

    logAgentRuntimeToolDiagnostics({
      runtimePlan,
      tools,
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      model,
    });

    expect(logDiagnostics).toHaveBeenCalledWith(tools, {
      workspaceDir: "/tmp/openclaw-runtime-plan-tools",
      modelApi: "openai-responses",
      model,
    });
  });
});
