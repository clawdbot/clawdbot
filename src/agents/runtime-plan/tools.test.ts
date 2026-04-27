import type { AgentTool } from "@mariozechner/pi-agent-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  normalizedParameterFreeSchema,
} from "../../../test/helpers/agents/schema-normalization-runtime-contract.js";
import { logAgentRuntimeToolDiagnostics, normalizeAgentRuntimeTools } from "./tools.js";
import type { AgentRuntimePlan } from "./types.js";

const mocks = vi.hoisted(() => ({
  logProviderToolSchemaDiagnostics: vi.fn(),
  normalizeProviderToolSchemas: vi.fn(),
}));

vi.mock("../pi-embedded-runner/tool-schema-runtime.js", () => ({
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
    expect(mocks.normalizeProviderToolSchemas).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.4",
        modelApi: "openai-responses",
        workspaceDir: "/tmp/openclaw-runtime-plan-tools",
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
