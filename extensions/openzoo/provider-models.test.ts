// Openzoo tests cover provider models plugin behavior.
import { createRequireRecord } from "openclaw/plugin-sdk/test-fixtures";
import { afterAll, describe, expect, it, vi } from "vitest";

const { fetchWithSsrFGuardMock } = vi.hoisted(() => ({
  fetchWithSsrFGuardMock: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", () => ({
  fetchWithSsrFGuard: fetchWithSsrFGuardMock,
  ssrfPolicyFromHttpBaseUrlAllowedHostname: (baseUrl: string) => ({
    allowedHostnames: [new URL(baseUrl).hostname],
  }),
}));

import {
  discoverOpenzooModels,
  normalizeOpenzooBaseUrl,
  OPENZOO_DEFAULT_BASE_URL,
  OPENZOO_DEFAULT_COST,
  parseOpenzooReasoning,
  projectOpenzooModels,
  resolveOpenzooBaseUrl,
  resolveOpenzooInfoUrl,
  resolveOpenzooModelsUrl,
} from "./provider-models.js";

type MockOpenzooFetch = ((url: string, init?: RequestInit) => Promise<Response>) & {
  mock: { calls: unknown[][] };
};

const OPENZOO_MODELS_URL = `${OPENZOO_DEFAULT_BASE_URL}/models`;

const EXPECTED_STATIC_OPENZOO_MODELS = [
  {
    id: "auto",
    name: "auto",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000000,
    maxTokens: 8192,
  },
];

function requireModelById(
  models: Awaited<ReturnType<typeof discoverOpenzooModels>>,
  id: string,
): Awaited<ReturnType<typeof discoverOpenzooModels>>[number] {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`expected openzoo model ${id}`);
  }
  return model;
}

const requireRecord = createRequireRecord("record", "expected-label-record");

function requireFirstMockCall(mock: { mock: { calls: unknown[][] } }, label: string): unknown[] {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

/** Mirrors a live proxy row: no name, no architecture, numeric per-token prices. */
function makeProxyModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-opus-4.1",
    object: "model",
    owned_by: "openrouter",
    pricing: {
      prompt: 0.000015,
      completion: 0.000075,
      unit: "USD",
      markup: 1,
    },
    context_length: 128000000,
    top_provider: {
      context_length: 128000000,
      max_completion_tokens: 32000,
      is_moderated: false,
    },
    architecture: null,
    supported_parameters: null,
    ...overrides,
  };
}

function makeAutoModel(overrides: Record<string, unknown> = {}) {
  return makeProxyModel({
    id: "auto",
    owned_by: "openzoo",
    pricing: {
      prompt: 1e-7,
      completion: 2e-7,
      unit: "USD",
      markup: 1,
    },
    top_provider: {
      context_length: 128000000,
      max_completion_tokens: null,
      is_moderated: false,
    },
    ...overrides,
  });
}

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function withFetchPathTest(mockFetch: MockOpenzooFetch, runAssertions: () => Promise<void>) {
  const release = vi.fn(async () => {});

  fetchWithSsrFGuardMock.mockReset();
  const callMockFetch = mockFetch as unknown as (
    url: string,
    init?: RequestInit,
  ) => Promise<unknown>;
  fetchWithSsrFGuardMock.mockImplementation(
    async (params: { url: string; init?: RequestInit }) => ({
      response: await callMockFetch(params.url, params.init),
      release,
    }),
  );

  try {
    await runAssertions();
    return release;
  } finally {
    fetchWithSsrFGuardMock.mockReset();
  }
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("discoverOpenzooModels (fetch path)", () => {
  it("parses proxy rows with per-token pricing converted to USD per million", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        object: "list",
        data: [makeAutoModel(), makeProxyModel()],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledOnce();
      const [guardedFetchParams] = requireFirstMockCall(
        fetchWithSsrFGuardMock,
        "guarded fetch call",
      );
      const guardedFetch = requireRecord(guardedFetchParams, "guarded fetch params");
      expect(guardedFetch.url).toBe(OPENZOO_MODELS_URL);
      const guardedInit = requireRecord(guardedFetch.init, "guarded fetch init");
      expect(Object.fromEntries(new Headers(guardedInit.headers as HeadersInit))).toEqual({
        accept: "application/json",
      });
      expect(guardedFetch.policy).toEqual({ allowedHostnames: ["localhost"] });
      expect(guardedFetch.timeoutMs).toBeGreaterThan(0);
      expect(guardedFetch.timeoutMs).toBeLessThanOrEqual(5000);
      expect(guardedFetch.auditContext).toBe("openzoo.model_discovery");

      expect(models.length).toBe(2);

      const opus = requireModelById(models, "anthropic/claude-opus-4.1");
      expect(opus.name).toBe("anthropic/claude-opus-4.1");
      expect(opus.cost.input).toBeCloseTo(15);
      expect(opus.cost.output).toBeCloseTo(75);
      expect(opus.cost.cacheRead).toBe(0);
      expect(opus.cost.cacheWrite).toBe(0);
      expect(opus.input).toEqual(["text"]);
      expect(opus.reasoning).toBe(false);
      expect(opus.contextWindow).toBe(128000000);
      expect(opus.maxTokens).toBe(32000);

      const auto = requireModelById(models, "auto");
      expect(auto.cost.input).toBeCloseTo(0.1);
      expect(auto.cost.output).toBeCloseTo(0.2);
      expect(auto.maxTokens).toBe(8192);
      expect(auto.contextWindow).toBe(128000000);
    });
  });

  it("accepts string prices, cache prices, names, and image modality", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeProxyModel({
            id: "anthropic/claude-sonnet-5",
            name: "Anthropic: Claude Sonnet 5",
            pricing: {
              prompt: "0.000003",
              completion: "0.000015",
              input_cache_read: "0.0000003",
              input_cache_write: "0.00000375",
            },
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
          }),
        ],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      const sonnet = requireModelById(models, "anthropic/claude-sonnet-5");
      expect(sonnet.name).toBe("Anthropic: Claude Sonnet 5");
      expect(sonnet.cost.input).toBeCloseTo(3);
      expect(sonnet.cost.output).toBeCloseTo(15);
      expect(sonnet.cost.cacheRead).toBeCloseTo(0.3);
      expect(sonnet.cost.cacheWrite).toBeCloseTo(3.75);
      expect(sonnet.input).toEqual(["text", "image"]);
    });
  });

  it("skips media rows and rows without a price", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeProxyModel({ id: "google/veo-3.1", kind: "video" }),
          makeProxyModel({ id: "black-forest-labs/flux-2", kind: "image" }),
          makeProxyModel({ id: "claude-sonnet-5", pricing: { prompt: 0, completion: 0 } }),
          makeProxyModel({ id: "some/unpriced", pricing: { unit: "USD" } }),
          makeProxyModel({ id: "some/negative", pricing: { prompt: "-1", completion: "-1" } }),
          makeProxyModel(),
        ],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models.map((model) => model.id)).toEqual(["auto", "anthropic/claude-opus-4.1"]);
    });
  });

  it("keeps a row that is priced on only one side", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeProxyModel({ id: "some/free-prompt", pricing: { prompt: 0, completion: 2e-6 } }),
        ],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(requireModelById(models, "some/free-prompt").cost).toEqual({
        input: 0,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
      });
    });
  });

  it("preserves default auto pricing when the live auto row is unpriced", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [makeAutoModel({ pricing: { prompt: "unavailable", completion: "-1" } })],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models).toHaveLength(1);
      expect(requireModelById(models, "auto").cost).toEqual(OPENZOO_DEFAULT_COST);
    });
  });

  it("falls back to static catalog on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("connection refused"));
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models).toStrictEqual(EXPECTED_STATIC_OPENZOO_MODELS);
    });
  });

  it("falls back to static catalog on HTTP error", async () => {
    const response = new Response("payment required", { status: 402 });
    const cancelSpy = vi.spyOn(response.body!, "cancel").mockResolvedValue(undefined);
    const mockFetch = vi.fn().mockResolvedValue(response);

    const release = await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models).toStrictEqual(EXPECTED_STATIC_OPENZOO_MODELS);
    });

    expect(cancelSpy).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("falls back to static catalog for malformed successful model list payloads", async () => {
    for (const payload of [[], { data: {} }, { data: [null] }]) {
      const mockFetch = vi.fn().mockResolvedValue(jsonResponse(payload));
      await withFetchPathTest(mockFetch, async () => {
        const models = await discoverOpenzooModels();
        expect(models).toStrictEqual(EXPECTED_STATIC_OPENZOO_MODELS);
      });
    }
  });

  it("falls back from malformed live token metadata", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          makeProxyModel({
            id: "some/bad-window",
            context_length: -1,
            top_provider: { context_length: null, max_completion_tokens: 8192.5 },
          }),
          makeProxyModel({
            id: "some/bad-output",
            context_length: Number.POSITIVE_INFINITY,
            top_provider: { context_length: 0, max_completion_tokens: 0 },
          }),
        ],
      }),
    );

    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();

      for (const id of ["some/bad-window", "some/bad-output"]) {
        expect(requireModelById(models, id)).toMatchObject({
          contextWindow: 128000000,
          maxTokens: 8192,
        });
      }
    });
  });

  it("ensures auto is present even when the proxy omits it", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ data: [makeProxyModel()] }));
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models.map((model) => model.id)).toEqual(["auto", "anthropic/claude-opus-4.1"]);
      expect(requireModelById(models, "auto")).toStrictEqual(EXPECTED_STATIC_OPENZOO_MODELS[0]);
    });
  });

  it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [makeAutoModel({ pricing: undefined }), makeAutoModel(), makeProxyModel()],
      }),
    );
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverOpenzooModels();
      expect(models.map((model) => model.id)).toEqual(["auto", "anthropic/claude-opus-4.1"]);
      expect(requireModelById(models, "auto").cost.input).toBeCloseTo(0.1);
    });
  });

  it("discovers from an operator-supplied base URL", async () => {
    const mockFetch = vi.fn().mockResolvedValue(jsonResponse({ data: [makeAutoModel()] }));
    await withFetchPathTest(mockFetch, async () => {
      await discoverOpenzooModels({ baseUrl: "http://127.0.0.1:9402/v1" });

      const [guardedFetchParams] = requireFirstMockCall(
        fetchWithSsrFGuardMock,
        "guarded fetch call",
      );
      const guardedFetch = requireRecord(guardedFetchParams, "guarded fetch params");
      expect(guardedFetch.url).toBe("http://127.0.0.1:9402/v1/models");
      expect(guardedFetch.policy).toEqual({ allowedHostnames: ["127.0.0.1"] });
    });
  });
});

describe("parseOpenzooReasoning", () => {
  it.each([
    ["openai/o3-pro", true],
    ["openai/o1", true],
    ["openai/o4-mini-high", true],
    ["deepseek/deepseek-r1-0528", true],
    ["deepseek/deepseek-reasoner", true],
    ["qwen/qwq-32b", true],
    ["qwen/qwen3-max-thinking", true],
    ["anthropic/claude-3.7-sonnet:thinking", true],
    ["sao10k/l3.3-euryale-70b", false],
    ["upstage/solar-pro4", false],
    ["openai/gpt-4o", false],
    ["x-ai/grok-4.6", false],
    ["anthropic/claude-sonnet-5", false],
    ["auto", false],
  ])("flags %s as reasoning=%s only on unambiguous id tokens", (id, expected) => {
    expect(parseOpenzooReasoning(id)).toBe(expected);
    const models = projectOpenzooModels([makeProxyModel({ id })]);
    expect(requireModelById(models, id).reasoning).toBe(expected);
  });
});

describe("openzoo base URL resolution", () => {
  it("defaults to the local proxy", () => {
    expect(resolveOpenzooBaseUrl({ env: {} })).toBe("http://localhost:8402/v1");
    expect(OPENZOO_DEFAULT_BASE_URL).toBe("http://localhost:8402/v1");
  });

  it("prefers configured base URL over environment overrides", () => {
    expect(
      resolveOpenzooBaseUrl({
        env: { OPENZOO_BASE_URL: "http://proxy-host:8402/v1", OPENZOO_PORT: "9402" },
        configuredBaseUrl: "http://127.0.0.1:8500/v1/",
      }),
    ).toBe("http://127.0.0.1:8500/v1");
  });

  it("honours OPENZOO_BASE_URL and appends the /v1 path when missing", () => {
    expect(resolveOpenzooBaseUrl({ env: { OPENZOO_BASE_URL: "http://proxy-host:8402" } })).toBe(
      "http://proxy-host:8402/v1",
    );
    expect(resolveOpenzooBaseUrl({ env: { OPENZOO_BASE_URL: "http://proxy-host:8402/v1/" } })).toBe(
      "http://proxy-host:8402/v1",
    );
  });

  it("honours OPENZOO_PORT and ignores unusable ports", () => {
    expect(resolveOpenzooBaseUrl({ env: { OPENZOO_PORT: "9402" } })).toBe(
      "http://localhost:9402/v1",
    );
    for (const port of ["0", "70000", "abc", "84.02", ""]) {
      expect(resolveOpenzooBaseUrl({ env: { OPENZOO_PORT: port } })).toBe(
        "http://localhost:8402/v1",
      );
    }
  });

  it("ignores non-http base URLs", () => {
    expect(normalizeOpenzooBaseUrl("ftp://proxy-host:8402/v1")).toBeUndefined();
    expect(normalizeOpenzooBaseUrl("not a url")).toBeUndefined();
    expect(normalizeOpenzooBaseUrl("   ")).toBeUndefined();
    expect(resolveOpenzooBaseUrl({ env: { OPENZOO_BASE_URL: "ftp://proxy-host" } })).toBe(
      "http://localhost:8402/v1",
    );
  });

  it("derives the models and info endpoints from the base URL", () => {
    expect(resolveOpenzooModelsUrl("http://localhost:8402/v1/")).toBe(
      "http://localhost:8402/v1/models",
    );
    expect(resolveOpenzooInfoUrl("http://localhost:8402/v1")).toBe("http://localhost:8402/v1/info");
  });
});
