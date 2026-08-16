/** Tests image capability overlay merging and request-local provider resolution. */
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  mergeImageGenerationProviderCapabilities,
  resolveProviderWithModelCapabilities,
} from "./capability-overlays.js";
import type { ImageGenerationProvider, ImageGenerationProviderCapabilities } from "./types.js";

const cfg = {} as OpenClawConfig;

function buildProvider(overrides: Partial<ImageGenerationProvider> = {}): ImageGenerationProvider {
  return {
    id: "openrouter",
    capabilities: {
      generate: { maxCount: 4, supportsAspectRatio: true, supportsResolution: true },
      edit: { enabled: true, maxInputImages: 5, supportsAspectRatio: true },
      geometry: { aspectRatios: ["1:1", "16:9"], resolutions: ["1K", "2K", "4K"] },
    },
    generateImage: async () => ({
      images: [{ buffer: Buffer.from("png-bytes"), mimeType: "image/png" }],
    }),
    ...overrides,
  };
}

describe("mergeImageGenerationProviderCapabilities", () => {
  it("lets overlay values win per mode while keeping unset base values", () => {
    const merged = mergeImageGenerationProviderCapabilities(buildProvider().capabilities, {
      generate: { supportsResolution: false },
      edit: { enabled: true, maxInputImages: 14 },
      geometry: { aspectRatios: ["1:1", "21:9"] },
      output: { qualities: ["high"] },
    });

    expect(merged.generate).toEqual({
      maxCount: 4,
      supportsAspectRatio: true,
      supportsResolution: false,
    });
    expect(merged.edit).toEqual({ enabled: true, maxInputImages: 14, supportsAspectRatio: true });
    expect(merged.geometry).toEqual({
      aspectRatios: ["1:1", "21:9"],
      resolutions: ["1K", "2K", "4K"],
    });
    expect(merged.output).toEqual({ qualities: ["high"] });
  });

  it("keeps base geometry and output when the overlay declares neither", () => {
    const base: ImageGenerationProviderCapabilities = {
      generate: {},
      edit: { enabled: false },
      output: { backgrounds: ["opaque"] },
    };
    const merged = mergeImageGenerationProviderCapabilities(base, {
      generate: {},
      edit: { enabled: false },
    });
    expect(merged.geometry).toBeUndefined();
    expect(merged.output).toEqual({ backgrounds: ["opaque"] });
  });
});

describe("resolveProviderWithModelCapabilities", () => {
  const baseParams = {
    providerId: "openrouter",
    model: "some/model",
    cfg,
    log: { debug: () => {} },
  };

  it("returns the provider unchanged when it declares no capability hook", async () => {
    const provider = buildProvider();
    const resolved = await resolveProviderWithModelCapabilities({ ...baseParams, provider });
    expect(resolved).toBe(provider);
  });

  it("returns the provider unchanged when the hook resolves undefined", async () => {
    const provider = buildProvider({ resolveModelCapabilities: async () => undefined });
    const resolved = await resolveProviderWithModelCapabilities({ ...baseParams, provider });
    expect(resolved).toBe(provider);
  });

  it("returns a request-local copy so model caps never leak across requests", async () => {
    const provider = buildProvider({
      resolveModelCapabilities: async () => ({
        generate: { supportsResolution: false },
        edit: { enabled: true },
      }),
    });
    const resolved = await resolveProviderWithModelCapabilities({ ...baseParams, provider });

    expect(resolved).not.toBe(provider);
    expect(resolved.capabilities.generate.supportsResolution).toBe(false);
    // The registered provider's static capabilities stay untouched.
    expect(provider.capabilities.generate.supportsResolution).toBe(true);
  });

  it("passes the request context through to the capability hook", async () => {
    let seenContext: unknown;
    const provider = buildProvider({
      resolveModelCapabilities: async (ctx) => {
        seenContext = ctx;
        return undefined;
      },
    });
    await resolveProviderWithModelCapabilities({
      ...baseParams,
      provider,
      agentDir: "/tmp/agent",
      timeoutMs: 1234,
    });
    expect(seenContext).toEqual({
      provider: "openrouter",
      model: "some/model",
      cfg,
      agentDir: "/tmp/agent",
      authStore: undefined,
      timeoutMs: 1234,
    });
  });

  it("treats a hook failure as no overlay and logs at debug", async () => {
    const debugMessages: string[] = [];
    const provider = buildProvider({
      resolveModelCapabilities: async () => {
        throw new Error("discovery down");
      },
    });
    const resolved = await resolveProviderWithModelCapabilities({
      ...baseParams,
      provider,
      log: {
        debug: (message: string) => {
          debugMessages.push(message);
        },
      },
    });
    expect(resolved).toBe(provider);
    expect(debugMessages).toHaveLength(1);
    expect(debugMessages[0]).toContain("discovery down");
    expect(debugMessages[0]).toContain("openrouter/some/model");
  });
});
