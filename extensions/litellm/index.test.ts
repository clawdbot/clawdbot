import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capturePluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";

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

      expect(result?.models?.providers?.litellm?.baseUrl).toBe("https://litellm.example/v1");
      expect(result?.models?.providers?.litellm?.api).toBe("openai-completions");
      expect(result?.auth?.profiles?.["litellm:default"]).toEqual({
        provider: "litellm",
        mode: "api_key",
      });
      expect(result?.agents?.defaults?.model).toMatchObject({
        primary: "litellm/claude-opus-4-6",
      });
      expect(resolveApiKey).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "litellm",
          flagValue: "litellm-test-key",
          flagName: "--litellm-api-key",
          envVar: "LITELLM_API_KEY",
        }),
      );
      expect(toApiKeyCredential).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: "litellm",
          resolved: { key: "litellm-test-key", source: "flag" },
        }),
      );
    } finally {
      rmSync(agentDir, { recursive: true, force: true });
    }
  });
});
