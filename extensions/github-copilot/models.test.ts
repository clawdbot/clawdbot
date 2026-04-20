import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createProviderUsageFetch,
  makeResponse,
} from "../../test/helpers/plugins/provider-usage-fetch.js";
import { buildCopilotModelDefinition, getDefaultCopilotModelIds } from "./models-defaults.js";
import { fetchCopilotUsage } from "./usage.js";

vi.mock("@mariozechner/pi-ai/oauth", async () => {
  const actual = await vi.importActual<typeof import("@mariozechner/pi-ai/oauth")>(
    "@mariozechner/pi-ai/oauth",
  );
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    getOAuthProviders: vi.fn(() => []),
  };
});

vi.mock("openclaw/plugin-sdk/provider-model-shared", () => ({
  normalizeModelCompat: (model: Record<string, unknown>) => model,
}));

const loadJsonFile = vi.fn();
const saveJsonFile = vi.fn();

vi.mock("openclaw/plugin-sdk/json-store", () => ({
  loadJsonFile,
  saveJsonFile,
}));

vi.mock("openclaw/plugin-sdk/state-paths", () => ({
  resolveStateDir: () => "/tmp/openclaw-state",
}));

import type { ProviderResolveDynamicModelContext } from "openclaw/plugin-sdk/core";
import { resolveCopilotForwardCompatModel } from "./models.js";

let deriveCopilotApiBaseUrlFromToken: typeof import("./token.js").deriveCopilotApiBaseUrlFromToken;
let resolveCopilotApiToken: typeof import("./token.js").resolveCopilotApiToken;

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
    it("includes claude-opus-4.6", () => {
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

    it("trims whitespace from model id", () => {
      const def = buildCopilotModelDefinition("  gpt-4o  ");
      expect(def.id).toBe("gpt-4o");
      expect(def.api).toBe("openai-responses");
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

  it("falls through to synthetic catch-all when codex template is missing", () => {
    const ctx = createMockCtx("gpt-5.4");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4");
  });

  it("creates synthetic model for arbitrary unknown model ID", () => {
    const ctx = createMockCtx("gpt-5.4-mini");
    const result = requireResolvedModel(ctx);
    expect(result.id).toBe("gpt-5.4-mini");
    expect(result.name).toBe("gpt-5.4-mini");
    expect((result as unknown as Record<string, unknown>).api).toBe("openai-responses");
    expect((result as unknown as Record<string, unknown>).input).toEqual(["text", "image"]);
  });

  it("infers reasoning=true for o1/o3 model IDs", () => {
    for (const id of ["o1", "o3", "o3-mini", "o1-preview"]) {
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

  beforeEach(async () => {
    vi.resetModules();
    loadJsonFile.mockClear();
    saveJsonFile.mockClear();
    ({ deriveCopilotApiBaseUrlFromToken, resolveCopilotApiToken } = await import("./token.js"));
  });

  it("derives baseUrl from token", async () => {
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=proxy.example.com;")).toBe(
      "https://api.example.com",
    );
    expect(deriveCopilotApiBaseUrlFromToken("token;proxy-ep=https://proxy.foo.bar;")).toBe(
      "https://api.foo.bar",
    );
  });

  it("uses cache when token is still valid", async () => {
    const now = Date.now();
    loadJsonFile.mockReturnValue({
      token: "cached;proxy-ep=proxy.example.com;",
      expiresAt: now + 60 * 60 * 1000,
      updatedAt: now,
    });

    const fetchImpl = vi.fn();
    const res = await resolveCopilotApiToken({
      githubToken: "gh",
      cachePath,
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("cached;proxy-ep=proxy.example.com;");
    expect(res.baseUrl).toBe("https://api.example.com");
    expect(String(res.source)).toContain("cache:");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("fetches and stores token when cache is missing", async () => {
    loadJsonFile.mockReturnValue(undefined);

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
      loadJsonFileImpl: loadJsonFile,
      saveJsonFileImpl: saveJsonFile,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(res.token).toBe("fresh;proxy-ep=https://proxy.contoso.test;");
    expect(res.baseUrl).toBe("https://api.contoso.test");
    expect(saveJsonFile).toHaveBeenCalledTimes(1);
  });
});
