import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { legacyConfigRules, normalizeCompatibilityConfig } from "./doctor-contract-api.js";
import { inspectEmbeddingProviderSetup } from "./provider-policy-api.js";
import { buildLlamaCppProviderConfig } from "./src/defaults.js";

describe("llama.cpp doctor migration", () => {
  it("moves the shipped local URL to an absolute managed service", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "local://llama-cpp",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };

    const result = normalizeCompatibilityConfig({ cfg });
    const provider = result.config.models?.providers?.["llama-cpp"];
    expect(provider).toMatchObject({
      baseUrl: "http://127.0.0.1:19432/v1",
      localService: {
        command: expect.stringMatching(/llama-server(?:\.exe)?$/u),
        args: expect.arrayContaining(["--models-preset", "--metrics"]),
        healthUrl: "http://127.0.0.1:19432/health",
      },
    });
    expect(
      provider?.localService?.command.startsWith("/") ||
        /^[A-Z]:\\/iu.test(provider?.localService?.command ?? ""),
    ).toBe(true);
    expect(result.changes).toHaveLength(1);
    expect(normalizeCompatibilityConfig({ cfg: result.config }).changes).toEqual([]);
  });

  it("does not rewrite explicit HTTP llama.cpp servers", () => {
    const cfg: OpenClawConfig = {
      models: {
        providers: {
          "llama-cpp": {
            baseUrl: "http://gpu-box.local:8080/v1",
            api: "openai-completions",
            models: [],
          },
        },
      },
    };
    expect(normalizeCompatibilityConfig({ cfg })).toEqual({ config: cfg, changes: [] });
    expect(legacyConfigRules[0]?.match?.("http://gpu-box.local:8080/v1")).toBe(false);
  });

  it("reports the direct-start managed setup blocker with the supported CLI remediation", async () => {
    expect(
      inspectEmbeddingProviderSetup({
        config: {},
        env: {},
        agentId: "main",
        provider: "local",
      }),
    ).toEqual({
      provider: "local",
      reason: expect.stringContaining("Local embeddings need the managed llama.cpp server config"),
      requirement: "managed-llama-cpp-setup",
      fixHint:
        "Run `openclaw models --agent main auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
    });
  });

  it("accepts managed config produced by the models auth CLI without mutating it", async () => {
    const provider = buildLlamaCppProviderConfig(undefined, {
      command: "/managed/llama-server",
      baseUrl: "http://127.0.0.1:19432/v1",
      healthUrl: "http://127.0.0.1:19432/health",
      args: ["--models-preset", "/managed/models.ini"],
    });
    const config: OpenClawConfig = {
      models: { providers: { "llama-cpp": provider } },
    };
    const configBefore = JSON.stringify(config);

    expect(
      inspectEmbeddingProviderSetup({
        config,
        env: {},
        agentId: "main",
        provider: "local",
      }),
    ).toBeNull();

    expect(JSON.stringify(config)).toBe(configBefore);
  });

  it("does not apply managed llama.cpp setup to a non-local memory provider", async () => {
    expect(
      inspectEmbeddingProviderSetup({
        config: {},
        env: {},
        agentId: "main",
        provider: "openai",
      }),
    ).toBeNull();
  });
});
