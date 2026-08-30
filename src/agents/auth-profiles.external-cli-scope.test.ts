/**
 * External CLI auth scope tests.
 * Verifies config/model signals narrow external credential discovery to the
 * providers and profile ids relevant for the current agent.
 */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveExternalCliAuthScopeFromConfig } from "./auth-profiles/external-cli-scope.js";

describe("external CLI auth scope", () => {
  it("returns undefined when config has no provider signal", () => {
    expect(resolveExternalCliAuthScopeFromConfig({})).toBeUndefined();
  });

  it("scopes opencode-only config without adding unrelated CLI providers", () => {
    const scope = resolveExternalCliAuthScopeFromConfig({
      auth: {
        profiles: {
          "opencode-go:default": { provider: "opencode-go", mode: "api_key" },
        },
      },
      agents: {
        defaults: {
          model: { primary: "opencode-go/kimi-k2.6" },
        },
      },
      models: {
        providers: {
          "opencode-go": {
            baseUrl: "https://example.test/v1",
            auth: "api-key",
            models: [],
          },
        },
      },
    });

    expect(scope?.providerIds).toContain("opencode-go");
    expect(scope?.profileIds).toEqual(["opencode-go:default"]);
    expect(scope?.providerIds).not.toContain("claude-cli");
    expect(scope?.providerIds).not.toContain("openai");
    expect(scope?.providerIds).not.toContain("minimax-portal");
  });

  it("collects active model, auth order, media model, and runtime signals", () => {
    const cfg = {
      auth: {
        order: {
          openai: ["openai:default"],
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["openai/gpt-5.5"],
          },
          mediaModels: { image: "minimax-portal/image-01" },
          voiceModel: "elevenlabs/eleven_multilingual_v2",
          models: {
            "claude-cli/claude-opus-4-7": { alias: "opus" },
          },
        },
        entries: {
          worker: {
            model: "opencode-go/kimi-k2.6",
            models: {
              "opencode-go/kimi-k2.6": { agentRuntime: { id: "codex-app-server" } },
            },
            subagents: { model: { primary: "z.ai/glm-4.7" } },
          },
        },
      },
    } satisfies OpenClawConfig;

    const scope = resolveExternalCliAuthScopeFromConfig(cfg);

    expect(scope?.providerIds).toEqual([
      "anthropic",
      "codex-app-server",
      "elevenlabs",
      "minimax-portal",
      "openai",
      "opencode-go",
      "z.ai",
    ]);
    expect(scope?.providerIds).not.toContain("claude-cli");
    expect(scope?.profileIds).toContain("openai:default");
  });

  it("includes a CLI provider only when it is the active runtime", () => {
    const scope = resolveExternalCliAuthScopeFromConfig({
      agents: {
        defaults: {
          model: "openai/gpt-5.5",
          models: {
            "openai/gpt-5.5": { agentRuntime: { id: "claude-cli" } },
          },
        },
      },
    });

    expect(scope?.providerIds).toContain("claude-cli");
  });

  it("includes Gemini CLI when it is the configured Google model runtime", () => {
    const scope = resolveExternalCliAuthScopeFromConfig({
      agents: {
        defaults: {
          models: {
            "google/gemini-3.1-pro-preview": {
              agentRuntime: { id: "google-gemini-cli" },
            },
          },
        },
      },
    });

    expect(scope?.providerIds).toContain("google-gemini-cli");
  });
});
