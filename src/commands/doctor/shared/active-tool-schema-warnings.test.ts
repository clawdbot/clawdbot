import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createOpenClawCodingTools } from "../../../agents/agent-tools.js";
import type { AnyAgentTool } from "../../../agents/tools/common.js";

const toolState = vi.hoisted(() => ({
  tools: [] as AnyAgentTool[],
  pluginIds: {} as Record<string, string | undefined>,
  throwError: null as Error | null,
  runtimeModel: null as {
    id: string;
    name: string;
    provider: string;
    api: string;
    contextWindow?: number;
    compat?: Record<string, unknown>;
  } | null,
  resolveModelError: null as Error | null,
  resolveModel: vi.fn(),
  createTools: vi.fn<typeof createOpenClawCodingTools>(),
  normalizeTools: vi.fn(
    (options: { tools: AnyAgentTool[]; modelApi?: string; model?: unknown }) => options.tools,
  ),
}));

vi.mock("../../../agents/embedded-agent-runner/model.js", () => ({
  resolveModel: (...args: unknown[]) => toolState.resolveModel(...args),
}));

vi.mock("../../../agents/agent-tools.js", () => ({
  createOpenClawCodingTools: (options?: Parameters<typeof createOpenClawCodingTools>[0]) => {
    toolState.createTools(options);
    if (toolState.throwError) {
      throw toolState.throwError;
    }
    return toolState.tools;
  },
}));

vi.mock("../../../plugins/tools.js", () => ({
  getPluginToolMeta: (tool: { name: string }) => {
    const pluginId = toolState.pluginIds[tool.name];
    return pluginId ? { pluginId, optional: false } : undefined;
  },
}));

vi.mock("../../../agents/runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: (options: { tools: AnyAgentTool[] }) =>
    toolState.normalizeTools(options),
}));

const { collectActiveToolSchemaProjectionWarnings } =
  await import("./active-tool-schema-warnings.js");

function tool(name: string, parameters: unknown): AnyAgentTool {
  return {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
}

describe("active tool schema doctor warnings", () => {
  beforeEach(() => {
    toolState.tools = [];
    toolState.pluginIds = {};
    toolState.throwError = null;
    toolState.runtimeModel = null;
    toolState.resolveModelError = null;
    toolState.resolveModel.mockReset().mockImplementation(() => {
      if (toolState.resolveModelError) {
        throw toolState.resolveModelError;
      }
      return {
        model: toolState.runtimeModel,
        authStorage: {},
        modelRegistry: {},
      };
    });
    toolState.createTools.mockClear();
    toolState.normalizeTools.mockReset().mockImplementation((options) => options.tools);
  });

  it("warns with plugin ownership for active tools blocked by runtime projection", () => {
    toolState.tools = [
      tool("message", { type: "object", properties: {} }),
      tool("dofbot_move_angles", { type: "array", items: { type: "number" } }),
    ];
    toolState.pluginIds = { dofbot_move_angles: "dofbot" };

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: {
          plugins: {
            entries: {
              dofbot: { enabled: true },
            },
          },
        },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      '- agents.main: active tool "dofbot_move_angles" from plugin "dofbot" has unsupported runtime input schema (dofbot_move_angles.parameters.type must be "object"). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.',
    ]);
  });

  it("does not validate disabled plugin mode", () => {
    toolState.tools = [tool("dofbot_move_angles", { type: "array", items: { type: "number" } })];
    toolState.pluginIds = { dofbot_move_angles: "dofbot" };

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: { plugins: { enabled: false } },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([]);
    expect(toolState.createTools).not.toHaveBeenCalled();
    expect(toolState.normalizeTools).not.toHaveBeenCalled();
  });

  it("validates provider-normalized runtime schemas before reporting doctor health", () => {
    const healthyTool = tool("message", { type: "object", properties: {} });
    const dynamicTool = tool("dofbot_move_angles", { type: "object", properties: {} });
    toolState.runtimeModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 400_000,
      compat: { unsupportedToolSchemaKeywords: ["$dynamicRef"] },
    };
    toolState.tools = [healthyTool, dynamicTool];
    toolState.pluginIds = { dofbot_move_angles: "dofbot" };
    toolState.normalizeTools.mockImplementation(({ tools, modelApi, model }) => {
      if (
        modelApi !== "openai-responses" ||
        !model ||
        (model as { id?: string }).id !== "gpt-5.5"
      ) {
        return tools;
      }
      return tools.map((entry) =>
        entry.name === "dofbot_move_angles"
          ? tool("dofbot_move_angles", {
              type: "object",
              properties: {
                target: { $dynamicRef: "#target" },
              },
            })
          : entry,
      );
    });

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
          },
          plugins: {
            entries: {
              dofbot: { enabled: true },
            },
          },
        },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      '- agents.main: active tool "dofbot_move_angles" from plugin "dofbot" has unsupported runtime input schema (dofbot_move_angles.parameters.properties.target.$dynamicRef). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.',
    ]);
    expect(toolState.createTools).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-responses",
        modelCompat: { unsupportedToolSchemaKeywords: ["$dynamicRef"] },
        modelContextWindowTokens: 400_000,
      }),
    );
    expect(toolState.normalizeTools).toHaveBeenCalledWith(
      expect.objectContaining({
        modelApi: "openai-responses",
        model: expect.objectContaining({ id: "gpt-5.5", api: "openai-responses" }),
      }),
    );
  });

  it("reports runtime schema normalization failures instead of crashing doctor", () => {
    toolState.tools = [tool("message", { type: "object", properties: {} })];
    toolState.normalizeTools.mockImplementation(() => {
      throw new Error("provider schema hook failed");
    });

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: {},
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not normalize the runtime tool set (provider schema hook failed). Fix provider/plugin loading errors before relying on assistant tool startup.",
    ]);
  });

  it("reports runtime model context failures instead of crashing doctor", () => {
    toolState.resolveModelError = new Error("provider model hook failed");
    toolState.tools = [tool("message", { type: "object", properties: {} })];

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: {},
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not resolve the runtime model context (provider model hook failed). Fix provider/model loading errors before relying on assistant tool startup.",
    ]);
    expect(toolState.createTools).toHaveBeenCalled();
    expect(toolState.normalizeTools).toHaveBeenCalled();
  });

  it("reports toolset construction failures instead of crashing doctor", () => {
    toolState.throwError = new Error("plugin startup failed");

    expect(
      collectActiveToolSchemaProjectionWarnings({
        cfg: { plugins: { entries: { dofbot: { enabled: true } } } },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not load the runtime tool set (plugin startup failed). Fix plugin loading errors before relying on assistant tool startup.",
    ]);
  });
});
