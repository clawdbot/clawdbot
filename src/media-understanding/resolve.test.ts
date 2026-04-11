import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.js";
import { resolveEntriesWithActiveFallback, resolveModelEntries } from "./resolve.js";
import type { MediaUnderstandingCapability } from "./types.js";

const providerRegistry = new Map<string, { capabilities: MediaUnderstandingCapability[] }>([
  ["openai", { capabilities: ["image"] }],
  ["groq", { capabilities: ["audio"] }],
]);

describe("resolveModelEntries", () => {
  it("uses provider capabilities for shared entries without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ provider: "openai", model: "gpt-5.4" }],
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);

    const audioEntries = resolveModelEntries({
      cfg,
      capability: "audio",
      providerRegistry,
    });
    expect(audioEntries).toHaveLength(0);
  });

  it("keeps per-capability entries even without explicit caps", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          image: {
            models: [{ provider: "openai", model: "gpt-5.4" }],
          },
        },
      },
    };

    const imageEntries = resolveModelEntries({
      cfg,
      capability: "image",
      config: cfg.tools?.media?.image,
      providerRegistry,
    });
    expect(imageEntries).toHaveLength(1);
  });

  it("skips shared CLI entries without capabilities", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          models: [{ type: "cli", command: "gemini", args: ["--file", "{{MediaPath}}"] }],
        },
      },
    };

    const entries = resolveModelEntries({
      cfg,
      capability: "image",
      providerRegistry,
    });
    expect(entries).toHaveLength(0);
  });
});

describe("resolveEntriesWithActiveFallback", () => {
  type ResolveWithFallbackInput = Parameters<typeof resolveEntriesWithActiveFallback>[0];
  const defaultActiveModel = { provider: "groq", model: "whisper-large-v3" } as const;

  function resolveWithActiveFallback(params: {
    cfg: ResolveWithFallbackInput["cfg"];
    capability: ResolveWithFallbackInput["capability"];
    config: ResolveWithFallbackInput["config"];
  }) {
    return resolveEntriesWithActiveFallback({
      cfg: params.cfg,
      capability: params.capability,
      config: params.config,
      providerRegistry,
      activeModel: defaultActiveModel,
    });
  }

  function expectResolvedProviders(params: {
    cfg: OpenClawConfig;
    capability: ResolveWithFallbackInput["capability"];
    config: ResolveWithFallbackInput["config"];
    providers: string[];
  }) {
    const entries = resolveWithActiveFallback({
      cfg: params.cfg,
      capability: params.capability,
      config: params.config,
    });
    expect(entries).toHaveLength(params.providers.length);
    expect(entries.map((entry) => entry.provider)).toEqual(params.providers);
  }

  it("uses active model when enabled and no models are configured", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: { enabled: true },
        },
      },
    };

    expectResolvedProviders({
      cfg,
      capability: "audio",
      config: cfg.tools?.media?.audio,
      providers: ["groq"],
    });
  });

  it("ignores active model when configured entries exist", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          audio: { enabled: true, models: [{ provider: "openai", model: "whisper-1" }] },
        },
      },
    };

    expectResolvedProviders({
      cfg,
      capability: "audio",
      config: cfg.tools?.media?.audio,
      providers: ["openai"],
    });
  });

  it("skips active model when provider lacks capability", () => {
    const cfg: OpenClawConfig = {
      tools: {
        media: {
          video: { enabled: true },
        },
      },
    };

    const entries = resolveWithActiveFallback({
      cfg,
      capability: "video",
      config: cfg.tools?.media?.video,
    });
    expect(entries).toHaveLength(0);
  });
});
