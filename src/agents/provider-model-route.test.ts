import { describe, expect, it } from "vitest";
import {
  createProviderModelCatalogRoutePolicy,
  modelMatchesProviderModelRoute,
  projectProviderModelRouteConfig,
} from "./provider-model-route.js";

const platformRoute = {
  api: "openai-responses",
  baseUrl: "https://api.openai.com/v1",
  authRequirement: "api-key",
  requestTransportOverrides: "none",
} as const;

describe("provider model route consumers", () => {
  it("matches exact and owner-canonical endpoint spellings", () => {
    for (const baseUrl of [
      "https://api.openai.com/v1/",
      "https://api.openai.com",
      "https://api.openai.com:443/v1",
    ]) {
      expect(
        modelMatchesProviderModelRoute({
          provider: "openai",
          api: "openai-responses",
          baseUrl,
          route: platformRoute,
        }),
      ).toBe(true);
    }
    expect(
      modelMatchesProviderModelRoute({
        provider: "openai",
        api: "openai-completions",
        baseUrl: platformRoute.baseUrl,
        route: platformRoute,
      }),
    ).toBe(false);
  });

  it("projects a selected route onto only the normalized provider owner", () => {
    const config = projectProviderModelRouteConfig({
      provider: "openai",
      config: {
        models: {
          providers: {
            openai: {
              auth: "oauth",
              baseUrl: "https://api.openai.com/v1",
              models: [],
            },
            " OpenAI ": {
              auth: "api-key",
              api: "openai-completions",
              baseUrl: "https://legacy.example.test/v1",
              models: [],
            },
          },
        },
      },
      route: platformRoute,
    });

    expect(Object.keys(config.models?.providers ?? {})).toEqual(["openai"]);
    expect(config.models?.providers?.openai).toMatchObject({
      auth: "api-key",
      api: platformRoute.api,
      baseUrl: platformRoute.baseUrl,
      models: [],
    });
  });

  it("creates provider-scoped logical catalog policy", () => {
    const policy = createProviderModelCatalogRoutePolicy("openai");
    expect(policy.resolveIdentity({ provider: "OpenAI", id: "gpt-5.4-codex" })).toEqual({
      id: "gpt-5.4",
      key: "openai/gpt-5.4",
    });
    expect(policy.resolveIdentity({ provider: "openai", id: "openai/acme-model" })).toEqual({
      id: "openai/acme-model",
      key: "openai/openai/acme-model",
    });
    expect(policy.resolveIdentity({ provider: "anthropic", id: "gpt-5.4-codex" })).toBeNull();
  });
});
