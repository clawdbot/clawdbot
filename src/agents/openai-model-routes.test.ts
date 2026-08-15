import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  openAIModelCatalogRoutePolicy,
  resolveConfiguredOpenAIAuthMode,
  resolveOpenAIModelRoutes,
  selectOpenAIModelRouteAuth,
} from "./openai-model-routes.js";
import { buildProviderModelAuthSourcePlan } from "./provider-model-auth-source-plan.js";

describe("OpenAI model route adapter", () => {
  it("normalizes profile-qualified model ids", () => {
    expect(
      resolveOpenAIModelRoutes({
        provider: "OpenAI",
        modelId: "gpt-5.5@work",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        env: {},
      }),
    ).toMatchObject({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        { api: "openai-responses", authRequirement: "api-key" },
        { api: "openai-chatgpt-responses", authRequirement: "subscription" },
      ],
    });
  });

  it("ignores other providers", () => {
    expect(resolveOpenAIModelRoutes({ provider: "anthropic", modelId: "gpt-5.5" })).toBeNull();
  });

  it("delegates configured auth and route selection to generic owners", () => {
    const config = {
      models: {
        providers: {
          openai: { auth: "oauth", models: [] },
        },
      },
    } as unknown as OpenClawConfig;
    const resolution = resolveOpenAIModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5",
      config,
      env: {},
    });
    if (!resolution || resolution.kind !== "routes") {
      throw new Error("expected OpenAI routes");
    }
    expect(resolveConfiguredOpenAIAuthMode(config)).toBe("oauth");
    expect(
      selectOpenAIModelRouteAuth({
        resolution,
        configuredAuthMode: "oauth",
        sourcePlan: buildProviderModelAuthSourcePlan({
          profiles: [
            {
              kind: "profile",
              profileId: "openai:chatgpt",
              mode: "oauth",
              readiness: "unknown",
              cooldown: "clear",
            },
          ],
        }),
      }),
    ).toMatchObject({
      kind: "selected",
      selection: {
        source: { profileId: "openai:chatgpt" },
        route: { authRequirement: "subscription" },
      },
    });
  });

  it("uses the provider-owned logical catalog identity", () => {
    expect(
      openAIModelCatalogRoutePolicy.resolveIdentity({
        provider: "OpenAI",
        id: "openai/gpt-5.4-codex@work",
      }),
    ).toEqual({ id: "gpt-5.4", key: "openai/gpt-5.4" });
    expect(
      openAIModelCatalogRoutePolicy.resolveIdentity({ provider: "custom", id: "custom/model" }),
    ).toBeNull();
  });
});
