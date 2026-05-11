import { describe, expect, it } from "vitest";
import { __testing } from "./pi-tools.js";
import type { AnyAgentTool } from "./pi-tools.types.js";

const HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING = "html-entities";
const XAI_TOOL_SCHEMA_PROFILE = "xai";

const baseTools = [
  { name: "read" },
  { name: "web_search" },
  { name: "exec" },
] as unknown as AnyAgentTool[];

function toolNames(tools: AnyAgentTool[]): string[] {
  return tools.map((tool) => tool.name);
}

describe("applyModelProviderToolPolicy", () => {
  it("keeps web_search for non-xAI models", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {},
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for OpenRouter xAI model ids so OpenClaw tool routing stays authoritative", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for direct xai-capable models too", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes managed web_search when native Codex search is active", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "gateway",
      modelApi: "openai-codex-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("can keep managed web_search for Codex app-server dynamic tools", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "gateway",
      modelApi: "openai-codex-responses",
      modelId: "gpt-5.4",
      suppressManagedWebSearch: false,
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes managed web_search for direct Codex models when auth is available", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
        auth: {
          profiles: {
            "openai-codex:default": {
              provider: "openai-codex",
              mode: "oauth",
            },
          },
        },
      },
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("keeps managed web_search when Codex native search cannot activate", () => {
    const filtered = __testing.applyModelProviderToolPolicy(baseTools, {
      config: {
        tools: {
          web: {
            search: {
              enabled: true,
              openaiCodex: { enabled: true, mode: "cached" },
            },
          },
        },
      },
      modelProvider: "openai-codex",
      modelApi: "openai-codex-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("drops heavyweight tools when the experimental lean local-model flag is enabled", () => {
    const filtered = __testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "cron" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: true,
              },
            },
          },
        },
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("keeps heavyweight tools when the experimental lean local-model flag is not enabled", () => {
    const filtered = __testing.applyModelProviderToolPolicy(
      [
        { name: "read" },
        { name: "browser" },
        { name: "cron" },
        { name: "message" },
        { name: "exec" },
      ] as unknown as AnyAgentTool[],
      {
        config: {
          agents: {
            defaults: {
              experimental: {
                localModelLean: false,
              },
            },
          },
        },
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "browser", "cron", "message", "exec"]);
  });
});
