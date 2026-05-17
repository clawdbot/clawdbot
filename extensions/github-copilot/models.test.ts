import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildCopilotModelDefinition, getDefaultCopilotModelIds } from "./models-defaults.js";
import { deriveCopilotApiBaseUrlFromToken, resolveCopilotApiToken } from "./token.js";
import { fetchCopilotUsage } from "./usage.js";

vi.mock("@earendil-works/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@earendil-works/pi-ai/oauth")>(
    "@earendil-works/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
  };
});

vi.mock("openclaw/plugin-sdk/provider-model-shared", () => ({
  normalizeModelCompat: (model: Record<string, unknown>) => model,
  resolveProviderEndpoint: (baseUrl: string) => ({
    baseUrl,
    endpointClass: "custom",
    warnings: [],
  }),
}));

const jsonStoreMocks = vi.hoisted(() => ({
  loadJsonFile: vi.fn(),
  saveJsonFile: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/json-store", () => ({
  loadJsonFile: jsonStoreMocks.loadJsonFile,
  saveJsonFile: jsonStoreMocks.saveJsonFile,
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-state",
}));

import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import { fetchCopilotModelCatalog, resolveCopilotForwardCompatModel } from "./models.js";

function createMockCtx(
  modelId: string,
  registryModels: Record<string, Record<string, unknown>> = {},
): ProviderResolveDynamicModelContext {
  return {
    modelId,
    provider: "github-copilot",
    config: {},
    modelRegistry: {
      find: (provider: string, id: string) => registryModels[`${provider}/${id}`] ?? null,
    },
  } as unknown as ProviderResolveDynamicModelContext;
}

function requireResolvedModel(ctx: ProviderResolveDynamicModelContext) {
  const result = resolveCopilotForwardCompatModel(ctx);
  if (!result) {
    throw new Error(`expected model ${ctx.modelId} to resolve`);
  }
  return result;
}

describe("github-copilot model defaults", () => {
  describe("getDefaultCopilotModelIds", () => {
    it("includes claude-opus-4.7", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-opus-4.7");
      expect(getDefaultCopilotModelIds()).toContain("claude-opus-4.6");
    });

    it("includes claude-sonnet-4.6", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.6");
    });

    it("includes claude-sonnet-4.5", () => {
      expect(getDefaultCopilotModelIds()).toContain("claude-sonnet-4.5");
    });

    it("returns a mutable copy", () => {
      const a = getDefaultCopilotModelIds();
      const b = getDefaultCopilotModelIds();
      expect(a).not.toBe(b);
      expect(a).toEqual(b);
    });
  });

  describe("buildCopilotModelDefinition", () => {
    it("builds a valid definition for claude-sonnet-4.6", () => {
      const def = buildCopilotModelDefinition("claude-sonnet-4.6");
      expect(def.id).toBe("claude-sonnet-4.6");
      expect(def.api).toBe("anthropic-messages");
    });

    it("uses static metadata overrides for gpt-5.5 fallback rows", () => {
      const def = buildCopilotModelDefinition("gpt-5.5");
      expect(def).toEqual({
        id: "gpt-5.5",
        name: "GPT-5.5",
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400_000,
        maxTokens: 128_000,
      });
    });

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-4o  ");
      expect(def.id).toBe("gpt-4o");
      expect(def.api).toBe("openai-responses");
    });

    it("routes Gemini models through Chat Completions with Copilot compat flags", () => {
      const def = buildCopilotModelDefinition("gemini-3.1-pro-preview");
      expect(def.api).toBe("openai-completions");
      expect(def.compat).toEqual({
        supportsStore: false,
        supportsDeveloperRole: false,
        supportsUsageInStreaming: false,
        maxTokensField: "max_tokens",
      });
    });

    it("throws on empty model id", () => {
      expect(() => buildCopilotModelDefinition("")).toThrow("Model id required");
      expect(() => buildCopilotModelDefinition("  ")).toThrow("Model id required");
    });
  });
});

describe("resolveCopilotForwardCompatModel", () => {
  it("returns undefined for empty modelId", () => {
    expect(resolveCopilotForwardCompatModel(createMockCtx(""))).toBeUndefined();
    expect(resolveCopilotForwardCompatModel(createMockCtx("  "))).toBeUndefined();
  });

  it("returns undefined when model is already in registry", () => {
    const ctx = createMockCtx("gpt-4o", {
      "github-copilot/gpt-4o": { id: "gpt-4o", name: "gpt-4o" },
    });
    expect(resolveCopilotForwardCompatModel(ctx)).toBeUndefined();
  });

  it("clones gpt-5.2-codex template for gpt-5.4", () => {
    const template = {
      id: "gpt-5.2-codex",
      name: "gpt-5.2-codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 200_000,
    };
    const ctx = createMockCtx("gpt-5.4", {
      "github-copilot/gpt-5.2-codex": template,
    });
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4");
    expect(result.name).toBe("gpt-5.4");
    expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
  });

  it("clones gpt-5.3-codex template for gpt-5.3-codex when not in registry", () => {
    const template = {
      id: "gpt-5.2-codex",
      name: "gpt-5.2-codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 200_000,
    };
    const ctx = createMockCtx("gpt-5.3-codex", {
      "github-copilot/gpt-5.2-codex": template,
    });
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.3-codex");
    expect(result.name).toBe("gpt-5.3-codex");
    expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
  });

  it("prefers gpt-5.3-codex as template source over gpt-5.2-codex for gpt-5.4", () => {
    const template53 = {
      id: "gpt-5.3-codex",
      name: "gpt-5.3-codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 300_000,
    };
    const template52 = {
      id: "gpt-5.2-codex",
      name: "gpt-5.2-codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      contextWindow: 200_000,
    };
    const ctx = createMockCtx("gpt-5.4", {
      "github-copilot/gpt-5.3-codex": template53,
      "github-copilot/gpt-5.2-codex": template52,
    });
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4");
    expect((result as unknown as Record<string, unknown>).contextWindow).toBe(300_000);
  });

  it("falls through to synthetic catch-all when codex template is missing", () => {
    const ctx = createMockCtx("gpt-5.4");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4");
  });

  it("uses static metadata for gpt-5.5 when live discovery rows are unavailable", () => {
    const result = requireResolvedModel(createMockCtx("gpt-5.5"));
    expect(result).toEqual({
      id: "gpt-5.5",
      name: "GPT-5.5",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400_000,
      maxTokens: 128_000,
    });
  });

  it("creates synthetic model for arbitrary unknown model ID", () => {
    const ctx = createMockCtx("gpt-5.4-mini");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4-mini");
    expect(result.name).toBe("gpt-5.4-mini");
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-responses");
    expect((result as unknown as Record<string, unknown>).input).toEqual(["text", "image"]);
  });

  it("creates synthetic Gemini models with Chat Completions compatibility", () => {
    const result = requireResolvedModel(createMockCtx("gemini-3.1-pro-preview"));
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-completions");
    expect((result as unknown as Record<string, unknown>).compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    });
  });

  it("infers reasoning=true for o1/o3 model IDs", () => {
    for (const id of ["o1", "o3", "o3-mini", "o1-preview"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });

  it("infers reasoning=true for Codex model IDs", () => {
    for (const id of ["gpt-5.4-codex", "gpt-5.5-codex", "gpt-5.4-codex-mini", "gpt-5.3-codex"]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(true);
    }
  });

  it("sets reasoning=false for non-reasoning model IDs including mid-string o1/o3", () => {
    for (const id of [
      "gpt-5.4-mini",
      "claude-sonnet-4.6",
      "gpt-4o",
      "mycodexmodel",
      "audio-o1-hd",
      "turbo-o3-voice",
    ]) {
      const ctx = createMockCtx(id);
      const result = requireResolvedModel(ctx);
      expect((result as unknown as Record<string, unknown>).reasoning).toBe(false);
    }
  });
});

describe("fetchCopilotUsage", () => {
  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(500, "boom"));
    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.error).toBe("HTTP 500");
    expect(result.windows).toHaveLength(0);
  });

  it("parses premium/chat usage from remaining percentages", async () => {
    const mockFetch = createProviderUsageFetch(async (_url, init) => {
      const headers = (init?.headers as Record<string, string> | undefined) ?? {};
      expect(headers.Authorization).toBe("token token");
      expect(headers["X-Github-Api-Version"]).toBe("2025-04-01");

      return makeResponse(200, {
        quota_snapshots: {
          premium_interactions: { percent_remaining: 20 },
          chat: { percent_remaining: 75 },
        },
        copilot_plan: "pro",
      });
    });

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.plan).toBe("pro");
    expect(result.windows).toEqual([
      { label: "Premium", usedPercent: 80 },
      { label: "Chat", usedPercent: 25 },
    ]);
  });

  it("defaults missing snapshot values and clamps invalid remaining percentages", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        quota_snapshots: {
          premium_interactions: { percent_remaining: null },
          chat: { percent_remaining: 140 },
        },
      }),
    );

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.windows).toEqual([
      { label: "Premium", usedPercent: 100 },
      { label: "Chat", usedPercent: 0 },
    ]);
    expect(result.plan).toBeUndefined();
  });

  it("returns an empty window list when quota snapshots are missing", async () => {
    const mockFetch = createProviderUsageFetch(async () =>
      makeResponse(200, {
        copilot_plan: "free",
      }),
    );

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result).toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [],
      plan: "free",
    });
  });
});

describe("github-copilot token", () => {
  const cachePath = "/tmp/openclaw-state/credentials/github-copilot.token.json";

  beforeEach(() => {
    jsonStoreMocks.loadJsonFile.mockClear();
    jsonStoreMocks.saveJsonFile.mockClear();
  });

  it("derives baseUrl from token", () => {
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;")).toBe(
      "https://api.foo.bar",
    );
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    jsonStoreMocks.loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
      integrationId: "vscode-chat",
    });

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: jsonStoreMocks.loadJsonFile,
      saveJsonFileImpl: jsonStoreMocks.saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("cached;proxy-ep=proxy.example.com;");
    expect(res.baseUrl).toBe("https://api.example.com");
    expect(res.source).toContain("cache:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and stores token when cache is missing", async () => {
    jsonStoreMocks.loadJsonFile.mockReturnValue(undefined);

    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        token: "fresh;proxy-ep=https://proxy.contoso.test;",
        expires_at: Math.floor(Date.now() / 1000) + 3600,
      }),
    });

    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: jsonStoreMocks.loadJsonFile,
      saveJsonFileImpl: jsonStoreMocks.saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    const [, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(((calledInit as RequestInit).headers as Record<string, string>)["Accept-Encoding"]).toBe(
      "identity",
    );
    expect(jsonStoreMocks.saveJsonFile).toHaveBeenCalledTimes(1);
  });
});

describe("fetchCopilotModelCatalog", () => {
  // Trimmed sample of the real Copilot /models response shape captured against
  // api.githubcopilot.com against an Individual Copilot subscription. Includes
  // a chat model, a router (must be filtered), an embedding (must be filtered),
  // an internal 1M-context Claude variant (must be kept), and a vision-disabled
  // codex model.
  const sampleApiResponse = {
    data: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        object: "model",
        vendor: "OpenAI",
        capabilities: {
          type: "chat",
          family: "gpt-5.5",
          limits: {
            max_context_window_tokens: 400000,
            max_output_tokens: 128000,
            max_prompt_tokens: 272000,
          },
          supports: {
            vision: true,
            tool_calls: true,
            streaming: true,
            structured_outputs: true,
            reasoning_effort: ["low", "medium", "high"],
          },
        },
      },
      {
        id: "gpt-5.3-codex",
        name: "GPT-5.3-Codex",
        object: "model",
        vendor: "OpenAI",
        capabilities: {
          type: "chat",
          family: "gpt-5.3-codex",
          limits: {
            max_context_window_tokens: 400000,
            max_output_tokens: 128000,
          },
          supports: {
            vision: false,
            tool_calls: true,
            reasoning_effort: ["low", "medium", "high"],
          },
        },
      },
      {
        id: "gemini-3.1-pro-preview",
        name: "Gemini 3.1 Pro Preview",
        object: "model",
        vendor: "Google",
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 1_000_000,
            max_output_tokens: 65_536,
          },
          supports: {
            vision: true,
            tool_calls: true,
            streaming: true,
          },
        },
      },
      {
        id: "claude-opus-4.7-1m-internal",
        name: "Claude Opus 4.7 (1M context)(Internal only)",
        object: "model",
        vendor: "Anthropic",
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 1000000,
            max_output_tokens: 64000,
          },
          supports: { vision: true, tool_calls: true },
        },
      },
      {
        // Internal router — must be filtered out (id starts with "accounts/").
        id: "accounts/msft/routers/abc123",
        name: "Search Agent A",
        object: "model",
        capabilities: {
          type: "chat",
          limits: { max_context_window_tokens: 256000, max_output_tokens: 1024 },
        },
      },
      {
        // Embedding — must be filtered out by capabilities.type !== "chat".
        id: "text-embedding-3-small",
        name: "Embedding V3 small",
        object: "model",
        capabilities: { type: "embedding" },
      },
    ],
  };

  it("maps Copilot /models entries to ModelDefinitionConfig with real context windows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => sampleApiResponse,
    });

    const out = await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchImpl.mock.calls[0] ?? [];
    expect(calledUrl).toBe("https://api.githubcopilot.com/models");
    expect((calledInit as RequestInit).method).toBe("GET");
    expect(((calledInit as RequestInit).headers as Record<string, string>).Authorization).toBe(
      "Bearer tid=test",
    );
    expect(((calledInit as RequestInit).headers as Record<string, string>)["Accept-Encoding"]).toBe(
      "identity",
    );

    expect(out.map((m) => m.id)).toEqual([
      "gpt-5.5",
      "gpt-5.3-codex",
      "gemini-3.1-pro-preview",
      "claude-opus-4.7-1m-internal",
    ]);

    const gpt55 = out.find((m) => m.id === "gpt-5.5");
    expect(gpt55).toEqual({
      id: "gpt-5.5",
      name: "GPT-5.5",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 400000,
      maxTokens: 128000,
    });

    const codex = out.find((m) => m.id === "gpt-5.3-codex");
    expect(codex?.input).toEqual(["text"]);
    expect(codex?.reasoning).toBe(true);
    expect(codex?.contextWindow).toBe(400000);

    const gemini = out.find((m) => m.id === "gemini-3.1-pro-preview");
    expect(gemini?.api).toBe("openai-completions");
    expect(gemini?.compat).toEqual({
      supportsStore: false,
      supportsDeveloperRole: false,
      supportsUsageInStreaming: false,
      maxTokensField: "max_tokens",
    });

    const opus1m = out.find((m) => m.id === "claude-opus-4.7-1m-internal");
    expect(opus1m?.api).toBe("anthropic-messages");
    expect(opus1m?.contextWindow).toBe(1_000_000);
  });

  it("strips trailing slash from baseUrl when building the /models URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ data: [] }),
    });

    await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.githubcopilot.com/models");
  });

  it("dedupes by id when API returns duplicates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        data: [
          {
            id: "gpt-5.5",
            name: "GPT-5.5",
            object: "model",
            capabilities: {
              type: "chat",
              limits: { max_context_window_tokens: 400000, max_output_tokens: 128000 },
            },
          },
          {
            id: "gpt-5.5",
            name: "GPT-5.5 (dup)",
            object: "model",
            capabilities: {
              type: "chat",
              limits: { max_context_window_tokens: 100000, max_output_tokens: 1000 },
            },
          },
        ],
      }),
    });

    const out = await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toHaveLength(1);
    expect(out[0].name).toBe("GPT-5.5");
  });

  it("throws on non-2xx HTTP responses so the caller can fall back to the static catalog", async () => {
    const fetchImpl = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({}),
    });

    await expect(
      fetchCopilotModelCatalog({
        copilotApiToken: "tid=bad",
        baseUrl: "https://api.githubcopilot.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });

  it("throws provider-owned errors for malformed successful /models payloads", async () => {
    for (const payload of [[], { data: {} }, { data: [null] }]) {
      const fetchImpl = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => payload,
      });

      await expect(
        fetchCopilotModelCatalog({
          copilotApiToken: "tid=test",
          baseUrl: "https://api.githubcopilot.com",
          fetchImpl: fetchImpl as unknown as typeof fetch,
        }),
      ).rejects.toThrow("Copilot /models: malformed JSON response");
    }
  });

  it("rejects empty token / baseUrl synchronously before fetching", async () => {
    const fetchImpl = vi.fn();

    await expect(
      fetchCopilotModelCatalog({
        copilotApiToken: "",
        baseUrl: "https://api.githubcopilot.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/copilotApiToken required/);

    await expect(
      fetchCopilotModelCatalog({
        copilotApiToken: "tid=test",
        baseUrl: "",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/baseUrl required/);

    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
