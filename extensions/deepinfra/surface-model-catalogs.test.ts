import { clearLiveCatalogCacheForTests } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
// Deepinfra tests cover surface model catalogs plugin behavior.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listDeepInfraImageGenCatalog,
  listDeepInfraVideoGenCatalog,
  resolveDeepInfraVideoModelCapabilities,
} from "./surface-model-catalogs.js";

beforeEach(() => {
  clearLiveCatalogCacheForTests();
});

function makeCtx(overrides: Partial<Parameters<typeof listDeepInfraImageGenCatalog>[0]> = {}) {
  return {
    config: {},
    env: { ...process.env },
    resolveProviderApiKey: (_id?: string) => ({
      apiKey: undefined,
      discoveryApiKey: undefined,
    }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none" as const,
      source: "none" as const,
    }),
    ...overrides,
  } as Parameters<typeof listDeepInfraImageGenCatalog>[0];
}

function withKeyCtx(): Parameters<typeof listDeepInfraImageGenCatalog>[0] {
  return makeCtx({
    resolveProviderApiKey: () => ({
      apiKey: "sk-test",
      discoveryApiKey: "sk-test",
    }),
  });
}

const surfaceEntry = (id: string, surfaceTag: string, extra: Record<string, unknown> = {}) => ({
  id,
  object: "model" as const,
  owned_by: "deepinfra",
  metadata: {
    description: id,
    tags: [surfaceTag],
    pricing: {},
    ...extra,
  },
});

function jsonResponse(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  });
}

async function withLiveFetch(mockFetch: ReturnType<typeof vi.fn>, run: () => Promise<void>) {
  vi.stubEnv("DEEPINFRA_API_KEY", "sk-test");
  vi.stubGlobal("fetch", mockFetch);
  try {
    await run();
  } finally {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  }
}

describe("DeepInfra generation catalogs", () => {
  it("return null when no discoveryApiKey is configured", async () => {
    await expect(listDeepInfraImageGenCatalog(makeCtx())).resolves.toBeNull();
    await expect(listDeepInfraVideoGenCatalog(makeCtx())).resolves.toBeNull();
  });
});

describe("listDeepInfraImageGenCatalog", () => {
  it("returns null when live discovery succeeds but the response has zero image-gen entries", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("anthropic/claude-sonnet-4-6", "chat", {
            context_length: 200000,
            max_tokens: 8192,
            pricing: { input_tokens: 3, output_tokens: 15 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const result = await listDeepInfraImageGenCatalog(withKeyCtx());
      expect(result).toBeNull();
    });
  });

  it("does not publish fallback models as live after an acquisition failure", async () => {
    const mockFetch = vi.fn().mockResolvedValue(new Response("unavailable", { status: 503 }));
    await withLiveFetch(mockFetch, async () => {
      await expect(listDeepInfraImageGenCatalog(withKeyCtx())).resolves.toBeNull();
      await expect(listDeepInfraVideoGenCatalog(withKeyCtx())).resolves.toBeNull();
    });
  });

  it("projects discovered image-gen entries when a key is configured and discovery is live", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("black-forest-labs/FLUX-2-pro", "image-gen", {
            pricing: { per_image_unit: 0.08 },
            default_width: 1024,
            default_height: 1024,
            default_iterations: 28,
          }),
          surfaceEntry("ByteDance/Seedream-4", "image-gen", {
            pricing: { per_image_unit: 0.03 },
          }),
          surfaceEntry("anthropic/claude-sonnet-4-6", "chat", {
            context_length: 200000,
            max_tokens: 8192,
            pricing: { input_tokens: 3, output_tokens: 15 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const result = await listDeepInfraImageGenCatalog(withKeyCtx());
      expect(result).not.toBeNull();
      expect(result?.map((e) => e.model)).toEqual([
        "black-forest-labs/FLUX-2-pro",
        "ByteDance/Seedream-4",
      ]);
      for (const entry of result ?? []) {
        expect(entry.kind).toBe("image_generation");
        expect(entry.provider).toBe("deepinfra");
        expect(entry.source).toBe("live");
      }
    });
  });
});

describe("listDeepInfraVideoGenCatalog", () => {
  it("returns null when live discovery succeeds but the response has zero video-gen entries", async () => {
    // Current production state: TTS/STT/T2V models lack the OPENAI tag the
    // backend filter requires, so a key-authenticated discovery still
    // produces zero video-gen entries. We must return null so the registered
    // provider's static fallback list is consulted instead of an empty
    // "live" answer.
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("anthropic/claude-sonnet-4-6", "chat", {
            context_length: 200000,
            max_tokens: 8192,
            pricing: { input_tokens: 3, output_tokens: 15 },
          }),
          surfaceEntry("black-forest-labs/FLUX-2-pro", "image-gen", {
            pricing: { per_image_unit: 0.08 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const result = await listDeepInfraVideoGenCatalog(withKeyCtx());
      expect(result).toBeNull();
    });
  });

  it("projects discovered video-gen entries with capability shape", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("Wan-AI/Wan2.6-T2V", "video-gen", {
            pricing: { output_seconds: 0.05 },
          }),
          surfaceEntry("ByteDance/Seedance-2.0", "video-gen", {
            pricing: { output_seconds: 0.08 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const result = await listDeepInfraVideoGenCatalog(withKeyCtx());
      expect(result).not.toBeNull();
      expect(result?.map((e) => e.model)).toEqual(["Wan-AI/Wan2.6-T2V", "ByteDance/Seedance-2.0"]);
      const first = result?.[0];
      expect(first?.kind).toBe("video_generation");
      expect(first?.capabilities?.generate?.supportsAspectRatio).toBe(true);
      expect(first?.capabilities?.generate?.supportedDurationSeconds).toEqual([5, 8]);
      // Catalog must not advertise options the runtime drops: guidance is not
      // part of the /v1/openai/videos contract, so catalog == runtime providerOptions.
      expect(first?.capabilities?.providerOptions).not.toHaveProperty("guidance_scale");
      expect(first?.capabilities?.providerOptions).not.toHaveProperty("guidanceScale");
    });
  });
});

describe("resolveDeepInfraVideoModelCapabilities", () => {
  it("returns capabilities for a discovered video-gen model", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("Wan-AI/Wan2.6-T2V", "video-gen", {
            pricing: { output_seconds: 0.05 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const caps = await resolveDeepInfraVideoModelCapabilities({
        model: "Wan-AI/Wan2.6-T2V",
      } as Parameters<typeof resolveDeepInfraVideoModelCapabilities>[0]);
      expect(caps).toBeDefined();
      expect(caps?.generate?.supportsAspectRatio).toBe(true);
    });
  });

  it("strips the deepinfra/ prefix when matching", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("Wan-AI/Wan2.6-T2V", "video-gen", {
            pricing: { output_seconds: 0.05 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const caps = await resolveDeepInfraVideoModelCapabilities({
        model: "deepinfra/Wan-AI/Wan2.6-T2V",
      } as Parameters<typeof resolveDeepInfraVideoModelCapabilities>[0]);
      expect(caps).toBeDefined();
    });
  });

  it("returns undefined for an unknown model", async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      jsonResponse({
        data: [
          surfaceEntry("Wan-AI/Wan2.6-T2V", "video-gen", {
            pricing: { output_seconds: 0.05 },
          }),
        ],
      }),
    );

    await withLiveFetch(mockFetch, async () => {
      const caps = await resolveDeepInfraVideoModelCapabilities({
        model: "ByteDance/Seedance-2.0",
      } as Parameters<typeof resolveDeepInfraVideoModelCapabilities>[0]);
      expect(caps).toBeUndefined();
    });
  });
});
