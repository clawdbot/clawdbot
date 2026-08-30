import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { planOpenClawModelsJsonWithDeps } from "./models-config.plan.test-support.js";

type ResolveImplicitProviders = NonNullable<
  NonNullable<Parameters<typeof planOpenClawModelsJsonWithDeps>[1]>["resolveImplicitProviders"]
>;

function model(id: string, input: Array<"text" | "image"> = ["text"]) {
  return {
    id,
    name: id,
    reasoning: false,
    input,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1024,
    maxTokens: 1024,
  };
}

describe("models config input presence", () => {
  it.each([
    {
      name: "inherits discovered input when source input was omitted",
      sourceModels: [{ id: "vision-model", name: "vision-model" }],
      expected: ["text", "image"],
    },
    {
      name: "preserves text-only input when source input was explicit",
      sourceModels: [{ id: "vision-model", name: "vision-model", input: ["text"] }],
      expected: ["text"],
    },
    {
      name: "keeps materialized input when the source row is missing",
      sourceModels: [],
      expected: ["text"],
    },
  ] as const)("$name in the final generated models.json", async ({ sourceModels, expected }) => {
    const configuredProvider = {
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      apiKey: "AWS_PROFILE",
      models: [model("vision-model")],
    };
    const cfg: OpenClawConfig = {
      models: { providers: { "amazon-bedrock": configuredProvider } },
    };
    const sourceConfigForSecrets = {
      models: {
        providers: {
          "amazon-bedrock": {
            baseUrl: configuredProvider.baseUrl,
            apiKey: configuredProvider.apiKey,
            models: sourceModels,
          },
        },
      },
    } as unknown as OpenClawConfig;
    const resolveImplicitProviders = vi.fn<ResolveImplicitProviders>(async () => ({
      "amazon-bedrock": {
        ...configuredProvider,
        models: [model("vision-model", ["text", "image"])],
      },
    }));

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg,
        sourceConfigForSecrets,
        agentDir: "/tmp/openclaw-model-input-presence",
        env: { AWS_PROFILE: "default" },
        existingRaw: "",
        existingParsed: {},
      },
      { resolveImplicitProviders },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error(`expected write plan, got ${plan.action}`);
    }
    const generated = JSON.parse(plan.contents) as {
      providers: Record<string, { models?: Array<{ input?: string[] }> }>;
    };
    expect(generated.providers["amazon-bedrock"]?.models?.[0]?.input).toEqual(expected);
  });
});
