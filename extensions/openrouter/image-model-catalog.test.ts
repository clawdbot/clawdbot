// Openrouter tests cover image model capability discovery.
import type { ImageGenerationModelCapabilitiesContext } from "openclaw/plugin-sdk/image-generation";
import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOpenRouterImageModelCapabilities } from "./image-model-catalog.js";

const { fetchWithTimeoutGuardedMock, resolveApiKeyForProviderMock } = vi.hoisted(() => ({
  fetchWithTimeoutGuardedMock: vi.fn(),
  resolveApiKeyForProviderMock: vi.fn(
    async (): Promise<{ apiKey: string | undefined }> => ({ apiKey: "openrouter-key" }),
  ),
}));

vi.mock("openclaw/plugin-sdk/provider-auth-runtime", () => ({
  resolveApiKeyForProvider: resolveApiKeyForProviderMock,
}));

vi.mock("openclaw/plugin-sdk/provider-http", async () => {
  const actual = await vi.importActual<typeof import("openclaw/plugin-sdk/provider-http")>(
    "openclaw/plugin-sdk/provider-http",
  );
  return {
    ...actual,
    fetchWithTimeoutGuarded: fetchWithTimeoutGuardedMock,
  };
});

// Trimmed from the live `GET /api/v1/images/models` payload (captured 2026-08-15).
const CATALOG_PAYLOAD = {
  data: [
    {
      id: "google/gemini-3.1-flash-image-preview",
      name: "Google: Gemini 3.1 Flash Image Preview",
      supported_parameters: {
        aspect_ratio: {
          type: "enum",
          values: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
        },
        resolution: { type: "enum", values: ["512", "1K", "2K", "4K"] },
        n: { type: "range", min: 1, max: 1 },
        input_references: { type: "range", min: 0, max: 14 },
      },
    },
    {
      // Synthetic: every advertised resolution falls outside OpenClaw's union,
      // and no input_references descriptor (generate-only model).
      id: "test/low-res-only",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: ["1:1"] },
        resolution: { type: "enum", values: ["512"] },
      },
    },
    {
      // Synthetic: malformed descriptors that must each drop only themselves.
      id: "test/malformed-descriptors",
      supported_parameters: {
        aspect_ratio: { type: "enum", values: [1, 2, "16:9"] },
        input_references: { type: "range", min: 0, max: -1 },
        n: { type: "range", min: 1, max: 0.5 },
      },
    },
    {
      id: "openai/gpt-5.4-image-2",
      name: "OpenAI: GPT-5.4 Image 2",
      supported_parameters: {
        aspect_ratio: {
          type: "enum",
          values: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"],
        },
        quality: { type: "enum", values: ["auto", "low", "medium", "high"] },
        background: { type: "enum", values: ["auto", "opaque"] },
        n: { type: "range", min: 1, max: 10 },
        input_references: { type: "range", min: 0, max: 16 },
        output_compression: { type: "range", min: 0, max: 100 },
        seed: { type: "boolean" },
        future_knob: { type: "enum_number", values: [1, 2] },
      },
    },
  ],
};

function releasedJson(value: unknown) {
  return {
    response: new Response(JSON.stringify(value), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
    release: vi.fn(async () => {}),
  };
}

function buildContext(
  model: string,
  cfg: Record<string, unknown> = {},
): ImageGenerationModelCapabilitiesContext {
  return {
    provider: "openrouter",
    model,
    cfg,
  } as ImageGenerationModelCapabilitiesContext;
}

function requireFetchRequest(index = 0): { url: string; headers: Headers } {
  const call = fetchWithTimeoutGuardedMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected image catalog fetch at index ${index}`);
  }
  const [url, init] = call as [string, { headers: Headers }];
  return { url, headers: init.headers };
}

describe("openrouter image model catalog", () => {
  beforeEach(() => {
    clearLiveCatalogCacheForTests();
    fetchWithTimeoutGuardedMock.mockReset();
    resolveApiKeyForProviderMock.mockReset();
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: "openrouter-key" });
  });

  it("parses Gemini descriptors into aspect-ratio and resolution capabilities", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("google/gemini-3.1-flash-image-preview"),
    );

    expect(capabilities).toEqual({
      generate: { supportsAspectRatio: true, supportsResolution: true },
      edit: {
        supportsAspectRatio: true,
        supportsResolution: true,
        enabled: true,
        maxInputImages: 14,
      },
      geometry: {
        aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "9:16", "16:9", "21:9"],
        // "512" is advertised upstream but outside OpenClaw's resolution union.
        resolutions: ["1K", "2K", "4K"],
      },
    });
    // `n: {min:1,max:1}` must never surface as maxCount: the provider fans out
    // `count` single-image requests, so per-request batch size is irrelevant.
    expect(capabilities?.generate).not.toHaveProperty("maxCount");
    expect(requireFetchRequest().url).toBe("https://openrouter.ai/api/v1/images/models");
  });

  it("parses OpenAI descriptors and drops unrecognized ones per parameter", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("openai/gpt-5.4-image-2"),
    );

    expect(capabilities).toEqual({
      generate: { supportsAspectRatio: true, supportsResolution: false },
      edit: {
        supportsAspectRatio: true,
        supportsResolution: false,
        enabled: true,
        maxInputImages: 16,
      },
      geometry: {
        aspectRatios: ["1:1", "3:2", "2:3", "4:3", "3:4", "16:9", "9:16", "21:9", "auto"],
      },
      // The boolean `seed` and unknown `future_knob` descriptors drop only
      // themselves; sibling enums still parse.
      output: {
        qualities: ["auto", "low", "medium", "high"],
        backgrounds: ["auto", "opaque"],
      },
    });
  });

  it("treats a resolution set entirely outside the union as unsupported", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("test/low-res-only"),
    );

    // supportsResolution: true with an empty geometry list would skip enum
    // snapping and forward raw values unsanitized; unsupported reports instead.
    expect(capabilities?.generate).toEqual({
      supportsAspectRatio: true,
      supportsResolution: false,
    });
    expect(capabilities?.geometry).toEqual({ aspectRatios: ["1:1"] });
    // No input_references descriptor → edits unsupported, so reference images
    // skip visibly instead of riding the static limit into a model that never
    // advertised them.
    expect(capabilities?.edit).toEqual({
      supportsAspectRatio: true,
      supportsResolution: false,
      enabled: false,
      maxInputImages: 0,
    });
  });

  it("drops malformed descriptors per parameter without disabling the model", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("test/malformed-descriptors"),
    );

    // Numeric enum entries are dropped; the remaining string still parses.
    expect(capabilities?.geometry).toEqual({ aspectRatios: ["16:9"] });
    expect(capabilities?.generate).toEqual({
      supportsAspectRatio: true,
      supportsResolution: false,
    });
    // A negative range max (an "unlimited" sentinel or bad data) drops only
    // input_references — it must never become a limit that blocks generation.
    expect(capabilities?.edit).toEqual({
      supportsAspectRatio: true,
      supportsResolution: false,
      enabled: false,
      maxInputImages: 0,
    });
  });

  it("returns undefined for models absent from the catalog", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    await expect(
      resolveOpenRouterImageModelCapabilities(buildContext("someone/new-model")),
    ).resolves.toBeUndefined();
  });

  it("skips discovery entirely for non-canonical base URLs", async () => {
    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("google/gemini-3.1-flash-image-preview", {
        models: {
          providers: {
            openrouter: { baseUrl: "https://custom.openrouter.test/api/v1" },
          },
        },
      }),
    );

    expect(capabilities).toBeUndefined();
    expect(fetchWithTimeoutGuardedMock).not.toHaveBeenCalled();
  });

  it("serves repeated lookups from one cached catalog fetch", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const first = await resolveOpenRouterImageModelCapabilities(
      buildContext("google/gemini-3.1-flash-image-preview"),
    );
    const second = await resolveOpenRouterImageModelCapabilities(
      buildContext("openai/gpt-5.4-image-2"),
    );

    expect(first?.generate.supportsResolution).toBe(true);
    expect(second?.generate.supportsResolution).toBe(false);
    expect(fetchWithTimeoutGuardedMock).toHaveBeenCalledTimes(1);
  });

  it("fetches the public catalog without an API key when none resolves", async () => {
    resolveApiKeyForProviderMock.mockResolvedValue({ apiKey: undefined });
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    const capabilities = await resolveOpenRouterImageModelCapabilities(
      buildContext("google/gemini-3.1-flash-image-preview"),
    );

    expect(capabilities?.generate.supportsAspectRatio).toBe(true);
    expect(requireFetchRequest().headers.get("Authorization")).toBeNull();
  });

  it("sends the API key when one resolves", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce(releasedJson(CATALOG_PAYLOAD));

    await resolveOpenRouterImageModelCapabilities(
      buildContext("google/gemini-3.1-flash-image-preview"),
    );

    expect(requireFetchRequest().headers.get("Authorization")).toBe("Bearer openrouter-key");
  });

  it("propagates fetch failures for the runtime overlay to degrade to static caps", async () => {
    fetchWithTimeoutGuardedMock.mockRejectedValueOnce(new Error("catalog offline"));
    await expect(
      resolveOpenRouterImageModelCapabilities(
        buildContext("google/gemini-3.1-flash-image-preview"),
      ),
    ).rejects.toThrow("catalog offline");
  });

  it("propagates non-200 catalog responses", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response("upstream unavailable", { status: 503 }),
      release: vi.fn(async () => {}),
    });
    await expect(
      resolveOpenRouterImageModelCapabilities(
        buildContext("google/gemini-3.1-flash-image-preview"),
      ),
    ).rejects.toThrow();
  });

  it("propagates malformed catalog JSON", async () => {
    fetchWithTimeoutGuardedMock.mockResolvedValueOnce({
      response: new Response("not-json", {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
      release: vi.fn(async () => {}),
    });
    await expect(
      resolveOpenRouterImageModelCapabilities(
        buildContext("google/gemini-3.1-flash-image-preview"),
      ),
    ).rejects.toThrow();
  });
});
