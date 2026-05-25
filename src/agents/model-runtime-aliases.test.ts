import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveCliRuntimeExecutionProvider } from "./model-runtime-aliases.js";

function createAnthropicAuthConfig(params: {
  order?: string[];
  models?: NonNullable<NonNullable<OpenClawConfig["agents"]>["defaults"]>["models"];
}): OpenClawConfig {
  return {
    auth: {
      order: params.order ? { anthropic: params.order } : undefined,
      profiles: {
        "anthropic:api": { provider: "anthropic", mode: "api_key" },
        "anthropic:claude-cli": { provider: "claude-cli", mode: "oauth" },
      },
    },
    agents: {
      defaults: {
        models: params.models,
      },
    },
  } as OpenClawConfig;
}

describe("resolveCliRuntimeExecutionProvider", () => {
  it("routes Anthropic execution to Claude CLI when the selected auth profile is Claude CLI", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("keeps direct Anthropic execution when the selected auth profile is direct Anthropic", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:api", "anthropic:claude-cli"],
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("honors an explicit direct Anthropic auth profile over CLI auth order", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        authProfileId: "anthropic:api",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:claude-cli"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("uses an explicit Claude CLI auth profile without a model-runtime entry", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        authProfileId: "anthropic:claude-cli",
        cfg: createAnthropicAuthConfig({ order: ["anthropic:api"] }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not override an explicit PI model-runtime policy with CLI auth", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          order: ["anthropic:claude-cli"],
          models: {
            "anthropic/opus-4.7": { agentRuntime: { id: "pi" } },
          },
        }),
        provider: "anthropic",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });

  it("matches a configured claude-cli policy when the caller provider is empty", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          models: {
            "anthropic/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      }),
    ).toBe("claude-cli");
  });

  it("does not return a CLI runtime when the matched entry's provider is incompatible with the runtime alias", () => {
    expect(
      resolveCliRuntimeExecutionProvider({
        cfg: createAnthropicAuthConfig({
          models: {
            "openrouter/opus-4.7": { agentRuntime: { id: "claude-cli" } },
          },
        }),
        provider: "",
        modelId: "opus-4.7",
      }),
    ).toBeUndefined();
  });
});
