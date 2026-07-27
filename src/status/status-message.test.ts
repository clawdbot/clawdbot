// Status message tests cover status message formatting and persistence.
import { afterEach, describe, expect, it } from "vitest";
import { testing as cliBackendsTesting } from "../agents/cli-backends.test-support.js";
import type { ModelDefinitionConfig } from "../config/types.models.js";
import { buildStatusMessage } from "./status-message.js";

function statusTestModel(id: string, name: string, contextWindow: number): ModelDefinitionConfig {
  return {
    id,
    name,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow,
    maxTokens: 8_192,
  };
}

afterEach(() => {
  cliBackendsTesting.resetDepsForTest();
});

describe("buildStatusMessage current time", () => {
  it("surfaces a live current-time line so session_status returns the date/time", () => {
    // 2025-07-03T08:00:00Z; the Reference UTC line is timezone-independent.
    const now = 1_751_529_600_000;
    const text = buildStatusMessage({
      now,
      config: { agents: { defaults: { userTimezone: "UTC", timeFormat: "24" } } },
      agent: { model: "anthropic/claude-haiku-4-5" },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Current time:");
    expect(text).toContain("(UTC)");
    expect(text).toContain("Reference UTC: 2025-07-03 08:00 UTC");
  });
});

describe("buildStatusMessage context window", () => {
  it("ignores stale runtime context after a manual session model switch", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
                statusTestModel("glm-5.1", "GLM 5.1", 200_000),
              ],
            },
          },
        },
      },
      agent: {
        model: "ollama-cloud/deepseek-v4-pro",
        contextTokens: 1_000_000,
      },
      configuredDefaultModelLabel: "ollama-cloud/deepseek-v4-pro",
      explicitConfiguredContextTokens: 1_000_000,
      runtimeContextTokens: 1_000_000,
      sessionEntry: {
        sessionId: "manual-switch-stale-runtime",
        updatedAt: 0,
        providerOverride: "ollama-cloud",
        modelOverride: "glm-5.1",
        modelOverrideSource: "user",
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
        totalTokens: 128_393,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:telegram:direct:584667058",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Model: ollama-cloud/glm-5.1");
    expect(text).toContain("pinned session; config primary ollama-cloud/deepseek-v4-pro");
    expect(text).toContain("Context: 128k/200k");
    expect(text).not.toContain("Context: 128k/1.0m");
    expect(text).not.toContain("live switch pending");
  });

  it("flags a pending live model switch on the model line", () => {
    // A /model switch issued during an active run stays pending until a turn
    // applies it; /status must not imply the new selection is already running.
    const text = buildStatusMessage({
      config: {},
      agent: { model: "anthropic/claude-opus-4-6" },
      sessionEntry: {
        sessionId: "pending-live-switch",
        updatedAt: 0,
        providerOverride: "openai",
        modelOverride: "gpt-5.5",
        modelOverrideSource: "user",
        liveModelSwitchPending: true,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Model: openai/gpt-5.5");
    expect(text).toContain("⏳ live switch pending");
  });

  it("keeps trusted runtime context for config-backed runtime aliases", () => {
    cliBackendsTesting.setDepsForTest({
      resolvePluginSetupCliBackend: ({ backend }) =>
        backend === "claude-cli"
          ? {
              pluginId: "anthropic",
              backend: {
                id: "claude-cli",
                modelProvider: "anthropic",
                config: { command: "claude" },
                bundleMcp: false,
              },
            }
          : undefined,
      resolvePluginSetupRegistry: () => {
        throw new Error("setup registry should not load for a targeted runtime alias");
      },
      resolveRuntimeCliBackends: () => [],
    });

    const text = buildStatusMessage({
      config: {
        agents: {
          defaults: {},
        },
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com",
              models: [statusTestModel("claude-haiku-4-5", "Claude Haiku 4.5", 200_000)],
            },
          },
        },
      },
      agent: {
        model: "anthropic/claude-haiku-4-5",
        contextTokens: 200_000,
      },
      runtimeContextTokens: 1_000_000,
      sessionEntry: {
        sessionId: "runtime-alias-context",
        updatedAt: 0,
        modelProvider: "claude-cli",
        model: "claude-haiku-4-5",
        totalTokens: 36_000,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:main",
      sessionScope: "per-sender",
      queue: { mode: "collect", depth: 0 },
      modelAuth: "oauth",
      activeModelAuth: "oauth",
    });

    expect(text).toContain("Model: anthropic/claude-haiku-4-5");
    expect(text).toContain("Context: 36k/1.0m");
    expect(text).not.toContain("Context: 36k/200k");
  });

  it("shows auto-fallback override label when model differs from configured default", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
                statusTestModel("qwen3.6-blue", "Qwen 3.6 Blue", 128_000),
              ],
            },
          },
        },
      },
      agent: {
        model: "ollama-cloud/deepseek-v4-pro",
        contextTokens: 1_000_000,
      },
      configuredDefaultModelLabel: "ollama-cloud/deepseek-v4-pro",
      explicitConfiguredContextTokens: 1_000_000,
      runtimeContextTokens: 128_000,
      sessionEntry: {
        sessionId: "auto-fallback-qwen",
        updatedAt: 0,
        providerOverride: "ollama-cloud",
        modelOverride: "qwen3.6-blue",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "ollama-cloud",
        modelOverrideFallbackOriginModel: "deepseek-v4-pro",
        modelProvider: "ollama-cloud",
        model: "deepseek-v4-pro",
        totalTokens: 50_000,
        totalTokensFresh: true,
      },
      sessionKey: "agent:main:telegram:direct:auto-fallback",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Model: ollama-cloud/qwen3.6-blue");
    expect(text).toContain("auto fallback; config primary ollama-cloud/deepseek-v4-pro");
    expect(text).toContain("check provider");
    expect(text).not.toContain("pinned session");
  });

  it("does not label a configured subagent model as auto fallback", () => {
    const text = buildStatusMessage({
      config: {
        models: {
          providers: {
            "ollama-cloud": {
              baseUrl: "https://ollama.com",
              models: [
                statusTestModel("deepseek-v4-pro", "DeepSeek V4 Pro", 1_000_000),
                statusTestModel("qwen3.6-blue", "Qwen 3.6 Blue", 128_000),
              ],
            },
          },
        },
      },
      agent: { model: "ollama-cloud/deepseek-v4-pro" },
      configuredDefaultModelLabel: "ollama-cloud/deepseek-v4-pro",
      sessionEntry: {
        sessionId: "configured-subagent",
        updatedAt: 0,
        providerOverride: "ollama-cloud",
        modelOverride: "qwen3.6-blue",
        modelOverrideSource: "auto",
        modelOverrideFallbackOriginProvider: "ollama-cloud",
        modelOverrideFallbackOriginModel: "qwen3.6-blue",
      },
      sessionKey: "agent:worker:subagent:configured",
      sessionScope: "per-sender",
      queue: { mode: "steer", depth: 0 },
      modelAuth: "api-key",
    });

    expect(text).toContain("Model: ollama-cloud/qwen3.6-blue");
    expect(text).not.toContain("auto fallback");
    expect(text).not.toContain("check provider");
    expect(text).not.toContain("pinned session");
  });
});
