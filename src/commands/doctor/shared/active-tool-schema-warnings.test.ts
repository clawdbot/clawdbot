// Active tool schema warning tests cover doctor warnings for active tool schema drift.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { createOpenClawCodingTools } from "../../../agents/agent-tools.js";
import type { AnyAgentTool } from "../../../agents/tools/common.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";

const toolState = vi.hoisted(() => ({
  tools: [] as AnyAgentTool[],
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
  resolveModelAsync: vi.fn(),
  createTools: vi.fn<typeof createOpenClawCodingTools>(),
  normalizeTools: vi.fn(
    (options: { tools: AnyAgentTool[]; modelApi?: string; model?: unknown }) => options.tools,
  ),
}));

vi.mock("../../../agents/embedded-agent-runner/model.js", () => ({
  resolveModelAsync: (...args: unknown[]) => toolState.resolveModelAsync(...args),
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

vi.mock("../../../agents/runtime-plan/tools.js", () => ({
  normalizeAgentRuntimeTools: (options: { tools: AnyAgentTool[] }) =>
    toolState.normalizeTools(options),
}));

const { collectActiveToolSchemaProjectionWarnings } =
  await import("./active-tool-schema-warnings.js");

function tool(name: string, parameters: unknown, pluginId?: string): AnyAgentTool {
  const result = {
    name,
    label: name,
    description: name,
    parameters,
    execute: async () => ({ text: "ok" }),
  } as unknown as AnyAgentTool;
  if (pluginId) {
    setPluginToolMeta(result, { pluginId, optional: false });
  }
  return result;
}

describe("active tool schema doctor warnings", () => {
  beforeEach(() => {
    toolState.tools = [];
    toolState.throwError = null;
    toolState.runtimeModel = null;
    toolState.resolveModelError = null;
    toolState.resolveModelAsync.mockReset().mockImplementation(async () => {
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

  it("warns with plugin ownership for active tools blocked by runtime projection", async () => {
    toolState.tools = [
      tool("message", { type: "object", properties: {} }),
      tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } }, "fuzzplugin"),
    ];

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: {
          plugins: {
            entries: {
              fuzzplugin: { enabled: true },
            },
          },
        },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      '- agents.main: active tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has unsupported runtime input schema (fuzzplugin_move_angles.parameters.type must be "object"). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.',
    ]);
  });

  it("warns about unreadable active tool entries without crashing", async () => {
    const healthy = tool("message", { type: "object", properties: {} });
    toolState.tools = new Proxy([healthy] as AnyAgentTool[], {
      get(target, property, receiver) {
        if (property === "0") {
          throw new Error("fuzzplugin tool entry getter exploded");
        }
        if (property === "1") {
          return healthy;
        }
        if (property === "length") {
          return 2;
        }
        return Reflect.get(target, property, receiver);
      },
    });

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: {},
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      '- agents.main: active tool "tool[0]" has unsupported runtime input schema (tool[0] is unreadable). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.',
    ]);
  });

  it("does not validate disabled plugin mode", async () => {
    toolState.tools = [
      tool("fuzzplugin_move_angles", { type: "array", items: { type: "number" } }, "fuzzplugin"),
    ];

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: { plugins: { enabled: false } },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([]);
    expect(toolState.createTools).not.toHaveBeenCalled();
    expect(toolState.normalizeTools).not.toHaveBeenCalled();
  });

  it("resolves provider discovery asynchronously before agent lifecycle publication", async () => {
    toolState.runtimeModel = {
      id: "llama-3.1-8b-instant",
      name: "Llama 3.1 8B Instant",
      provider: "groq",
      api: "openai-completions",
    };
    const cfg = {
      agents: {
        defaults: {
          model: { primary: "groq/llama-3.1-8b-instant" },
        },
      },
    };

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg,
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([]);
    expect(toolState.resolveModelAsync).toHaveBeenCalledWith(
      "groq",
      "llama-3.1-8b-instant",
      expect.any(String),
      cfg,
      expect.objectContaining({
        agentId: "main",
        workspaceDir: expect.any(String),
        skipAgentDiscovery: true,
        allowBundledStaticCatalogFallback: true,
        preferBundledStaticCatalogTransport: true,
      }),
    );
    expect(toolState.createTools).toHaveBeenCalledWith(
      expect.objectContaining({
        modelProvider: "groq",
        modelId: "llama-3.1-8b-instant",
        modelApi: "openai-completions",
      }),
    );
  });

  it("validates provider-normalized runtime schemas before reporting doctor health", async () => {
    const healthyTool = tool("message", { type: "object", properties: {} });
    const dynamicTool = tool(
      "fuzzplugin_move_angles",
      { type: "object", properties: {} },
      "fuzzplugin",
    );
    toolState.runtimeModel = {
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "openai",
      api: "openai-responses",
      contextWindow: 400_000,
      compat: { unsupportedToolSchemaKeywords: ["$dynamicRef"] },
    };
    toolState.tools = [healthyTool, dynamicTool];
    toolState.normalizeTools.mockImplementation(({ tools, modelApi, model }) => {
      if (
        modelApi !== "openai-responses" ||
        !model ||
        (model as { id?: string }).id !== "gpt-5.5"
      ) {
        return tools;
      }
      return tools.map((entry) =>
        entry.name === "fuzzplugin_move_angles"
          ? tool("fuzzplugin_move_angles", {
              type: "object",
              properties: {
                target: { $dynamicRef: "#target" },
              },
            })
          : entry,
      );
    });

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
          },
          plugins: {
            entries: {
              fuzzplugin: { enabled: true },
            },
          },
        },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      '- agents.main: active tool "fuzzplugin_move_angles" from plugin "fuzzplugin" has unsupported runtime input schema (fuzzplugin_move_angles.parameters.properties.target.$dynamicRef). OpenClaw will quarantine this tool at runtime; fix or disable the plugin, or remove the tool from active allowlists.',
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

  it("reports runtime schema normalization failures instead of crashing doctor", async () => {
    toolState.tools = [tool("message", { type: "object", properties: {} })];
    toolState.normalizeTools.mockImplementation(() => {
      throw new Error("provider schema hook failed");
    });

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: {},
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not normalize the runtime tool set (provider schema hook failed). Fix provider/plugin loading errors before relying on assistant tool startup.",
    ]);
  });

  it("reports runtime model context failures instead of crashing doctor", async () => {
    toolState.resolveModelError = new Error("provider model hook failed");
    toolState.tools = [tool("message", { type: "object", properties: {} })];

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: {},
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not resolve the runtime model context (provider model hook failed). Fix provider/model loading errors before relying on assistant tool startup.",
    ]);
    expect(toolState.createTools).toHaveBeenCalled();
    expect(toolState.normalizeTools).toHaveBeenCalled();
  });

  it("reports toolset construction failures instead of crashing doctor", async () => {
    toolState.throwError = new Error("plugin startup failed");

    expect(
      await collectActiveToolSchemaProjectionWarnings({
        cfg: { plugins: { entries: { fuzzplugin: { enabled: true } } } },
        env: { HOME: "/tmp/openclaw-test" },
      }),
    ).toEqual([
      "- agents.main: active tool schema validation could not load the runtime tool set (plugin startup failed). Fix plugin loading errors before relying on assistant tool startup.",
    ]);
  });
});
