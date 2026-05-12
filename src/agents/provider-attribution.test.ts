import { describe, expect, it, vi } from "vitest";

function expectRecordFields(record: unknown, expected: Record<string, unknown>) {
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
    providerEndpoints: [
      { endpointClass: "openai-public", hosts: ["api.openai.com"] },
      { endpointClass: "openai-codex", hosts: ["chatgpt.com"] },
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
        hosts: ["api.x.ai", "api.grok.x.ai"],
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
        openrouter: { family: "openrouter" },
        qwen: { family: "modelstudio" },
        together: { family: "together" },
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

import {
  listProviderAttributionPolicies,
  resolveProviderAttributionHeaders,
  resolveProviderAttributionIdentity,
  resolveProviderAttributionPolicy,
  resolveProviderEndpoint,
  resolveProviderRequestAttributionHeaders,
  resolveProviderRequestCapabilities,
  resolveProviderRequestPolicy,
  describeProviderRequestRoutingSummary,
} from "./provider-attribution.js";

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

  it("normalizes aliases when resolving provider headers", () => {
    expect(
      resolveProviderAttributionHeaders("OpenRouter", {
        OPENCLAW_VERSION: "2026.3.22",
      }),
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
    expect(resolveProviderAttributionHeaders("openai", { OPENCLAW_VERSION: "2026.3.22" })).toEqual({
      originator: "openclaw",
      version: "2026.3.22",
      "User-Agent": "openclaw/2026.3.22",
    });
  });

  it("returns a hidden-spec OpenAI Codex attribution policy", () => {
    expect(
      resolveProviderAttributionPolicy("openai-codex", { OPENCLAW_VERSION: "2026.3.22" }),
    ).toEqual({
      provider: "openai-codex",
      enabledByDefault: true,
      verification: "vendor-hidden-api-spec",
      hook: "request-headers",
      reviewNote:
        "OpenAI Codex ChatGPT-backed traffic supports the same hidden originator/User-Agent attribution contract.",
      product: "OpenClaw",
      version: "2026.3.22",
      headers: {
        originator: "openclaw",
        version: "2026.3.22",
        "User-Agent": "openclaw/2026.3.22",
      },
    });
  });

  it("lists the current attribution support matrix", () => {
    expect(
      listProviderAttributionPolicies({ OPENCLAW_VERSION: "2026.3.22" }).map((policy) => [
        policy.provider,
        policy.enabledByDefault,
        policy.verification,
        policy.hook,
      ]),
    ).toEqual([
      ["openrouter", true, "vendor-documented", "request-headers"],
      ["openai", true, "vendor-hidden-api-spec", "request-headers"],
      ["openai-codex", true, "vendor-hidden-api-spec", "request-headers"],
      ["anthropic", false, "vendor-sdk-hook-only", "default-headers"],
      ["google", false, "vendor-sdk-hook-only", "user-agent-extra"],
      ["groq", false, "vendor-sdk-hook-only", "default-headers"],
      ["mistral", false, "vendor-sdk-hook-only", "custom-user-agent"],
      ["together", false, "vendor-sdk-hook-only", "default-headers"],
    ]);
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
        provider: "openai-codex",
        api: "openai-responses",
        baseUrl: "https://chatgpt.com/backend-api",
        transport: "stream",
        capability: "llm",
      }),
      {
        endpointClass: "openai-codex",
        attributionProvider: "openai-codex",
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
      endpointClass: "xai-native",
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
    expectRecordFields(resolveProviderEndpoint("https://opencode.ai/api"), {
      endpointClass: "opencode-native",
      hostname: "opencode.ai",
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
      resolveProviderRequestAttributionHeaders({
        provider: "openrouter",
        baseUrl: "https://proxy.example.com/v1",
        transport: "stream",
        capability: "llm",
      }),
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
        attributionProvider: undefined,
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

    expectRecordFields(resolveProviderEndpoint("attacker.example/?target=api.openai.com"), {
      endpointClass: "custom",
      hostname: "attacker.example",
    });

    expectRecordFields(resolveProviderEndpoint("openrouter.ai.attacker.example"), {
      endpointClass: "custom",
      hostname: "openrouter.ai.attacker.example",
    });
  });

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
          provider: "openai-codex",
          api: "openai-codex-responses",
          baseUrl: "https://chatgpt.com/backend-api/codex",
          capability: "llm" as const,
          transport: "stream" as const,
        },
        expected: {
          knownProviderFamily: "openai-family",
          endpointClass: "openai-codex",
          isKnownNativeEndpoint: true,
          allowsOpenAIServiceTier: true,
          supportsOpenAIReasoningCompatPayload: true,
          allowsResponsesStore: false,
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
