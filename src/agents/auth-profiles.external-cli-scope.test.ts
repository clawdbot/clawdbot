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
    expect(scope?.providerIds).not.toContain("openai-codex");
    expect(scope?.providerIds).not.toContain("minimax-portal");
  });

  it("collects model, auth order, media model, and runtime signals", () => {
    const cfg = {
      auth: {
        order: {
          "openai-codex": ["openai-codex:default"],
        },
      },
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-7",
            fallbacks: ["openai/gpt-5.5"],
          },
          imageGenerationModel: "minimax-portal/image-01",
          cliBackends: {
            "claude-cli": { command: "claude" },
          },
        },
        list: [
          {
            id: "worker",
            model: "opencode-go/kimi-k2.6",
            agentRuntime: { id: "codex" },
            subagents: { model: { primary: "z.ai/glm-4.7" } },
          },
        ],
      },
    } satisfies OpenClawConfig;

    const scope = resolveExternalCliAuthScopeFromConfig(cfg);

    expect(scope?.providerIds).toEqual(
      expect.arrayContaining([
        "anthropic",
        "openai",
        "openai-codex",
        "minimax-portal",
        "claude-cli",
        "codex",
        "opencode-go",
        "z.ai",
        "zai",
      ]),
    );
  });
});
