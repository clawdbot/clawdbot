import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

const LITELLM_DEFAULT_MODEL = {
  id: "claude-opus-4-6",
  name: "Claude Opus 4.6",
  reasoning: true,
  input: ["text", "image"],
  cost: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  },
  contextWindow: 128_000,
  maxTokens: 8_192,
};

function registerProvider() {
  const captured = capturePluginRegistration(plugin);
  const provider = captured.providers[0];
  expect(provider?.id).toBe("litellm");
  return provider;
}

describe("litellm plugin", () => {
  it("honors --custom-base-url in non-interactive API-key setup", async () => {
    const provider = registerProvider();
    const auth = provider?.auth?.[0];
    const agentDir = mkdtempSync(join(tmpdir(), "openclaw-litellm-auth-"));
    const resolveApiKey = vi.fn(async () => ({ key: "litellm-test-key", source: "flag" as const }));
    const toApiKeyCredential = vi.fn(({ provider: providerId, resolved }) => ({
      type: "api_key" as const,
      provider: providerId,
      key: resolved.key,
    }));

    try {
      const result = await auth?.runNonInteractive?.({
        authChoice: "litellm-api-key",
        config: {},
        baseConfig: {},
        opts: {
          litellmApiKey: "litellm-test-key",
          customBaseUrl: "https://litellm.example/v1/",
        },
        runtime: {
          error: vi.fn(),
          exit: vi.fn(),
          log: vi.fn(),
        } as never,
        agentDir,
        resolveApiKey,
        toApiKeyCredential,
      } as never);

      expect(result).toStrictEqual({
        auth: {
          profiles: {
            "litellm:default": {
              provider: "litellm",
              mode: "api_key",
            },
          },
        },
        agents: {
          defaults: {
            models: {
              "litellm/claude-opus-4-6": {
                alias: "LiteLLM",
              },
            },
            model: {
              primary: "litellm/claude-opus-4-6",
            },
          },
        },
        models: {
          mode: "merge",
          providers: {
            litellm: {
              baseUrl: "https://litellm.example/v1",
              api: "openai-completions",
              models: [LITELLM_DEFAULT_MODEL],
            },
          },
        },
      });
      expect(resolveApiKey).toHaveBeenCalledWith({
        provider: "litellm",
        flagValue: "litellm-test-key",
        flagName: "--litellm-api-key",
        envVar: "LITELLM_API_KEY",
      });
      expect(toApiKeyCredential).toHaveBeenCalledWith({
        provider: "litellm",
        resolved: { key: "litellm-test-key", source: "flag" },
      });
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
