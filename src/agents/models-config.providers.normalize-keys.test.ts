import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { normalizeProviders } from "./models-config.providers.normalize.js";
import { resolveApiKeyFromProfiles } from "./models-config.providers.secret-helpers.js";
import { enforceSourceManagedProviderSecrets } from "./models-config.providers.source-managed.js";

vi.mock("./models-config.providers.policy.runtime.js", async () => {
  const { normalizeLmstudioProviderConfig } = await vi.importActual<
    typeof import("../plugin-sdk/lmstudio-runtime.js")
  >("../plugin-sdk/lmstudio-runtime.js");
  return {
    applyProviderNativeStreamingUsagePolicy: () => undefined,
    normalizeProviderConfigPolicy: (providerKey: string, provider: unknown) =>
      providerKey === "lmstudio" ? normalizeLmstudioProviderConfig(provider as never) : undefined,
    resolveProviderConfigApiKeyPolicy: () => undefined,
  };
});

describe("normalizeProviders", () => {
  const createModel = (
    overrides: Partial<
      NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>[string]["models"][number]
    > = {},
  ) => ({
    id: "config-model",
    name: "Config model",
    input: ["text"] as Array<"text" | "image">,
    reasoning: false,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 8192,
    maxTokens: 2048,
    ...overrides,
  });

  it("trims provider keys so image models remain discoverable for custom providers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        " dashscope-vision ": {
          baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
          api: "openai-completions",
          apiKey: "DASHSCOPE_API_KEY", // pragma: allowlist secret
          models: [
            {
              id: "qwen-vl-max",
              name: "Qwen VL Max",
              input: ["text", "image"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 32000,
              maxTokens: 4096,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["dashscope-vision"]);
      expect(normalized?.["dashscope-vision"]?.models?.[0]?.id).toBe("qwen-vl-max");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps the latest provider config when duplicate keys only differ by whitespace", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
          models: [],
        },
        " openai ": {
          baseUrl: "https://example.com/v1",
          api: "openai-completions",
          apiKey: "CUSTOM_OPENAI_API_KEY", // pragma: allowlist secret
          models: [
            {
              id: "gpt-4.1-mini",
              name: "GPT-4.1 mini",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(Object.keys(normalized ?? {})).toEqual(["openai"]);
      expect(normalized?.openai?.baseUrl).toBe("https://example.com/v1");
      expect(normalized?.openai?.apiKey).toBe("CUSTOM_OPENAI_API_KEY");
      expect(normalized?.openai?.models?.[0]?.id).toBe("gpt-4.1-mini");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
  it("replaces resolved env var value with env var name to prevent plaintext persistence", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const env = {
      ...process.env,
      OPENAI_API_KEY: "sk-test-secret-value-12345", // pragma: allowlist secret
      OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
    };
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          apiKey: "sk-test-secret-value-12345", // pragma: allowlist secret; simulates resolved ${OPENAI_API_KEY}
          api: "openai-completions",
          models: [
            {
              id: "gpt-4.1",
              name: "GPT-4.1",
              input: ["text"],
              reasoning: false,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 128000,
              maxTokens: 16384,
            },
          ],
        },
      };
      const normalized = normalizeProviders({
        providers,
        agentDir,
        env,
        secretRefManagedProviders,
      });
      expect(normalized?.openai?.apiKey).toBe("OPENAI_API_KEY");
      expect(secretRefManagedProviders.has("openai")).toBe(true);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("normalizes SecretRef-managed provider apiKey values to env markers", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    const secretRefManagedProviders = new Set<string>();
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        custom: {
          baseUrl: "https://config.example/v1",
          api: "openai-responses",
          apiKey: { source: "env", provider: "default", id: "CUSTOM_PROVIDER_API_KEY" },
          models: [createModel()],
        },
      };

      const normalized = normalizeProviders({
        providers,
        agentDir,
        secretRefManagedProviders,
      });

      expect(normalized?.custom?.apiKey).toBe("CUSTOM_PROVIDER_API_KEY"); // pragma: allowlist secret
      expect(secretRefManagedProviders.has("custom")).toBe(true);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("reads provider apiKey markers from auth-profiles env refs", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      await fs.writeFile(
        path.join(agentDir, "auth-profiles.json"),
        `${JSON.stringify(
          {
            version: 1,
            profiles: {
              "minimax:default": {
                type: "api_key",
                provider: "minimax",
                keyRef: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
              },
            },
          },
          null,
          2,
        )}\n`,
        "utf8",
      );

      const resolved = resolveApiKeyFromProfiles({
        provider: "minimax",
        store: {
          version: 1,
          profiles: {
            "minimax:default": {
              type: "api_key",
              provider: "minimax",
              keyRef: { source: "env", provider: "default", id: "MINIMAX_API_KEY" },
            },
          },
        },
        env: process.env,
      });

      expect(resolved?.apiKey).toBe("MINIMAX_API_KEY"); // pragma: allowlist secret
      expect(resolved?.source).toBe("env-ref");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("normalizes SecretRef-backed provider headers to non-secret marker values", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        openai: {
          baseUrl: "https://api.openai.com/v1",
          api: "openai-completions",
          headers: {
            Authorization: { source: "env", provider: "default", id: "OPENAI_HEADER_TOKEN" },
            "X-Tenant-Token": { source: "file", provider: "vault", id: "/openai/token" },
          },
          models: [],
        },
      };

      const normalized = normalizeProviders({
        providers,
        agentDir,
      });
      expect(normalized?.openai?.headers?.Authorization).toBe("secretref-env:OPENAI_HEADER_TOKEN");
      expect(normalized?.openai?.headers?.["X-Tenant-Token"]).toBe(NON_ENV_SECRETREF_MARKER);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("ignores non-object provider entries during source-managed enforcement", () => {
    const providers = {
      openai: null,
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: "sk-runtime-moonshot", // pragma: allowlist secret
        models: [],
      },
    } as unknown as NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]>;

    const sourceProviders: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
      openai: {
        baseUrl: "https://api.openai.com/v1",
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "OPENAI_API_KEY" }, // pragma: allowlist secret
        models: [],
      },
      moonshot: {
        baseUrl: "https://api.moonshot.ai/v1",
        api: "openai-completions",
        apiKey: { source: "env", provider: "default", id: "MOONSHOT_API_KEY" }, // pragma: allowlist secret
        models: [],
      },
    };

    const enforced = enforceSourceManagedProviderSecrets({
      providers,
      sourceProviders,
    });
    expect((enforced as Record<string, unknown>).openai).toBeNull();
    expect(enforced?.moonshot?.apiKey).toBe("MOONSHOT_API_KEY"); // pragma: allowlist secret
  });

  it("canonicalizes LM Studio baseUrl after merge-style explicit overwrite", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-agent-"));
    try {
      const providers: NonNullable<NonNullable<OpenClawConfig["models"]>["providers"]> = {
        lmstudio: {
          baseUrl: "http://localhost:1234/api/v1/",
          api: "openai-completions",
          apiKey: "LM_API_TOKEN",
          models: [],
        },
      };

      const normalized = normalizeProviders({ providers, agentDir });
      expect(normalized?.lmstudio?.baseUrl).toBe("http://localhost:1234/v1");
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });
});
