import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { describe, expect, it } from "vitest";
import { inspectEmbeddingProviderSetup } from "./provider-policy-api.js";
import { buildLlamaCppProviderConfig } from "./src/defaults.js";

describe("llama.cpp embedding setup policy", () => {
  it("reports the direct-start managed setup blocker with the supported CLI remediation", () => {
    expect(
      inspectEmbeddingProviderSetup({ config: {}, env: {}, agentId: "main", provider: "local" }),
    ).toEqual({
      provider: "local",
      reason: expect.stringContaining("Local embeddings need the managed llama.cpp server config"),
      requirement: "managed-llama-cpp-setup",
      fixHint:
        "Run `openclaw models --agent main auth login --provider llama-cpp --method local` in an interactive terminal, then rerun this check.",
    });
  });

  it("accepts managed config produced by the models auth CLI without mutating it", () => {
    const provider = buildLlamaCppProviderConfig(undefined, {
      command: "/managed/llama-server",
      baseUrl: "http://127.0.0.1:19432/v1",
      healthUrl: "http://127.0.0.1:19432/health",
      args: ["--models-preset", "/managed/models.ini"],
    });
    const config: OpenClawConfig = { models: { providers: { "llama-cpp": provider } } };
    const configBefore = JSON.stringify(config);

    expect(
      inspectEmbeddingProviderSetup({ config, env: {}, agentId: "main", provider: "local" }),
    ).toBeNull();
    expect(JSON.stringify(config)).toBe(configBefore);
  });

  it("does not apply managed setup to a non-local memory provider", () => {
    expect(
      inspectEmbeddingProviderSetup({ config: {}, env: {}, agentId: "main", provider: "openai" }),
    ).toBeNull();
  });
});
