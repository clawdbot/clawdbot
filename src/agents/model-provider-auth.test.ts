import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { AuthProfileStore } from "./auth-profiles.js";
import { hasAuthForModelProvider } from "./model-provider-auth.js";

const emptyStore: AuthProfileStore = {
  version: 1,
  profiles: {},
};

function modelDefinition(id: string) {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text" as const],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
  };
}

describe("model provider auth availability", () => {
  it("accepts implicit Bedrock AWS SDK auth without an API key", () => {
    expect(
      hasAuthForModelProvider({
        provider: "amazon-bedrock",
        cfg: {} as OpenClawConfig,
        env: {},
        store: emptyStore,
      }),
    ).toBe(true);
  });

  it("accepts local no-key custom providers", () => {
    const cfg = {
      models: {
        providers: {
          vllm: {
            api: "openai-completions",
            baseUrl: "http://127.0.0.1:8000/v1",
            models: [modelDefinition("meta-llama/Meta-Llama-3-8B-Instruct")],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasAuthForModelProvider({
        provider: "vllm",
        cfg,
        env: {},
        store: emptyStore,
      }),
    ).toBe(true);
  });

  it("keeps remote no-key custom providers unavailable", () => {
    const cfg = {
      models: {
        providers: {
          remote: {
            api: "openai-completions",
            baseUrl: "https://remote.example.com/v1",
            models: [modelDefinition("remote-model")],
          },
        },
      },
    } as OpenClawConfig;

    expect(
      hasAuthForModelProvider({
        provider: "remote",
        cfg,
        env: {},
        store: emptyStore,
      }),
    ).toBe(false);
  });
});
