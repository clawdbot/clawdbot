// Verifies provider attribution headers and endpoint classification policies.
import { describe, expect, it, vi } from "vitest";

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
  // Policy helpers return broad records; assertions pin only the relevant fields.
  if (!record || typeof record !== "object") {
    throw new Error("Expected record");
  }
  const actual = record as Record<string, unknown>;
  for (const [key, value] of Object.entries(expected)) {
    expect(actual[key]).toEqual(value);
  }
  return actual;
}

const providerEndpointPlugins = vi.hoisted(() => [
  {
    // Mirrors manifest-declared endpoint metadata without loading real plugins.
    providerEndpoints: [
      {
        endpointClass: "openai-public",
        hosts: ["api.openai.com"],
        hostSuffixes: [".api.openai.com"],
      },
      { endpointClass: "openai", hosts: ["chatgpt.com"] },
      { endpointClass: "azure-openai", hostSuffixes: [".openai.azure.com"] },
      { endpointClass: "anthropic-public", hosts: ["api.anthropic.com"] },
      { endpointClass: "cerebras-native", hosts: ["api.cerebras.ai"] },
      { endpointClass: "mistral-public", hosts: ["api.mistral.ai"] },
      { endpointClass: "chutes-native", hosts: ["llm.chutes.ai"] },
      { endpointClass: "deepseek-native", hosts: ["api.deepseek.com"] },
      { endpointClass: "github-copilot-native", hostSuffixes: [".githubcopilot.com"] },
      { endpointClass: "groq-native", hosts: ["api.groq.com"] },
      { endpointClass: "opencode-native", hostSuffixes: ["opencode.ai"] },
      { endpointClass: "openrouter", hostSuffixes: ["openrouter.ai"] },
      { endpointClass: "zai-native", hosts: ["api.z.ai"] },
      { endpointClass: "google-generative-ai", hosts: ["generativelanguage.googleapis.com"] },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.googleapis.com"],
        googleVertexRegion: "global",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.eu.rep.googleapis.com"],
        googleVertexRegion: "eu",
      },
      {
        endpointClass: "google-vertex",
        hosts: ["aiplatform.us.rep.googleapis.com"],
        googleVertexRegion: "us",
      },
      {
        endpointClass: "google-vertex",
        hostSuffixes: ["-aiplatform.googleapis.com"],
        googleVertexRegionHostSuffix: "-aiplatform.googleapis.com",
      },
      {
        endpointClass: "moonshot-native",
        baseUrls: ["https://api.moonshot.ai/v1", "https://api.moonshot.cn/v1"],
      },
      {
        endpointClass: "modelstudio-native",
        baseUrls: [
          "https://coding-intl.dashscope.aliyuncs.com/v1",
          "https://coding.dashscope.aliyuncs.com/v1",
          "https://dashscope.aliyuncs.com/compatible-mode/v1",
          "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
        ],
      },
      {
        endpointClass: "xai-native",
        hosts: ["api.x.ai"],
      },
      {
        endpointClass: "nvidia-native",
        hosts: ["integrate.api.nvidia.com"],
        baseUrls: ["https://integrate.api.nvidia.com/v1"],
      },
      {
        endpointClass: "xiaomi-native",
        hosts: [
          "api.xiaomimimo.com",
          "token-plan-ams.xiaomimimo.com",
          "token-plan-cn.xiaomimimo.com",
          "token-plan-sgp.xiaomimimo.com",
        ],
      },
    ],
    providerRequest: {
      providers: {
        anthropic: { family: "anthropic" },
        cerebras: { family: "cerebras" },
        chutes: { family: "chutes" },
        deepseek: { family: "deepseek" },
        "github-copilot": { family: "github-copilot" },
        google: { family: "google" },
        groq: { family: "groq" },
        kimi: { family: "moonshot", compatibilityFamily: "moonshot" },
        mistral: { family: "mistral" },
        moonshot: { family: "moonshot", compatibilityFamily: "moonshot" },
        nvidia: { family: "nvidia" },
        openrouter: { family: "openrouter" },
        qwen: { family: "modelstudio" },
        together: { family: "together" },
        xiaomi: { family: "xiaomi" },
        "xiaomi-token-plan": { family: "xiaomi" },
        xai: { family: "xai" },
        zai: { family: "zai" },
      },
    },
  },
]);

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({
    plugins: providerEndpointPlugins,
    diagnostics: [],
  }),
}));

vi.mock("../plugins/manifest-metadata-scan.js", () => ({
  listOpenClawPluginManifestMetadata: () =>
    providerEndpointPlugins.map((manifest, index) => ({
      pluginDir: `provider-endpoint-fixture-${index}`,
      manifest,
      origin: "bundled",
    })),
}));

import {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
  describeProviderRequestRoutingSummary,
} from "./provider-attribution.js";

type ProviderAttributionTestEnv = Parameters<typeof resolveProviderRequestPolicy>[1];

function resolveProviderAttributionPolicy(provider: string, env: ProviderAttributionTestEnv) {
  return resolveProviderRequestPolicy({ provider }, env).policy;
}

function resolveProviderAttributionIdentity(env: ProviderAttributionTestEnv) {
  const policy = resolveProviderAttributionPolicy("openrouter", env);
  return policy ? { product: policy.product, version: policy.version } : undefined;
}

function listProviderAttributionPolicies(env: ProviderAttributionTestEnv) {
  return [
    "openrouter",
    "nvidia",
    "google",
    "openai",
    "xai",
    "anthropic",
    "groq",
    "mistral",
    "together",
  ].flatMap((provider) => {
    const policy = resolveProviderAttributionPolicy(provider, env);
    return policy ? [policy] : [];
  });
}

describe("provider attribution", () => {
  it("resolves the canonical OpenClaw product and runtime version", () => {
    const identity = resolveProviderAttributionIdentity({
      OPENCLAW_VERSION: "2026.3.99",
    });

    expect(identity).toEqual({
      product: "OpenClaw",
      version: "2026.3.99",
    });
  });

  it("returns a documented OpenRouter attribution policy", () => {
    const policy = resolveProviderAttributionPolicy("openrouter", {
      OPENCLAW_VERSION: "2026.3.22",
    });

    expect(policy).toEqual({
      provider: "openrouter",
      enabledByDefault: true,
      verification: "vendor-documented",
      hook: "request-headers",
      docsUrl: "https://openrouter.ai/docs/app-attribution",
      reviewNote: "Documented app attribution headers. Verified in OpenClaw runtime wrapper.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        "HTTP-Referer": "https://openclaw.ai",
        "X-OpenRouter-Title": "OpenClaw",
        "X-OpenRouter-Categories":
          "cli-agent,cloud-agent,programming-app,creative-writing,writing-assistant,general-chat,personal-agent",
      },
    });
  });

  it("returns a documented NVIDIA attribution policy", () => {
    const policy = resolveProviderAttributionPolicy("nvidia", {
      OPENCLAW_VERSION: "2026.3.22",
    });

    expect(policy).toBeDefined();
    expect(policy).toEqual({
      provider: "nvidia",
      enabledByDefault: true,
      verification: "vendor-documented",
      hook: "request-headers",
      reviewNote:
        "NVIDIA NIM billing invoke-origin attribution header. Applied only on verified NVIDIA routes.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        "X-BILLING-INVOKE-ORIGIN": "OpenClaw",
      },
    });
  });

  it("returns a documented Google Gemini attribution policy", () => {
    const policy = resolveProviderAttributionPolicy("google", {
      OPENCLAW_VERSION: "2026.3.22",
    });

    expect(policy).toEqual({
      provider: "google",
      enabledByDefault: true,
      verification: "vendor-documented",
      hook: "request-headers",
      docsUrl: "https://ai.google.dev/gemini-api/docs/partner-integration",
      reviewNote:
        "Gemini API partner integration guidance requires x-goog-api-client on partner and library traffic.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        "x-goog-api-client": "openclaw/2026.3.22",
      },
    });
  });

  it("normalizes aliases when resolving provider policy headers", () => {
    expect(
      resolveProviderAttributionPolicy("OpenRouter", {
        OPENCLAW_VERSION: "2026.3.22",
      })?.headers,
    ).toEqual({
      "HTTP-Referer": "https://openclaw.ai",
      "X-OpenRouter-Title": "OpenClaw",
      "X-OpenRouter-Categories":
        "cli-agent,cloud-agent,programming-app,creative-writing,writing-assistant,general-chat,personal-agent",
    });
  });

  it("returns a hidden-spec OpenAI attribution policy", () => {
    expect(resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      provider: "openai",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
    expect(
      resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.22" })?.headers,
    ).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("maps legacy OpenAI Codex attribution to canonical OpenAI policy", () => {
    expect(resolveProviderAttributionPolicy("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      provider: "openai",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "OpenAI native traffic supports hidden originator/User-Agent attribution. Verified against the Codex wire contract.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
  });

  it("returns a hidden-spec xAI attribution policy", () => {
    expect(resolveProviderAttributionPolicy("xai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      provider: "xai",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "xAI api.x.ai accepts a standard openclaw User-Agent. Companion originator/version headers mirror the OpenAI attribution shape for consistency; they are not validated against an xAI-specific spec and are expected to be ignored by xAI's OpenAI-compatible surface.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
    expect(
      resolveProviderAttributionPolicy("xai", { OPENCLAW_VERSION: "2026.3.22" })?.headers,
    ).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("lists the current attribution support matrix", () => {
    // Resolve every supported provider through the production request-policy path.
    expect(
      listProviderAttributionPolicies({ OPENCLAW_VERSION: "2026.3.22" }).map((policy) => [
        policy.provider,
        policy.enabledByDefault,
        policy.verification,
        policy.hook,
      ]),
    ).toEqual([
      ["openrouter", true, "vendor-documented", "request-headers"],
      ["nvidia", true, "vendor-documented", "request-headers"],
      ["google", true, "vendor-documented", "request-headers"],
      ["openai", true, "vendor-hidden-api-spec", "request-headers"],
      ["xai", true, "vendor-hidden-api-spec", "request-headers"],
      ["anthropic", false, "vendor-sdk-hook-only", "default-headers"],
      ["groq", false, "vendor-sdk-hook-only", "default-headers"],
      ["mistral", false, "vendor-sdk-hook-only", "custom-user-agent"],
      ["together", false, "vendor-sdk-hook-only", "default-headers"],
    ]);
  });

  it("authorizes hidden xAI attribution on api.x.ai and the default xAI route", () => {
    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "xai",
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "xai-native",
        attributionProvider: "xai",
        allowsHiddenAttribution: true,
      },
    );
    expect(
      resolveProviderRequestPolicy(
        {
          provider: "xai",
          api: "openai-responses",
          baseUrl: "https://api.x.ai/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ).attributionHeaders,
    ).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });

    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "xai",
          api: "openai-responses",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "default",
        attributionProvider: "xai",
      },
    );

    // Custom proxy baseUrl should withhold xAI attribution.
    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "xai",
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "custom",
        attributionProvider: undefined,
        allowsHiddenAttribution: false,
      },
    );
  });

  it("authorizes hidden OpenAI attribution only on verified native hosts", () => {
    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "openai-public",
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
        usesKnownNativeOpenAIEndpoint: true,
        usesVerifiedOpenAIAttributionHost: true,
        usesExplicitProxyLikeEndpoint: false,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "custom",
        attributionProvider: undefined,
        allowsHiddenAttribution: false,
        usesKnownNativeOpenAIEndpoint: false,
        usesVerifiedOpenAIAttributionHost: false,
        usesExplicitProxyLikeEndpoint: true,
      },
    );
  });

  it("classifies OpenAI-family default, codex, and Azure routes distinctly", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-responses",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "default",
        attributionProvider: undefined,
        usesKnownNativeOpenAIRoute: true,
        usesExplicitProxyLikeEndpoint: false,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "openai",
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "azure-openai",
        api: "azure-openai-responses",
        baseUrl: "https://tenant.openai.azure.com/openai/v1",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "azure-openai",
        attributionProvider: undefined,
        allowsHiddenAttribution: false,
        usesKnownNativeOpenAIEndpoint: true,
      },
    );
  });

  it("classifies native Mistral hosts centrally", () => {
    expectRecordFields(resolveProviderEndpoint("https://api.mistral.ai/v1"), {
      endpointClass: "mistral-public",
      hostname: "api.mistral.ai",
    });

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "mistral",
        api: "openai-completions",
        baseUrl: "https://api.mistral.ai/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "mistral-public",
        isKnownNativeEndpoint: true,
        knownProviderFamily: "mistral",
      },
    );
  });

  it("classifies native OpenAI-compatible vendor hosts centrally", () => {
    expectRecordFields(resolveProviderEndpoint("https://api.x.ai/v1"), {
      endpointClass: "xai-native",
      hostname: "api.x.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.grok.x.ai/v1"), {
      endpointClass: "custom",
      hostname: "api.grok.x.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.z.ai/api/coding/paas/v4"), {
      endpointClass: "zai-native",
      hostname: "api.z.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.deepseek.com"), {
      endpointClass: "deepseek-native",
      hostname: "api.deepseek.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://llm.chutes.ai/v1"), {
      endpointClass: "chutes-native",
      hostname: "llm.chutes.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.groq.com/openai/v1"), {
      endpointClass: "groq-native",
      hostname: "api.groq.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.cerebras.ai/v1"), {
      endpointClass: "cerebras-native",
      hostname: "api.cerebras.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://integrate.api.nvidia.com/v1"), {
      endpointClass: "nvidia-native",
      hostname: "integrate.api.nvidia.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://opencode.ai/api"), {
      endpointClass: "opencode-native",
      hostname: "opencode.ai",
    });
    expectRecordFields(resolveProviderEndpoint("https://api.xiaomimimo.com/v1"), {
      endpointClass: "xiaomi-native",
      hostname: "api.xiaomimimo.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://token-plan-ams.xiaomimimo.com/v1"), {
      endpointClass: "xiaomi-native",
      hostname: "token-plan-ams.xiaomimimo.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://token-plan-cn.xiaomimimo.com/v1"), {
      endpointClass: "xiaomi-native",
      hostname: "token-plan-cn.xiaomimimo.com",
    });
    expectRecordFields(resolveProviderEndpoint("https://token-plan-sgp.xiaomimimo.com/v1"), {
      endpointClass: "xiaomi-native",
      hostname: "token-plan-sgp.xiaomimimo.com",
    });
  });

  it("treats OpenRouter-hosted Responses routes as explicit proxy-like endpoints", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openrouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "openrouter",
        usesExplicitProxyLikeEndpoint: true,
        attributionProvider: "openrouter",
      },
    );
  });

  it("gates documented OpenRouter attribution to known OpenRouter endpoints", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openrouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "openrouter",
        attributionProvider: "openrouter",
        allowsHiddenAttribution: false,
      },
    );

    expect(
      resolveProviderRequestPolicy({
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        transport: "stream",
        capability: "llm",
      }).attributionHeaders,
    ).toBeUndefined();
  });

  it("gates documented NVIDIA attribution to official NVIDIA NIM endpoints", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "nvidia",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "nvidia-native",
        knownProviderFamily: "nvidia",
        attributionProvider: "nvidia",
        allowsHiddenAttribution: false,
      },
    );

    expect(
      resolveProviderRequestPolicy({
        provider: "custom-nim",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        transport: "stream",
        capability: "llm",
      }).attributionHeaders,
    ).toEqual({
      "X-BILLING-INVOKE-ORIGIN": "OpenClaw",
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "nvidia",
        api: "openai-completions",
        baseUrl: "https://proxy.example.com/v1",
        transport: "stream",
        capability: "llm",
      }).attributionHeaders,
    ).toBeUndefined();
  });

  it("gates documented Google Gemini attribution to official Generative Language endpoints", () => {
    expectRecordFields(
      resolveProviderRequestPolicy(
        {
          provider: "google",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ),
      {
        endpointClass: "google-generative-ai",
        knownProviderFamily: "google",
        attributionProvider: "google",
        allowsHiddenAttribution: false,
      },
    );

    expect(
      resolveProviderRequestPolicy(
        {
          provider: "google",
          api: "openai-completions",
          baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
          transport: "stream",
          capability: "llm",
        },
        { OPENCLAW_VERSION: "2026.3.22" },
      ).attributionHeaders,
    ).toEqual({
      "x-goog-api-client": "openclaw/2026.3.22",
    });

    expect(
      resolveProviderRequestPolicy({
        provider: "google",
        api: "google-generative-ai",
        baseUrl: "https://proxy.example.com/v1beta",
        transport: "stream",
        capability: "llm",
      }).attributionHeaders,
    ).toBeUndefined();
  });

  it("summarizes proxy-like, local, invalid, default, and native routing compactly", () => {
    expect(
      describeProviderRequestRoutingSummary({
        provider: "openai",
        api: "openai-responses",
      }),
    ).toBe("provider=openai api=openai-responses endpoint=default route=default policy=none");

    expect(
      describeProviderRequestRoutingSummary({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "javascript:alert(1)",
      }),
    ).toBe("provider=openai api=openai-responses endpoint=invalid route=invalid policy=none");

    expect(
      describeProviderRequestRoutingSummary({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe("provider=openai api=openai-responses endpoint=custom route=proxy-like policy=none");

    expect(
      describeProviderRequestRoutingSummary({
        provider: "qwen",
        api: "openai-responses",
        baseUrl: "http://localhost:1234/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe("provider=qwen api=openai-responses endpoint=local route=local policy=none");

    expect(
      describeProviderRequestRoutingSummary({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe(
      "provider=openai api=openai-responses endpoint=openai-public route=native policy=hidden",
    );

    expect(
      describeProviderRequestRoutingSummary({
        provider: "openrouter",
        api: "openai-responses",
        baseUrl: "https://openrouter.ai/api/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe(
      "provider=openrouter api=openai-responses endpoint=openrouter route=proxy-like policy=documented",
    );

    expect(
      describeProviderRequestRoutingSummary({
        provider: "groq",
        api: "openai-completions",
        baseUrl: "https://api.groq.com/openai/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe("provider=groq api=openai-completions endpoint=groq-native route=native policy=none");

    expect(
      describeProviderRequestRoutingSummary({
        provider: "nvidia",
        api: "openai-completions",
        baseUrl: "https://integrate.api.nvidia.com/v1",
        transport: "stream",
        capability: "llm",
      }),
    ).toBe(
      "provider=nvidia api=openai-completions endpoint=nvidia-native route=native policy=documented",
    );
  });

  it("models other provider families without enabling hidden attribution", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "google",
        baseUrl: "https://generativelanguage.googleapis.com",
        transport: "http",
        capability: "image",
      }),
      {
        knownProviderFamily: "google",
        attributionProvider: "google",
        allowsHiddenAttribution: false,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "github-copilot",
        transport: "http",
        capability: "llm",
      }),
      {
        knownProviderFamily: "github-copilot",
        attributionProvider: undefined,
        allowsHiddenAttribution: false,
      },
    );
  });

  it("classifies native Anthropic endpoints separately from custom hosts", () => {
    expectRecordFields(resolveProviderEndpoint("https://api.anthropic.com/v1"), {
      endpointClass: "anthropic-public",
      hostname: "api.anthropic.com",
    });

    expectRecordFields(resolveProviderEndpoint("https://proxy.example.com/anthropic"), {
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies Google Gemini and Vertex endpoints separately from custom hosts", () => {
    expectRecordFields(resolveProviderEndpoint("https://generativelanguage.googleapis.com"), {
      endpointClass: "google-generative-ai",
      hostname: "generativelanguage.googleapis.com",
    });

    expectRecordFields(
      resolveProviderEndpoint("https://europe-west4-aiplatform.googleapis.com/v1/projects/test"),
      {
        endpointClass: "google-vertex",
        hostname: "europe-west4-aiplatform.googleapis.com",
        googleVertexRegion: "europe-west4",
      },
    );

    expectRecordFields(resolveProviderEndpoint("https://aiplatform.googleapis.com"), {
      endpointClass: "google-vertex",
      hostname: "aiplatform.googleapis.com",
      googleVertexRegion: "global",
    });

    expectRecordFields(resolveProviderEndpoint("https://aiplatform.eu.rep.googleapis.com"), {
      endpointClass: "google-vertex",
      hostname: "aiplatform.eu.rep.googleapis.com",
      googleVertexRegion: "eu",
    });

    expectRecordFields(resolveProviderEndpoint("https://aiplatform.us.rep.googleapis.com"), {
      endpointClass: "google-vertex",
      hostname: "aiplatform.us.rep.googleapis.com",
      googleVertexRegion: "us",
    });

    expectRecordFields(resolveProviderEndpoint("https://discoveryengine.eu.rep.googleapis.com"), {
      endpointClass: "custom",
      hostname: "discoveryengine.eu.rep.googleapis.com",
    });

    expectRecordFields(resolveProviderEndpoint("https://proxy.example.com/google"), {
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies native Moonshot and ModelStudio endpoints separately from custom hosts", () => {
    expectRecordFields(resolveProviderEndpoint("https://api.moonshot.ai/v1"), {
      endpointClass: "moonshot-native",
      hostname: "api.moonshot.ai",
    });

    expectRecordFields(resolveProviderEndpoint("https://api.moonshot.cn/v1"), {
      endpointClass: "moonshot-native",
      hostname: "api.moonshot.cn",
    });

    expectRecordFields(
      resolveProviderEndpoint("https://dashscope-intl.aliyuncs.com/compatible-mode/v1"),
      {
        endpointClass: "modelstudio-native",
        hostname: "dashscope-intl.aliyuncs.com",
      },
    );

    expectRecordFields(resolveProviderEndpoint("https://proxy.example.com/v1"), {
      endpointClass: "custom",
      hostname: "proxy.example.com",
    });
  });

  it("classifies native GitHub Copilot endpoints separately from custom hosts", () => {
    expectRecordFields(resolveProviderEndpoint("https://api.individual.githubcopilot.com"), {
      endpointClass: "github-copilot-native",
      hostname: "api.individual.githubcopilot.com",
    });

    expectRecordFields(resolveProviderEndpoint("https://api.enterprise.githubcopilot.com"), {
      endpointClass: "github-copilot-native",
      hostname: "api.enterprise.githubcopilot.com",
    });

    expectRecordFields(resolveProviderEndpoint("https://api.githubcopilot.example.com"), {
      endpointClass: "custom",
      hostname: "api.githubcopilot.example.com",
    });
  });

  it("does not classify malformed or embedded Google host strings as native endpoints", () => {
    expectRecordFields(resolveProviderEndpoint("proxy/generativelanguage.googleapis.com"), {
      endpointClass: "custom",
      hostname: "proxy",
    });

    expectRecordFields(resolveProviderEndpoint("https://xgenerativelanguage.googleapis.com"), {
      endpointClass: "custom",
      hostname: "xgenerativelanguage.googleapis.com",
    });

    expectRecordFields(resolveProviderEndpoint("proxy/aiplatform.googleapis.com"), {
      endpointClass: "custom",
      hostname: "proxy",
    });

    expectRecordFields(resolveProviderEndpoint("https://xaiplatform.googleapis.com"), {
      endpointClass: "custom",
      hostname: "xaiplatform.googleapis.com",
    });
  });

  it("does not trust schemeless or embedded trusted-provider substrings", () => {
    expectRecordFields(resolveProviderEndpoint("api.anthropic.com.attacker.example"), {
      endpointClass: "custom",
      hostname: "api.anthropic.com.attacker.example",
    });

    expectRecordFields(resolveProviderEndpoint("api.openai.com.attacker.example"), {
      endpointClass: "custom",
      hostname: "api.openai.com.attacker.example",
    });

    expectRecordFields(resolveProviderEndpoint("https://attackerapi.openai.com"), {
      endpointClass: "custom",
      hostname: "attackerapi.openai.com",
    });

    expectRecordFields(resolveProviderEndpoint("attacker.example/?target=api.openai.com"), {
      endpointClass: "custom",
      hostname: "attacker.example",
    });

    expectRecordFields(resolveProviderEndpoint("openrouter.ai.attacker.example"), {
      endpointClass: "custom",
      hostname: "openrouter.ai.attacker.example",
    });
  });

  it.each(["https://us.api.openai.com/v1", "https://eu.api.openai.com/v1"])(
    "classifies regional OpenAI endpoint %s as public",
    (baseUrl) => {
      expectRecordFields(resolveProviderEndpoint(baseUrl), {
        endpointClass: "openai-public",
      });
    },
  );

  it("ignores non-http schemes when normalizing native comparable base URLs", () => {
    expectRecordFields(resolveProviderEndpoint("javascript:alert(1)"), {
      endpointClass: "invalid",
    });
  });

  it("applies OpenAI attribution to every verified native capability", () => {
    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-audio-transcriptions",
        baseUrl: "https://api.openai.com/v1",
        transport: "media-understanding",
        capability: "audio",
      }),
      {
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        transport: "media-understanding",
        capability: "audio",
      }),
      {
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        transport: "http",
        capability: "image",
      }),
      {
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestPolicy({
        provider: "openai",
        baseUrl: "https://api.openai.com/v1",
        transport: "websocket",
        capability: "audio",
      }),
      {
        attributionProvider: "openai",
        allowsHiddenAttribution: true,
      },
    );
  });

  it("resolves centralized request capabilities for native and proxied routes", () => {
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "openai-public",
        allowsOpenAIServiceTier: true,
        supportsOpenAIReasoningCompatPayload: true,
        allowsResponsesStore: true,
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: false,
      },
    );
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "openai",
        api: "openai-chatgpt-responses",
        baseUrl: "https://chatgpt.com/backend-api/codex",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "openai",
        attributionProvider: "openai",
        allowsOpenAIServiceTier: true,
        supportsOpenAIReasoningCompatPayload: true,
        allowsResponsesStore: true,
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: false,
      },
    );

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "anthropic",
        api: "anthropic-messages",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "default",
        allowsAnthropicServiceTier: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "custom-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "custom",
        allowsOpenAIServiceTier: false,
        supportsOpenAIReasoningCompatPayload: false,
        allowsResponsesStore: false,
        supportsResponsesStoreField: true,
        shouldStripResponsesPromptCache: true,
      },
    );
  });

  it("respects compat.supportsPromptCacheKey override on prompt cache stripping", () => {
    // compat.supportsPromptCacheKey = true disables the strip even on a
    // proxy-like endpoint that would otherwise trigger it.
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "custom-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        capability: "llm",
        transport: "stream",
        compat: { supportsPromptCacheKey: true },
      }),
      {
        endpointClass: "custom",
        shouldStripResponsesPromptCache: false,
      },
    );

    // compat.supportsPromptCacheKey = false forces the strip even on a
    // native OpenAI endpoint that would otherwise forward the field.
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "openai",
        api: "openai-responses",
        baseUrl: "https://api.openai.com/v1",
        capability: "llm",
        transport: "stream",
        compat: { supportsPromptCacheKey: false },
      }),
      {
        endpointClass: "openai-public",
        shouldStripResponsesPromptCache: true,
      },
    );

    // compat.supportsPromptCacheKey unset preserves the existing default
    // (strip on proxy-like responses endpoints, preserving the fix from
    // #48155 for providers that reject the field).
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "custom-proxy",
        api: "openai-responses",
        baseUrl: "https://proxy.example.com/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        shouldStripResponsesPromptCache: true,
      },
    );
  });

  it("resolves shared compat families and native streaming-usage gates", () => {
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "moonshot",
        api: "openai-completions",
        baseUrl: "https://api.moonshot.ai/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "moonshot-native",
        supportsNativeStreamingUsageCompat: true,
        compatibilityFamily: "moonshot",
      },
    );

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "qwen",
        api: "openai-completions",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "modelstudio-native",
        supportsNativeStreamingUsageCompat: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "generic",
        api: "openai-completions",
        baseUrl: "https://coding.dashscope.aliyuncs.com/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "modelstudio-native",
        supportsNativeStreamingUsageCompat: true,
      },
    );

    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "custom-local",
        api: "openai-completions",
        baseUrl: "http://127.0.0.1:11434/v1",
        capability: "llm",
        transport: "stream",
      }),
      {
        endpointClass: "local",
        supportsNativeStreamingUsageCompat: false,
      },
    );
  });

  it("treats native GitHub Copilot base URLs as known native endpoints", () => {
    expectRecordFields(
      resolveProviderRequestCapabilities({
        provider: "github-copilot",
        api: "openai-responses",
        baseUrl: "https://api.individual.githubcopilot.com",
        capability: "llm",
        transport: "http",
      }),
      {
        endpointClass: "github-copilot-native",
        knownProviderFamily: "github-copilot",
        isKnownNativeEndpoint: true,
      },
    );
  });

  it("resolves a provider capability matrix for representative native and proxied routes", () => {
    const cases = [
      {
        name: "native OpenAI responses",
        input: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://api.openai.com/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "openai-family",
          endpointClass: "openai-public",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: true,
          supportsOpenAIReasoningCompatPayload: true,
          allowsResponsesStore: true,
          supportsResponsesStoreField: true,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "proxied OpenAI responses",
        input: {
          provider: "openai",
          api: "openai-responses",
          baseUrl: "https://proxy.example.com/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "openai-family",
          endpointClass: "custom",
          isKnownNativeEndpoint: false,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: true,
          shouldStripResponsesPromptCache: true,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "direct Anthropic messages",
        input: {
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "https://api.anthropic.com/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "anthropic",
          endpointClass: "anthropic-public",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: false,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: true,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "proxied custom anthropic api",
        input: {
          provider: "custom-anthropic",
          api: "anthropic-messages",
          baseUrl: "https://proxy.example.com/anthropic",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          endpointClass: "custom",
          isKnownNativeEndpoint: false,
          allowsAnthropicServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          supportsResponsesStoreField: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "native OpenRouter responses",
        input: {
          provider: "openrouter",
          api: "openai-responses",
          baseUrl: "https://openrouter.ai/api/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "openrouter",
          endpointClass: "openrouter",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: true,
          shouldStripResponsesPromptCache: true,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "native Moonshot completions",
        input: {
          provider: "moonshot",
          api: "openai-completions",
          baseUrl: "https://api.moonshot.ai/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "moonshot",
          endpointClass: "moonshot-native",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: false,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: true,
          compatibilityFamily: "moonshot",
        },
      },
      {
        name: "native Qwen completions",
        input: {
          provider: "qwen",
          api: "openai-completions",
          baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "modelstudio",
          endpointClass: "modelstudio-native",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: false,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: true,
        },
      },
      {
        name: "generic provider on native DashScope completions",
        input: {
          provider: "generic",
          api: "openai-completions",
          baseUrl: "https://coding-intl.dashscope.aliyuncs.com/v1",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "generic",
          endpointClass: "modelstudio-native",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: false,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: true,
        },
      },
      {
        name: "native Google Gemini api",
        input: {
          provider: "google",
          api: "google-generative-ai",
          baseUrl: "https://generativelanguage.googleapis.com",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "google",
          endpointClass: "google-generative-ai",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: false,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "native GitHub Copilot responses",
        input: {
          provider: "github-copilot",
          api: "openai-responses",
          baseUrl: "https://api.individual.githubcopilot.com",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "github-copilot",
          endpointClass: "github-copilot-native",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: false,
          supportsOpenAIReasoningCompatPayload: false,
          allowsResponsesStore: false,
          supportsResponsesStoreField: true,
          shouldStripResponsesPromptCache: true,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
      {
        name: "native OpenAI Codex responses",
        input: {
          provider: "openai",
          api: "openai-chatgpt-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "openai-family",
          endpointClass: "openai",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: true,
          supportsOpenAIReasoningCompatPayload: true,
          allowsResponsesStore: true,
          supportsResponsesStoreField: true,
          shouldStripResponsesPromptCache: false,
          allowsAnthropicServiceTier: false,
          supportsNativeStreamingUsageCompat: false,
        },
      },
    ];

    for (const testCase of cases) {
      expectRecordFields(resolveProviderRequestCapabilities(testCase.input), testCase.expected);
    }
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
