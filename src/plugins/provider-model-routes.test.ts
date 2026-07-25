import { describe, expect, it, vi } from "vitest";
import type { ModelApi } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderResolveModelRoutesContext } from "../plugin-sdk/provider-model-types.js";
import {
  createProviderModelRoutesResolver,
  resolveProviderModelCatalogId,
  resolveProviderModelRoutes,
} from "./provider-model-routes.js";

describe("provider model route adapter", () => {
  it("does not invent an observed transport from a model id alone", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
      defaultRuntimeId: "codex",
    }));
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      config: {},
      env: {},
      surface: { resolveModelRoutes },
    });

    expect(resolveRoutes({ modelId: "gpt-5.4-nano" })).toEqual({
      kind: "indeterminate",
      defaultRuntimeId: "codex",
    });
    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.4-nano",
      requestTransportOverrides: "none",
      env: {},
    });
  });

  it("resolves only the requested model/config/env facts", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
      defaultRuntimeId: "codex",
    }));
    const env = { OPENAI_BASE_URL: "https://env.example.test/v1" };
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-completions",
            baseUrl: "https://provider.example.test/v1",
            models: [
              { id: "unrelated", api: "openai-chatgpt-responses" },
              {
                id: "gpt-5.5",
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveProviderModelRoutes({
        provider: "OPENAI",
        modelId: "gpt-5.5",
        config,
        env,
        surface: { resolveModelRoutes },
      }),
    ).toEqual({ kind: "indeterminate", defaultRuntimeId: "codex" });
    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5",
      requestTransportOverrides: "none",
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://model.example.test/v1",
      },
      configuredProvider: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
      },
      env,
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0].env).toBe(env);
  });

  it("passes the live environment view instead of cloning it", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));

    resolveProviderModelRoutes({
      provider: "openai",
      surface: { resolveModelRoutes },
    });

    expect(resolveModelRoutes.mock.calls[0]?.[0].env).toBe(process.env);
  });

  it("resolves catalog ids through the direct provider policy surface", () => {
    expect(
      resolveProviderModelCatalogId({
        provider: "OpenAI",
        modelId: "gpt-5.4-codex",
      }),
    ).toBe("gpt-5.4");
    expect(
      resolveProviderModelCatalogId({
        provider: "OpenAI",
        modelId: "openai/acme-model",
      }),
    ).toBe("openai/acme-model");
    expect(
      resolveProviderModelCatalogId({
        provider: "fixture",
        modelId: "demo-latest",
        surface: {},
      }),
    ).toBeNull();
  });

  it("preserves provider-scoped nested ids through route resolution", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: "openai/acme-model",
                api: "openai-completions",
                baseUrl: "https://acme.example.test/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "openai/acme-model",
      config,
      env: {},
      surface: {
        normalizeModelCatalogId: ({ modelId }) => modelId,
        resolveModelRoutes,
      },
    });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "openai/acme-model",
      requestTransportOverrides: "none",
      configuredModel: {
        api: "openai-completions",
        baseUrl: "https://acme.example.test/v1",
      },
      configuredProvider: { api: undefined, baseUrl: undefined },
      env: {},
    });
  });

  it("keeps configured model facts ahead of observed route facts", () => {
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example.test/v1",
            models: [
              {
                id: "gpt-5.5",
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    expect(
      resolveProviderModelRoutes({
        provider: "OPENAI",
        modelId: "gpt-5.5",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        config,
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
  });

  it.each([
    ["canonical config for legacy selection", "gpt-5.4", "gpt-5.4-codex"],
    ["legacy config for canonical selection", "gpt-5.4-codex", "gpt-5.4"],
  ] as const)("canonicalizes provider-owned aliases: %s", (_label, configuredId, requestedId) => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const normalizeModelCatalogId = vi.fn(({ modelId }: { modelId: string }) =>
      modelId === "gpt-5.4-codex" ? "gpt-5.4" : modelId,
    );
    const config = {
      models: {
        providers: {
          openai: {
            models: [
              {
                id: configuredId,
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
                headers: { "x-route-contract": "required" },
              },
            ],
          },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: requestedId,
      config,
      env: {},
      surface: { normalizeModelCatalogId, resolveModelRoutes },
    });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.4",
      requestTransportOverrides: "present",
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://model.example.test/v1",
      },
      configuredProvider: { api: undefined, baseUrl: undefined },
      env: {},
    });
  });

  it("forwards one reversed physical route group in one artifact call", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      env: {},
      surface: { resolveModelRoutes },
    });
    const observedRoutes = [
      {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
      { api: "openai-responses" as const, baseUrl: "https://api.openai.com/v1" },
    ];

    resolveRoutes({ modelId: "gpt-future-observed", observedRoutes });

    expect(resolveModelRoutes).toHaveBeenCalledOnce();
    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-future-observed",
      requestTransportOverrides: "none",
      env: {},
      observedRoutes,
    });
  });

  it("locks configured route facts while keeping the environment live", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const configuredModel: {
      id: string;
      api: ModelApi;
      baseUrl: string;
    } = {
      id: "demo",
      api: "openai-responses",
      baseUrl: "https://model-one.example.test/v1",
    };
    const configuredProvider: {
      api: ModelApi;
      baseUrl: string;
      authHeader?: boolean;
      models: Array<typeof configuredModel>;
    } = {
      api: "openai-completions",
      baseUrl: "https://provider-one.example.test/v1",
      models: [configuredModel],
    };
    const config = {
      models: { providers: { openai: configuredProvider } },
    } as unknown as OpenClawConfig;
    const env = { OPENAI_BASE_URL: "https://env-one.example.test/v1" };
    const resolveRoutes = createProviderModelRoutesResolver({
      provider: "openai",
      config,
      env,
      surface: { resolveModelRoutes },
    });

    configuredModel.api = "openai-completions";
    configuredModel.baseUrl = "https://model-two.example.test/v1";
    configuredProvider.api = "openai-responses";
    configuredProvider.authHeader = false;
    configuredProvider.baseUrl = "https://provider-two.example.test/v1";
    env.OPENAI_BASE_URL = "https://env-two.example.test/v1";
    resolveRoutes({ modelId: "demo" });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "demo",
      requestTransportOverrides: "none",
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://model-one.example.test/v1",
      },
      configuredProvider: {
        api: "openai-completions",
        baseUrl: "https://provider-one.example.test/v1",
      },
      env: { OPENAI_BASE_URL: "https://env-two.example.test/v1" },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0].env).toBe(env);
  });

  it("merges duplicate route facts only for the requested canonical model", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const config = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://provider.example.test/v1",
            models: [
              { id: "gpt-5.5" },
              {
                id: "gpt-5.5",
                api: "openai-responses",
                baseUrl: "https://model.example.test/v1",
              },
            ],
          },
          " openai ": { api: "openai-completions" },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });

    expect(resolveModelRoutes).toHaveBeenCalledWith({
      provider: "openai",
      modelId: "gpt-5.5",
      requestTransportOverrides: "none",
      configuredModel: {
        api: "openai-responses",
        baseUrl: "https://model.example.test/v1",
      },
      configuredProvider: {
        api: "openai-completions",
        baseUrl: "https://provider.example.test/v1",
      },
      env: {},
    });
  });

  it("keeps case-distinct provider keys and unknown model ids separate", () => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const config = {
      models: {
        providers: {
          OpenAI: {
            baseUrl: "https://case-fallback.example.test/v1",
            models: [{ id: "Foo", api: "openai-responses" }],
          },
          openai: {
            api: "openai-completions",
            models: [{ id: "foo", api: "openai-chatgpt-responses" }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "Foo",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      modelId: "Foo",
      configuredProvider: { api: "openai-completions" },
    });
    expect(resolveModelRoutes.mock.calls[0]?.[0]).not.toHaveProperty("configuredModel");

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "foo",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });
    expect(resolveModelRoutes.mock.calls[1]?.[0]).toMatchObject({
      modelId: "foo",
      configuredModel: { api: "openai-chatgpt-responses" },
    });
  });

  it.each([
    ["provider headers", { headers: { "x-route": "custom" } }, {}],
    ["provider request", { request: { allowPrivateNetwork: true } }, {}],
    ["provider local service", { localService: { command: "/custom-provider" } }, {}],
    ["provider auth header", { authHeader: false }, {}],
    ["provider request timeout", { timeoutSeconds: 90 }, {}],
    ["model headers", {}, { headers: { "x-model-route": "custom" } }],
    ["model compatibility", {}, { compat: { supportsStore: false } }],
  ])("projects %s without exposing its value", (_label, providerPatch, modelPatch) => {
    const resolveModelRoutes = vi.fn((_context: ProviderResolveModelRoutesContext) => ({
      kind: "indeterminate" as const,
    }));
    const config = {
      models: {
        providers: {
          openai: {
            api: "openai-responses",
            baseUrl: "https://api.openai.com/v1",
            ...providerPatch,
            models: [{ id: "gpt-5.5", ...modelPatch }],
          },
        },
      },
    } as unknown as OpenClawConfig;

    resolveProviderModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5",
      config,
      env: {},
      surface: { resolveModelRoutes },
    });

    expect(resolveModelRoutes.mock.calls[0]?.[0]).toMatchObject({
      requestTransportOverrides: "present",
    });
  });

  it("returns null when the provider artifact has no route hook", () => {
    expect(
      resolveProviderModelRoutes({ provider: "fixture", modelId: "demo", surface: {} }),
    ).toBeNull();
  });
});
