// Github Copilot tests cover models plugin behavior.
import { expectDefined } from "@openclaw/normalization-core";
import { createProviderUsageFetch, makeResponse } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it, vi } from "vitest";
import { CopilotRuntimeAuthError } from "./runtime-auth-error.js";
import { resolveCopilotRuntimeAuth } from "./runtime-auth.js";
import { fetchCopilotUsage } from "./usage.js";

vi.mock("openclaw/plugin-sdk/provider-model-shared", async (importOriginal) => ({
  ...(await importOriginal<typeof import("openclaw/plugin-sdk/provider-model-shared")>()),
  normalizeModelCompat: (model: Record<string, unknown>) => model,
  resolveProviderEndpoint: (baseUrl: string) => ({
    baseUrl,
    endpointClass: "custom",
    warnings: [],
  }),
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-state",
}));

import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import {
  fetchCopilotModelCatalog,
  resolveCopilotForwardCompatModel,
  selectCopilotStarterModel,
} from "./models.js";

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

  it("uses static metadata for gpt-5.3-codex when not in registry", () => {
    const result = requireResolvedModel(createMockCtx("gpt-5.3-codex"));
    expect(result).toEqual({
      id: "gpt-5.3-codex",
      name: "GPT-5.3-Codex",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 0 },
      contextWindow: 400_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("uses curated static metadata for gpt-5.4 when not in registry", () => {
    const result = requireResolvedModel(createMockCtx("gpt-5.4"));
    expect(result).toEqual({
      id: "gpt-5.4",
      name: "GPT-5.4",
      provider: "github-copilot",
      api: "openai-responses",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 0 },
      contextWindow: 1_050_000,
      maxTokens: 128_000,
    });
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
      cost: { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 0 },
      contextWindow: 1_050_000,
      contextTokens: 272_000,
      maxTokens: 128_000,
    });
  });

  it("preserves static Anthropic thinking maps for legacy Claude Opus configured ids", () => {
    const opus46 = requireResolvedModel(createMockCtx("claude-opus-4.6-1m"));
    expect(opus46.thinkingLevelMap).toEqual({ xhigh: null, max: null });

    const result = requireResolvedModel(createMockCtx("claude-opus-4.7-1m-internal"));
    expect(result.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null });
    expect(result.compat).toEqual({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
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

  it("disables eager tool streaming for synthetic Copilot Claude 4.5 models", () => {
    const result = requireResolvedModel(createMockCtx("claude-haiku-4.5"));
    expect(result.api).toBe("anthropic-messages");
    expect(result.compat).toEqual({ supportsEagerToolInputStreaming: false });
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
  it("targets the public github.com usage endpoint by default", async () => {
    let calledUrl: string | undefined;
    const mockFetch = createProviderUsageFetch(async (url) => {
      calledUrl = url;
      return makeResponse(200, { copilot_plan: "pro" });
    });

    await fetchCopilotUsage("token", 5000, mockFetch);

    expect(calledUrl).toBe("https://api.github.com/copilot_internal/user");
  });

  it("routes usage through the tenant host for *.ghe.com domains", async () => {
    let calledUrl: string | undefined;
    const mockFetch = createProviderUsageFetch(async (url) => {
      calledUrl = url;
      return makeResponse(200, { copilot_plan: "business" });
    });

    await fetchCopilotUsage("token", 5000, mockFetch, "acme.ghe.com");

    expect(calledUrl).toBe("https://api.acme.ghe.com/copilot_internal/user");
  });

  it("returns HTTP errors for failed requests", async () => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(500, "boom"));
    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.error).toBe("HTTP 500");
    expect(result.windows).toHaveLength(0);
  });

  it("cancels failed response bodies", async () => {
    let canceled = false;
    const body = new ReadableStream({
      cancel() {
        canceled = true;
        throw new Error("stream already closed");
      },
    });
    const mockFetch = createProviderUsageFetch(async () => new Response(body, { status: 500 }));

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result.error).toBe("HTTP 500");
    expect(canceled).toBe(true);
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

  it.each([
    ["null", null],
    ["an array", []],
  ])("returns an empty window list for a non-object %s payload", async (_label, payload) => {
    const mockFetch = createProviderUsageFetch(async () => makeResponse(200, payload));

    const result = await fetchCopilotUsage("token", 5000, mockFetch);

    expect(result).toEqual({
      provider: "github-copilot",
      displayName: "Copilot",
      windows: [],
      plan: undefined,
    });
  });

  it("bounds the usage read and cancels the stream when the body exceeds the JSON byte cap", async () => {
    // Larger than the shared 16 MiB readProviderJsonResponse cap so the bounded reader cancels the
    // stream mid-flight; if the cap were removed the unbounded res.json() would buffer the whole body.
    const ONE_MIB = 1024 * 1024;
    const TOTAL_CHUNKS = 32; // 32 MiB advertised body, double the cap.
    const chunk = new Uint8Array(ONE_MIB);

    let bytesPulled = 0;
    let canceled = false;
    const makeOversizedJsonResponse = (): Response => {
      let pulled = 0;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulled >= TOTAL_CHUNKS) {
            controller.close();
            return;
          }
          pulled += 1;
          bytesPulled += chunk.length;
          controller.enqueue(chunk);
        },
        cancel() {
          canceled = true;
        },
      });
      return new Response(body, {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    };

    const mockFetch = createProviderUsageFetch(async () => makeOversizedJsonResponse());

    await expect(fetchCopilotUsage("token", 5000, mockFetch)).rejects.toThrow(
      /github-copilot-usage: JSON response exceeds/,
    );
    // The bounded reader cancels the body and never pulls the full advertised 32 MiB stream.
    expect(canceled).toBe(true);
    expect(bytesPulled).toBeLessThan(TOTAL_CHUNKS * ONE_MIB);
  });
});

describe("github-copilot runtime auth", () => {
  it("validates and preserves the source token while resolving the account API endpoint", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(
        new Response(
          JSON.stringify({ endpoints: { api: "https://api.individual.githubcopilot.com/" } }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    const auth = await resolveCopilotRuntimeAuth({
      githubToken: "github-source-token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(auth).toEqual({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
      source: "validated:https://api.github.com/copilot_internal/user",
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({
        method: "GET",
        headers: {
          Accept: "application/json",
          Authorization: "Bearer github-source-token",
        },
      }),
    );
  });

  it("accepts an account endpoint under the configured data-residency tenant", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ endpoints: { api: "https://copilot-api.acme.ghe.com" } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    const auth = await resolveCopilotRuntimeAuth({
      githubToken: "tenant-source-token",
      githubDomain: "acme.ghe.com",
      fetchImpl: fetchImpl as typeof fetch,
    });

    expect(auth.baseUrl).toBe("https://copilot-api.acme.ghe.com");
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.acme.ghe.com/copilot_internal/user");
  });

  it("uses a domain-safe fallback when account metadata omits the API endpoint", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ copilot_plan: "individual" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      resolveCopilotRuntimeAuth({
        githubToken: "github-source-token",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).resolves.toMatchObject({
      apiKey: "github-source-token",
      baseUrl: "https://api.individual.githubcopilot.com",
    });
  });

  it.each([
    "http://api.individual.githubcopilot.com",
    "https://api.individual.githubcopilot.com.attacker.test",
    "https://user@api.individual.githubcopilot.com",
  ])("rejects an untrusted account endpoint: %s", async (api) => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ endpoints: { api } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );

    await expect(
      resolveCopilotRuntimeAuth({
        githubToken: "github-source-token",
        fetchImpl: fetchImpl as typeof fetch,
      }),
    ).rejects.toThrow("untrusted endpoints.api URL");
  });

  it("explains how to recover from forbidden authentication", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 403 }));
    const rejection = resolveCopilotRuntimeAuth({
      githubToken: "github-source-token",
      fetchImpl: fetchImpl as typeof fetch,
    });

    await expect(rejection).rejects.toBeInstanceOf(CopilotRuntimeAuthError);
    await expect(rejection).rejects.toMatchObject({
      code: "github_copilot_auth_failed",
      reason: "http_error",
      status: 403,
      message: expect.stringContaining("login-github-copilot"),
    });
  });

  it("maps a stalled response body to a runtime-auth timeout", async () => {
    const controller = new AbortController();
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation(() => controller.signal);
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const signal = init?.signal;
      return new Response(
        new ReadableStream<Uint8Array>({
          start(streamController) {
            signal?.addEventListener("abort", () => streamController.error(signal.reason), {
              once: true,
            });
            queueMicrotask(() => controller.abort(new DOMException("timed out", "TimeoutError")));
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    try {
      await expect(
        resolveCopilotRuntimeAuth({
          githubToken: "github-source-token",
          fetchImpl: fetchImpl as typeof fetch,
        }),
      ).rejects.toMatchObject({
        name: "CopilotRuntimeAuthError",
        reason: "timeout",
        timeoutMs: 30_000,
      });
    } finally {
      timeoutSpy.mockRestore();
    }
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
          supports: {
            vision: true,
            tool_calls: true,
            reasoning_effort: ["low", "medium", "high", "xhigh"],
          },
        },
      },
      {
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
        object: "model",
        vendor: "Anthropic",
        capabilities: {
          type: "chat",
          limits: {
            max_context_window_tokens: 200000,
            max_output_tokens: 64000,
          },
          supports: {
            vision: true,
            tool_calls: true,
            reasoning_effort: ["low", "medium", "high", "max"],
          },
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

  function selectableModelEntry(params: {
    id: string;
    category?: string;
    contextWindow?: number;
    maxTokens?: number;
    pickerEnabled?: boolean;
    policyState?: string;
    preview?: boolean;
    streaming?: boolean | "omit";
    toolCalls?: boolean;
  }) {
    return {
      id: params.id,
      name: params.id,
      object: "model",
      model_picker_enabled: params.pickerEnabled ?? true,
      model_picker_category: params.category ?? "versatile",
      policy: { state: params.policyState ?? "enabled" },
      preview: params.preview ?? false,
      capabilities: {
        type: "chat",
        limits: {
          max_context_window_tokens: params.contextWindow ?? 200_000,
          max_output_tokens: params.maxTokens ?? 64_000,
        },
        supports: {
          ...(params.streaming === "omit" ? {} : { streaming: params.streaming ?? true }),
          tool_calls: params.toolCalls ?? true,
        },
      },
    };
  }

  async function fetchSelectionFixture(data: unknown[]) {
    return await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      fetchImpl: vi.fn().mockResolvedValue(makeResponse(200, { data })) as unknown as typeof fetch,
    });
  }

  it("selects the preferred model only when the authenticated catalog marks it eligible", async () => {
    const models = await fetchSelectionFixture([
      selectableModelEntry({ id: "fallback", contextWindow: 1_000_000 }),
      selectableModelEntry({ id: "preferred", category: "powerful" }),
    ]);

    expect(selectCopilotStarterModel(models, "preferred")?.id).toBe("preferred");
  });

  it("uses a deterministic eligible fallback when the preferred model is policy-disabled", async () => {
    const entries = [
      selectableModelEntry({ id: "preferred", policyState: "disabled" }),
      selectableModelEntry({ id: "preview", preview: true, contextWindow: 1_000_000 }),
      selectableModelEntry({ id: "powerful", category: "powerful", contextWindow: 1_000_000 }),
      selectableModelEntry({ id: "versatile-b", contextWindow: 400_000 }),
      selectableModelEntry({ id: "versatile-a", contextWindow: 400_000 }),
    ];
    const forward = await fetchSelectionFixture(entries);
    const reversed = await fetchSelectionFixture(entries.toReversed());

    expect(selectCopilotStarterModel(forward, "preferred")?.id).toBe("versatile-a");
    expect(selectCopilotStarterModel(reversed, "preferred")?.id).toBe("versatile-a");
  });

  it("rejects hidden, unconfigured, non-streaming, and tool-less setup candidates", async () => {
    const models = await fetchSelectionFixture([
      selectableModelEntry({ id: "hidden", pickerEnabled: false }),
      selectableModelEntry({ id: "unconfigured", policyState: "unconfigured" }),
      selectableModelEntry({ id: "no-stream", streaming: false }),
      selectableModelEntry({ id: "no-tools", toolCalls: false }),
    ]);

    expect(selectCopilotStarterModel(models, "hidden")).toBeUndefined();
  });

  it("does not treat omitted streaming metadata as an explicit lack of support", async () => {
    const models = await fetchSelectionFixture([
      selectableModelEntry({ id: "omitted-streaming", streaming: "omit" }),
    ]);

    expect(selectCopilotStarterModel(models, "omitted-streaming")?.id).toBe("omitted-streaming");
  });

  it("maps Copilot /models entries to ModelDefinitionConfig with real context windows", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, sampleApiResponse));

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
      "claude-opus-4-5",
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
      contextTokens: 272000,
      maxTokens: 128000,
      compat: { supportedReasoningEfforts: ["low", "medium", "high"] },
    });

    const codex = out.find((m) => m.id === "gpt-5.3-codex");
    expect(codex?.input).toEqual(["text"]);
    expect(codex?.reasoning).toBe(true);
    expect(codex?.contextWindow).toBe(400000);
    expect(codex?.contextTokens).toBeUndefined();

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
    expect(opus1m?.thinkingLevelMap).toEqual({ xhigh: "xhigh", max: null });
    expect(opus1m?.compat).toEqual({
      supportedReasoningEfforts: ["low", "medium", "high", "xhigh"],
    });

    const opus45 = out.find((m) => m.id === "claude-opus-4-5");
    expect(opus45?.thinkingLevelMap).toEqual({ xhigh: null, max: null });
    expect(opus45?.compat).toEqual({
      supportsEagerToolInputStreaming: false,
      supportedReasoningEfforts: ["low", "medium", "high", "max"],
    });
  });

  it("strips trailing slash from baseUrl when building the /models URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, { data: [] }));

    await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(fetchImpl.mock.calls[0]?.[0]).toBe("https://api.githubcopilot.com/models");
  });

  it("dedupes by id when API returns duplicates", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
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
    );

    const out = await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toHaveLength(1);
    expect(expectDefined(out[0], "GitHub Copilot model").name).toBe("GPT-5.5");
  });

  it("falls back from malformed live token limits", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      makeResponse(200, {
        data: [
          {
            id: "gpt-bad-window",
            name: "GPT Bad Window",
            object: "model",
            capabilities: {
              type: "chat",
              limits: {
                max_context_window_tokens: -1,
                max_prompt_tokens: -1,
                max_output_tokens: 128000.5,
              },
            },
          },
          {
            id: "gpt-bad-output",
            name: "GPT Bad Output",
            object: "model",
            capabilities: {
              type: "chat",
              limits: {
                max_context_window_tokens: Number.POSITIVE_INFINITY,
                max_prompt_tokens: Number.POSITIVE_INFINITY,
                max_output_tokens: 0,
              },
            },
          },
        ],
      }),
    );

    const out = await fetchCopilotModelCatalog({
      copilotApiToken: "tid=test",
      baseUrl: "https://api.githubcopilot.com",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      id: "gpt-bad-window",
      contextWindow: 128000,
      maxTokens: 8192,
    });
    expect(out[0]).not.toHaveProperty("contextTokens");
    expect(out[1]).toMatchObject({
      id: "gpt-bad-output",
      contextWindow: 128000,
      maxTokens: 8192,
    });
    expect(out[1]).not.toHaveProperty("contextTokens");
  });

  it("cancels stalled non-2xx response bodies before the caller falls back", async () => {
    let canceled = false;
    const response = new Response(
      new ReadableStream<Uint8Array>({
        cancel() {
          canceled = true;
        },
      }),
      { status: 401 },
    );
    const fetchImpl = vi.fn().mockResolvedValue(response);

    await expect(
      fetchCopilotModelCatalog({
        copilotApiToken: "tid=bad",
        baseUrl: "https://api.githubcopilot.com",
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 401/);

    expect(canceled).toBe(true);
  });

  it("throws provider-owned errors for malformed successful /models payloads", async () => {
    for (const payload of [[], { data: {} }, { data: [null] }]) {
      const fetchImpl = vi.fn().mockResolvedValue(makeResponse(200, payload));

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
