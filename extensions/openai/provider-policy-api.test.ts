// Openai tests cover provider policy api plugin behavior.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeModelCatalogId,
  resolveModelRoutes,
  resolveThinkingProfile,
} from "./provider-policy-api.js";

describe("OpenAI provider policy artifact", () => {
  beforeEach(() => {
    vi.stubEnv("OPENAI_BASE_URL", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("normalizes the legacy Codex model alias at the provider boundary", () => {
    expect(normalizeModelCatalogId({ provider: " OpenAI ", modelId: "openai/GPT-5.4-CODEX" })).toBe(
      "gpt-5.4",
    );
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "openai/gpt-5.4-codex",
        env: {},
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses" }, { api: "openai-chatgpt-responses" }],
    });
    expect(normalizeModelCatalogId({ provider: "openai", modelId: "openai/acme-model" })).toBe(
      "openai/acme-model",
    );
  });

  it("keeps OpenAI thinking policy for openai refs", () => {
    const codexProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3-codex-spark",
    });
    const openaiProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.3",
    });
    const openaiMiniProfile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.4-mini",
    });

    expect(codexProfile?.levels.map((level) => level.id)).toContain("xhigh");
    expect(openaiProfile?.levels.map((level) => level.id)).not.toContain("xhigh");
    expect(openaiMiniProfile?.levels.map((level) => level.id)).toContain("xhigh");
  });

  it("exposes max for the GPT-5.6 series", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
    })?.levels.map((level) => level.id);
    const lunaLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
    })?.levels.map((level) => level.id);

    expect(solLevels).toContain("max");
    expect(terraLevels).toContain("xhigh");
    expect(terraLevels).toContain("max");
    expect(lunaLevels).toContain("xhigh");
    expect(lunaLevels).toContain("max");
  });

  it.each([
    ["gpt-5.6-sol", "codex", "low"],
    ["gpt-5.6-sol", "openclaw", "low"],
    ["gpt-5.6-terra", "codex", "medium"],
    ["gpt-5.6-terra", "openclaw", "medium"],
    ["gpt-5.6-luna", "codex", "medium"],
    ["gpt-5.6-luna", "openclaw", "medium"],
  ])("uses the model default for %s on %s", (modelId, agentRuntime, expected) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId,
      agentRuntime,
    });

    expect(profile?.defaultLevel).toBe(expected);
  });

  it.each(["gpt-5.6", "gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"])(
    "exposes logical Ultra for %s on the OpenClaw runtime",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "openclaw",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "uses native Ultra fallback for %s when model/list metadata is unavailable",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it.each(["gpt-5.6-sol", "gpt-5.6-terra"])(
    "keeps native Ultra fallback for %s with direct OpenAI API metadata",
    (modelId) => {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
        compat: {
          supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
        },
      })?.levels.map((level) => level.id);

      expect(levels).toContain("ultra");
    },
  );

  it("does not invent native Ultra support for bare or suffixed GPT-5.6 refs", () => {
    for (const modelId of ["gpt-5.6", "gpt-5.6-sol-oai"]) {
      const levels = resolveThinkingProfile({
        provider: "openai",
        modelId,
        agentRuntime: "codex",
      })?.levels.map((level) => level.id);

      expect(levels).not.toContain("max");
      expect(levels).not.toContain("ultra");
    }
  });

  it("lets authoritative Codex model/list metadata override native fallbacks", () => {
    const solLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
    })?.levels.map((level) => level.id);
    const terraLevels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-terra",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      },
    })?.levels.map((level) => level.id);

    expect(solLevels).not.toContain("ultra");
    expect(terraLevels).toContain("ultra");
  });

  it.each([
    { efforts: [], expected: ["off"] },
    { efforts: ["high"], expected: ["off", "high"] },
  ])("uses the complete authoritative Codex effort list for $efforts", ({ efforts, expected }) => {
    const profile = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-sol",
      agentRuntime: "codex",
      compat: { supportedReasoningEfforts: efforts },
    });

    expect(profile?.levels.map((level) => level.id)).toEqual(expected);
    expect(profile?.defaultLevel).toBeUndefined();
  });

  it("keeps Codex Luna capped at Max without authoritative Ultra metadata", () => {
    const levels = resolveThinkingProfile({
      provider: "openai",
      modelId: "gpt-5.6-luna",
      agentRuntime: "codex",
      compat: {
        supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh", "max"],
      },
    })?.levels.map((level) => level.id);

    expect(levels).toContain("max");
    expect(levels).not.toContain("ultra");
  });
  it("orders Platform before ChatGPT for unconfigured routable models", () => {
    const expected = {
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    } as const;
    expect(resolveModelRoutes({ provider: "openai", modelId: "gpt-5.5" })).toEqual(expected);
    for (const observed of [
      { api: "openai-responses", baseUrl: "https://api.openai.com/v1" },
      { api: "openai-completions", baseUrl: "https://api.openai.com/v1" },
      {
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
      },
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          observedRoutes: [observed],
        }),
      ).toEqual(expected);
    }
  });

  it.each(["gpt-5.4-nano", "gpt-future-observed"])(
    "groups reversed physical routes for unknown logical model %s",
    (modelId) => {
      const platform = {
        api: "openai-responses" as const,
        baseUrl: "https://api.openai.com/v1",
      };
      const chatGPT = {
        api: "openai-chatgpt-responses" as const,
        baseUrl: "https://chatgpt.com/backend-api/codex",
      };
      const forward = resolveModelRoutes({
        provider: "openai",
        modelId,
        observedRoutes: [platform, chatGPT],
      });
      const reversed = resolveModelRoutes({
        provider: "openai",
        modelId,
        observedRoutes: [chatGPT, platform],
      });

      expect(reversed).toEqual(forward);
      expect(forward).toMatchObject({
        kind: "routes",
        routes: [
          { api: "openai-responses", authRequirement: "api-key" },
          { api: "openai-chatgpt-responses", authRequirement: "subscription" },
        ],
      });
    },
  );

  it("deduplicates equivalent custom URLs independently of observation order", () => {
    const withoutSlash = {
      api: "openai-responses" as const,
      baseUrl: "https://relay.example.test:443/v1",
    };
    const withSlash = {
      api: "openai-responses" as const,
      baseUrl: "https://relay.example.test/v1/",
    };
    const forward = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-future-observed",
      observedRoutes: [withoutSlash, withSlash],
    });
    const reversed = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-future-observed",
      observedRoutes: [withSlash, withoutSlash],
    });

    expect(reversed).toEqual(forward);
    expect(forward).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(forward.kind === "routes" ? forward.routes : []).toHaveLength(1);
  });

  it("rejects plaintext observations beside HTTPS routes", () => {
    const httpsRoute = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const httpRoute = {
      api: "openai-chatgpt-responses" as const,
      baseUrl: "http://chatgpt.com/backend-api/codex",
    };
    for (const observedRoutes of [
      [httpsRoute, httpRoute],
      [httpRoute, httpsRoute],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-future-observed",
          observedRoutes,
        }),
      ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    }
  });

  it("carries prepared request transport behavior across every candidate", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        requestTransportOverrides: "present",
      }),
    ).toMatchObject({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          requestTransportOverrides: "present",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
        {
          requestTransportOverrides: "present",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
  });

  it("lets authored model routes lock provider, environment, and observed facts", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: {
          api: "openai-responses",
          baseUrl: "https://model.example.test/v1",
        },
        configuredProvider: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://provider.example.test/v1",
        },
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
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

  it("preserves custom ChatGPT relays as subscription routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://proxy.example.test/v1",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://proxy.example.test/v1",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
  });

  it("preserves configured versus environment custom transport defaults", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: { baseUrl: "https://configured.example.test/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-completions", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
  });

  it("rejects unsupported observed adapters for authored custom endpoints", () => {
    for (const observedRoutes of [
      [{ api: "anthropic-messages" as const }],
      [{ api: "openai-responses" as const }, { api: "anthropic-messages" as const }],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl: "https://configured.example.test/v1" },
          observedRoutes,
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "unsupported-custom-openai-api",
      });
    }
  });

  it("rejects conflicting observed Platform adapters regardless of order", () => {
    for (const observedRoutes of [
      [{ api: "openai-responses" as const }, { api: "openai-completions" as const }],
      [{ api: "openai-completions" as const }, { api: "openai-responses" as const }],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl: "https://configured.example.test/v1" },
          observedRoutes,
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "ambiguous-openai-route-group",
      });
    }
  });

  it("ignores unauthored ChatGPT observations beside a Platform adapter", () => {
    for (const observedRoutes of [
      [{ api: "openai-chatgpt-responses" as const }, { api: "openai-responses" as const }],
      [{ api: "openai-responses" as const }, { api: "openai-chatgpt-responses" as const }],
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl: "https://configured.example.test/v1" },
          observedRoutes,
        }),
      ).toMatchObject({
        kind: "routes",
        routes: [{ api: "openai-responses", authRequirement: "api-key" }],
      });
    }
  });

  it("owns OPENAI_BASE_URL interpretation", () => {
    vi.stubEnv("OPENAI_BASE_URL", "https://process-env.example.test/v1");

    expect(resolveModelRoutes({ provider: "openai", modelId: "gpt-5.5" })).toMatchObject({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-responses",
          baseUrl: "https://process-env.example.test/v1",
          authRequirement: "api-key",
        },
      ],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://injected-env.example.test/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ baseUrl: "https://injected-env.example.test/v1" }],
    });
  });

  it("uses only API-key observed adapters for independently authored custom endpoints", () => {
    for (const [configured, observedApi] of [
      [
        { configuredProvider: { baseUrl: "https://configured.example.test/v1" } },
        "openai-completions",
      ],
      [{ env: { OPENAI_BASE_URL: "https://env.example.test/v1" } }, "openai-responses"],
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          ...configured,
          observedRoutes: [{ api: observedApi }],
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
        routes: [{ api: observedApi, authRequirement: "api-key" }],
      });
    }
  });

  it("ignores unrelated observed adapter conflicts for complete authored routes", () => {
    const observedRoutes = [
      { api: "openai-responses" as const },
      { api: "openai-completions" as const },
    ];

    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { api: "openai-chatgpt-responses" },
        observedRoutes,
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
        observedRoutes,
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
  });

  it("requires authored ChatGPT intent before sending subscription auth to a custom endpoint", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: { baseUrl: "https://configured.example.test/v1" },
        observedRoutes: [{ api: "openai-chatgpt-responses" }],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-completions", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        env: { OPENAI_BASE_URL: "https://env.example.test/v1" },
        observedRoutes: [{ api: "openai-chatgpt-responses" }],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://observed-relay.example.test/v1",
          },
        ],
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "custom-chatgpt-relay-requires-configuration",
    });
  });

  it("treats an environment Platform URL as an explicit route lock", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-responses", authRequirement: "api-key" }],
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        env: { OPENAI_BASE_URL: "https://api.openai.com/v1" },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
    });
  });

  it("routes unconfigured Spark only through ChatGPT", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "codex",
      routes: [
        {
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          authRequirement: "subscription",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw", "codex"] },
        },
      ],
    });
  });

  it("rejects explicitly authored Platform Spark routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        configuredProvider: {
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "subscription-only-model-on-platform",
    });
  });

  it("rejects conflicting official APIs and endpoints", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: {
          api: "openai-chatgpt-responses",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "conflicting-official-openai-route",
    });
  });

  it("rejects the wrong provider and unsupported official adapters", () => {
    expect(resolveModelRoutes({ provider: "anthropic", modelId: "gpt-5.5" })).toMatchObject({
      kind: "incompatible",
      code: "openai-route-provider-mismatch",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: {
          api: "anthropic-messages",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "unsupported-official-openai-api",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: {
          api: "anthropic-messages",
          baseUrl: "https://relay.example.test/v1",
        },
      }),
    ).toMatchObject({
      kind: "incompatible",
      code: "unsupported-custom-openai-api",
    });
  });

  it("inherits a provider adapter when the model overrides only its official base URL", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredModel: { baseUrl: "https://api.openai.com/v1" },
        configuredProvider: { api: "openai-completions" },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
  });

  it("inherits lower custom endpoints without changing the model adapter", () => {
    for (const [api, authRequirement] of [
      ["openai-chatgpt-responses", "subscription"],
      ["openai-responses", "api-key"],
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredModel: { api },
          configuredProvider: { baseUrl: "https://relay.example.test/v1" },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "openclaw",
        routes: [
          {
            api,
            baseUrl: "https://relay.example.test/v1",
            authRequirement,
          },
        ],
      });
    }
  });

  it("does not combine authored ChatGPT facts with an observed Platform row", () => {
    const observed = {
      api: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    } as const;
    for (const configuredModel of [
      { api: "openai-chatgpt-responses" },
      { baseUrl: "https://chatgpt.com/backend-api/v1" },
    ] as const) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredModel,
          observedRoutes: [observed],
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
            authRequirement: "subscription",
          },
        ],
      });
    }
  });

  it("rejects invalid configured routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        configuredProvider: { baseUrl: { url: "https://api.openai.com/v1" } },
      }),
    ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    for (const baseUrl of [
      "not a URL",
      "https://api.openai.com:8443/v1",
      "http://api.openai.com:443/v1",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1?proxy=1",
      "https://chatgpt.com/backend-api/codex#fragment",
    ]) {
      expect(
        resolveModelRoutes({ provider: "openai", configuredProvider: { baseUrl } }),
      ).toMatchObject({
        kind: "incompatible",
        code: "invalid-openai-base-url",
      });
    }
  });

  it("rejects internally contradictory observed routes", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://api.openai.com/v1",
          },
        ],
      }),
    ).toMatchObject({ kind: "incompatible", code: "conflicting-official-openai-route" });
    expect(
      resolveModelRoutes({
        provider: "openai",
        observedRoutes: [{ baseUrl: { url: "https://api.openai.com/v1" } }],
      }),
    ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    for (const baseUrl of [
      "not a URL",
      "https://api.openai.com:8443/v1",
      "http://api.openai.com:443/v1",
      "https://api.openai.com/v1/models",
      "https://api.openai.com/v1?proxy=1",
      "https://chatgpt.com/backend-api/codex#fragment",
    ]) {
      expect(
        resolveModelRoutes({ provider: "openai", observedRoutes: [{ baseUrl }] }),
      ).toMatchObject({
        kind: "incompatible",
        code: "invalid-openai-base-url",
      });
    }
  });

  it("rejects plaintext official routes", () => {
    for (const baseUrl of ["http://api.openai.com/v1", "http://chatgpt.com/backend-api/codex"]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl },
        }),
      ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-future-observed",
          observedRoutes: [{ baseUrl }],
        }),
      ).toMatchObject({ kind: "incompatible", code: "invalid-openai-base-url" });
    }
  });

  it("preserves explicit official completions and keeps them on OpenClaw", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5",
        configuredProvider: {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
        },
      }),
    ).toEqual({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [
        {
          api: "openai-completions",
          baseUrl: "https://api.openai.com/v1",
          authRequirement: "api-key",
          requestTransportOverrides: "none",
          runtimePolicy: { compatibleIds: ["openclaw"] },
        },
      ],
    });
    for (const modelId of ["chat-latest", "gpt-5.6"]) {
      expect(resolveModelRoutes({ provider: "openai", modelId })).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-responses", authRequirement: "api-key" }],
      });
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          configuredProvider: { api: "openai-chatgpt-responses" },
        }),
      ).toMatchObject({
        kind: "incompatible",
        code: "platform-only-model-on-chatgpt",
      });
    }
  });

  it("preserves explicit ChatGPT routes for known model contracts", () => {
    for (const modelId of ["gpt-5.3-chat-latest", "gpt-5.4-nano"]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId,
          configuredProvider: { api: "openai-chatgpt-responses" },
        }),
      ).toMatchObject({
        kind: "routes",
        defaultRuntimeId: "codex",
        routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
      });
    }
  });

  it("canonicalizes equivalent Platform URLs and keeps unknown variants single-route", () => {
    for (const baseUrl of [
      "https://api.openai.com",
      "https://api.openai.com/v1/",
      "https://api.openai.com:443/v1",
      "https://api.openai.com./v1",
    ]) {
      expect(
        resolveModelRoutes({
          provider: "openai",
          modelId: "gpt-5.5",
          configuredProvider: { baseUrl },
        }),
      ).toMatchObject({
        kind: "routes",
        routes: [{ baseUrl: "https://api.openai.com/v1" }],
      });
    }
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        observedRoutes: [{ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
      }),
    ).toMatchObject({ kind: "routes", routes: [{ api: "openai-responses" }] });
    const unknown = resolveModelRoutes({
      provider: "openai",
      modelId: "gpt-5.5-unknown",
      observedRoutes: [{ api: "openai-responses", baseUrl: "https://api.openai.com/v1" }],
    });
    expect(unknown.kind === "routes" ? unknown.routes : []).toHaveLength(1);
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        observedRoutes: [
          {
            api: "openai-chatgpt-responses",
            baseUrl: "https://chatgpt.com/backend-api/codex",
          },
        ],
      }),
    ).toMatchObject({
      kind: "routes",
      routes: [{ api: "openai-chatgpt-responses", authRequirement: "subscription" }],
    });
    expect(resolveModelRoutes({ provider: "openai", modelId: "gpt-5.5-unknown" })).toEqual({
      kind: "indeterminate",
      defaultRuntimeId: "codex",
    });
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.5-unknown",
        requestTransportOverrides: "present",
      }),
    ).toEqual({ kind: "indeterminate", defaultRuntimeId: "openclaw" });
  });

  it("allows custom endpoints to expose Spark-like ids", () => {
    expect(
      resolveModelRoutes({
        provider: "openai",
        modelId: "gpt-5.3-codex-spark",
        configuredModel: {
          api: "openai-responses",
          baseUrl: "https://relay.example.test/v1",
        },
      }),
    ).toMatchObject({
      kind: "routes",
      defaultRuntimeId: "openclaw",
      routes: [{ authRequirement: "api-key" }],
    });
  });
});
