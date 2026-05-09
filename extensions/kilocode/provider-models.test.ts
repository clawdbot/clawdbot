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

import { discoverKilocodeModels, KILOCODE_MODELS_URL } from "./provider-models.js";

type MockKilocodeFetchResponse = {
  ok: boolean;
  status?: number;
  json?: () => Promise<unknown>;
};

type MockKilocodeFetch = ((
  url: string,
  init?: RequestInit,
) => Promise<MockKilocodeFetchResponse>) & {
  mock: { calls: unknown[][] };
};

function requireModelById(
  models: Awaited<ReturnType<typeof discoverKilocodeModels>>,
  id: string,
): Awaited<ReturnType<typeof discoverKilocodeModels>>[number] {
  const model = models.find((candidate) => candidate.id === id);
  if (!model) {
    throw new Error(`expected Kilocode model ${id}`);
  }
  return model;
}

function makeGatewayModel(overrides: Record<string, unknown> = {}) {
  return {
    id: "anthropic/claude-sonnet-4",
    name: "Anthropic: Claude Sonnet 4",
    created: 1700000000,
    description: "A model",
    context_length: 200000,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Claude",
    },
    top_provider: {
      is_moderated: false,
      max_completion_tokens: 8192,
    },
    pricing: {
      prompt: "0.000003",
      completion: "0.000015",
      input_cache_read: "0.0000003",
      input_cache_write: "0.00000375",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning"],
    ...overrides,
  };
}

function makeAutoModel(overrides: Record<string, unknown> = {}) {
  return makeGatewayModel({
    id: "kilo/auto",
    name: "Kilo: Auto",
    context_length: 1000000,
    architecture: {
      input_modalities: ["text", "image"],
      output_modalities: ["text"],
      tokenizer: "Other",
    },
    top_provider: {
      is_moderated: false,
      max_completion_tokens: 128000,
    },
    pricing: {
      prompt: "0.000005",
      completion: "0.000025",
    },
    supported_parameters: ["max_tokens", "temperature", "tools", "reasoning", "include_reasoning"],
    ...overrides,
  });
}

async function withFetchPathTest(mockFetch: MockKilocodeFetch, runAssertions: () => Promise<void>) {
  const release = vi.fn(async () => {});
  vi.stubEnv("NODE_ENV", "");
  vi.stubEnv("VITEST", "");

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
  } finally {
    vi.unstubAllEnvs();
    fetchWithSsrFGuardMock.mockReset();
  }
}

afterAll(() => {
  vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
  vi.resetModules();
});

describe("discoverKilocodeModels", () => {
  it("returns static catalog in test environment", async () => {
    const models = await discoverKilocodeModels();
    expect(models.length).toBeGreaterThan(0);
    expect(requireModelById(models, "kilo/auto").id).toBe("kilo/auto");
  });

  it("static catalog has correct defaults for kilo/auto", async () => {
    const models = await discoverKilocodeModels();
    const auto = requireModelById(models, "kilo/auto");
    expect(auto.name).toBe("Kilo Auto");
    expect(auto.reasoning).toBe(true);
    expect(auto.input).toEqual(["text", "image"]);
    expect(auto.contextWindow).toBe(1000000);
    expect(auto.maxTokens).toBe(128000);
    expect(auto.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });
});

describe("discoverKilocodeModels (fetch path)", () => {
  it("parses gateway models with correct pricing conversion", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [makeAutoModel(), makeGatewayModel()],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();

      expect(fetchWithSsrFGuardMock).toHaveBeenCalledWith(
        expect.objectContaining({
          url: KILOCODE_MODELS_URL,
          init: expect.objectContaining({
            headers: { Accept: "application/json" },
          }),
          policy: { allowedHostnames: ["api.kilo.ai"] },
          timeoutMs: 5000,
          auditContext: "kilocode.model_discovery",
        }),
      );
      expect(mockFetch).toHaveBeenCalledWith(
        KILOCODE_MODELS_URL,
        expect.objectContaining({
          headers: { Accept: "application/json" },
        }),
      );

      expect(models.length).toBe(2);

      const sonnet = requireModelById(models, "anthropic/claude-sonnet-4");
      expect(sonnet.cost.input).toBeCloseTo(3.0);
      expect(sonnet.cost.output).toBeCloseTo(15.0);
      expect(sonnet.cost.cacheRead).toBeCloseTo(0.3);
      expect(sonnet.cost.cacheWrite).toBeCloseTo(3.75);
      expect(sonnet.input).toEqual(["text", "image"]);
      expect(sonnet.reasoning).toBe(true);
      expect(sonnet.contextWindow).toBe(200000);
      expect(sonnet.maxTokens).toBe(8192);
    });
  });

  it("falls back to static catalog on network error", async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error("network error"));
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(requireModelById(models, "kilo/auto").id).toBe("kilo/auto");
    });
  });

  it("falls back to static catalog on HTTP error", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(requireModelById(models, "kilo/auto").id).toBe("kilo/auto");
    });
  });

  it("ensures kilo/auto is present even when API doesn't return it", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [makeGatewayModel()],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      expect(requireModelById(models, "kilo/auto").id).toBe("kilo/auto");
      expect(requireModelById(models, "anthropic/claude-sonnet-4").id).toBe(
        "anthropic/claude-sonnet-4",
      );
    });
  });

  it("detects text-only models without image modality", async () => {
    const textOnlyModel = makeGatewayModel({
      id: "some/text-model",
      architecture: {
        input_modalities: ["text"],
        output_modalities: ["text"],
      },
      supported_parameters: ["max_tokens", "temperature"],
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [textOnlyModel] }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      const textModel = requireModelById(models, "some/text-model");
      expect(textModel.input).toEqual(["text"]);
      expect(textModel.reasoning).toBe(false);
    });
  });

  it("keeps a later valid duplicate when an earlier entry is malformed", async () => {
    const malformedAutoModel = makeAutoModel({
      name: "Broken Kilo Auto",
      pricing: undefined,
    });

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          data: [malformedAutoModel, makeAutoModel(), makeGatewayModel()],
        }),
    });
    await withFetchPathTest(mockFetch, async () => {
      const models = await discoverKilocodeModels();
      const auto = requireModelById(models, "kilo/auto");
      expect(auto.name).toBe("Kilo: Auto");
      expect(auto.cost.input).toBeCloseTo(5.0);
      expect(requireModelById(models, "anthropic/claude-sonnet-4").id).toBe(
        "anthropic/claude-sonnet-4",
      );
    });
  });
});
