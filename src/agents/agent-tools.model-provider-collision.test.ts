/**
 * Tests provider-native tool collision policy.
 * Protects OpenClaw web_search routing when provider/model compatibility also
 * advertises native search support.
 */
import { describe, expect, it } from "vitest";
import { testing } from "./agent-tools.js";
import type { AnyAgentTool } from "./agent-tools.types.js";

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
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {},
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for OpenRouter xAI model ids so OpenClaw tool routing stays authoritative", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
        toolCallArgumentsEncoding: HTML_ENTITY_TOOL_CALL_ARGUMENTS_ENCODING,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("keeps web_search for direct xai-capable models too", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
      modelCompat: {
        toolSchemaProfile: XAI_TOOL_SCHEMA_PROFILE,
        nativeWebSearchTool: true,
      },
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes managed web_search when native Codex search is active", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
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
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("can keep managed web_search for Codex app-server dynamic tools", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
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
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
      suppressManagedWebSearch: false,
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("removes managed web_search for direct Codex models when auth is available", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
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
            "openai:default": {
              provider: "openai",
              mode: "oauth",
            },
          },
        },
      },
      modelProvider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("keeps managed web_search when Codex native search cannot activate", () => {
    const filtered = testing.applyModelProviderToolPolicy(baseTools, {
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
      modelProvider: "openai",
      modelApi: "openai-chatgpt-responses",
      modelId: "gpt-5.4",
    });

    expect(toolNames(filtered)).toEqual(["read", "web_search", "exec"]);
  });

  it("drops heavyweight tools when the experimental lean local-model flag is enabled", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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

  it("drops heavyweight tools when lean local-model mode is enabled for the current agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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
            list: [
              {
                id: "gemma",
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        agentId: "gemma",
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("drops heavyweight tools when lean local-model mode is enabled for the default agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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
            list: [
              {
                id: "gemma",
                default: true,
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("drops heavyweight tools when lean local-model mode is enabled for the session agent", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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
            list: [
              {
                id: "main",
                experimental: {
                  localModelLean: false,
                },
              },
              {
                id: "gemma",
                experimental: {
                  localModelLean: true,
                },
              },
            ],
          },
        },
        sessionKey: "agent:gemma:main",
        modelProvider: "lmstudio",
        modelApi: "openai-compatible",
        modelId: "gemma-4-e4b-it",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "exec"]);
  });

  it("lets a current agent disable inherited lean local-model mode", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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
            list: [
              {
                id: "main",
                experimental: {
                  localModelLean: false,
                },
              },
            ],
          },
        },
        agentId: "main",
        modelProvider: "openai",
        modelApi: "openai-responses",
        modelId: "gpt-5.4",
      },
    );

    expect(toolNames(filtered)).toEqual(["read", "browser", "cron", "message", "exec"]);
  });

  it("keeps heavyweight tools when the experimental lean local-model flag is not enabled", () => {
    const filtered = testing.applyModelProviderToolPolicy(
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
