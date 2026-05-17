import { describe, expect, it, vi } from "vitest";

const mediaMetadataPlugins = vi.hoisted(() => [
  {
    contracts: {
      mediaUnderstandingProviders: [
        "anthropic",
        "google",
        "minimax",
        "minimax-portal",
        "mistral",
        "moonshot",
        "openai",
        "openai-codex",
        "opencode",
        "opencode-go",
        "openrouter",
        "qwen",
        "xai",
        "zai",
      ],
    },
    mediaUnderstandingProviderMetadata: {
      anthropic: {
        capabilities: ["image"],
        autoPriority: { image: 20 },
        nativeDocumentInputs: ["pdf"],
      },
      google: {
        capabilities: ["image", "audio", "video"],
        defaultModels: {
          image: "gemini-3-flash-preview",
          audio: "gemini-3-flash-preview",
          video: "gemini-3-flash-preview",
        },
        autoPriority: { image: 30, audio: 40, video: 10 },
        nativeDocumentInputs: ["pdf"],
      },
      minimax: { capabilities: ["image"], autoPriority: { image: 40 } },
      "minimax-portal": {
        capabilities: ["image"],
        defaultModels: { image: "MiniMax-VL-01" },
        autoPriority: { image: 50 },
      },
      mistral: {
        capabilities: ["audio"],
        defaultModels: { audio: "voxtral-mini-latest" },
        autoPriority: { audio: 50 },
      },
      moonshot: {
        capabilities: ["image", "video"],
        defaultModels: { image: "kimi-k2.6", video: "kimi-k2.6" },
        autoPriority: { video: 30 },
      },
      openai: {
        capabilities: ["image", "audio"],
        defaultModels: { image: "gpt-5.4-mini", audio: "gpt-4o-transcribe" },
        autoPriority: { image: 10, audio: 10 },
      },
      "openai-codex": {
        capabilities: ["image", "audio"],
        defaultModels: { image: "gpt-5.5", audio: "gpt-4o-transcribe" },
        autoPriority: { image: 20, audio: 20 },
      },
      opencode: { capabilities: ["image"], defaultModels: { image: "gpt-5-nano" } },
      "opencode-go": { capabilities: ["image"], defaultModels: { image: "kimi-k2.6" } },
      openrouter: {
        capabilities: ["image", "audio"],
        defaultModels: { image: "auto", audio: "openai/whisper-large-v3-turbo" },
        autoPriority: { audio: 35 },
      },
      qwen: { capabilities: ["video"], autoPriority: { video: 20 } },
      xai: { capabilities: ["audio"], autoPriority: { audio: 25 } },
      zai: { capabilities: ["image"], autoPriority: { image: 60 } },
    },
  },
]);

vi.mock("../plugins/plugin-registry.js", () => ({
  loadPluginManifestRegistryForPluginRegistry: () => ({
    plugins: mediaMetadataPlugins,
    diagnostics: [],
  }),
  loadPluginRegistrySnapshotWithMetadata: () => ({
    source: "derived",
    snapshot: { plugins: [] },
    diagnostics: [],
  }),
}));

vi.mock("../plugins/manifest-contract-eligibility.js", () => ({
  loadManifestMetadataSnapshot: () => ({
    index: { plugins: [] },
    plugins: mediaMetadataPlugins,
  }),
}));

vi.mock("../plugins/current-plugin-metadata-snapshot.js", () => ({
  getCurrentPluginMetadataSnapshot: () => ({
    plugins: mediaMetadataPlugins,
  }),
}));

import {
  providerSupportsNativePdfDocument,
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "./defaults.js";

describe("resolveDefaultMediaModel", () => {
  it("resolves bundled audio defaults from provider metadata", () => {
    expect(resolveDefaultMediaModel({ providerId: "mistral", capability: "audio" })).toBe(
      "voxtral-mini-latest",
    );
    expect(resolveDefaultMediaModel({ providerId: "openai-codex", capability: "audio" })).toBe(
      "gpt-4o-transcribe",
    );
    expect(resolveDefaultMediaModel({ providerId: "openrouter", capability: "audio" })).toBe(
      "openai/whisper-large-v3-turbo",
    );
  });

  it("resolves bundled image defaults beyond the historical core set", () => {
    expect(resolveDefaultMediaModel({ providerId: "minimax-portal", capability: "image" })).toBe(
      "MiniMax-VL-01",
    );
    expect(resolveDefaultMediaModel({ providerId: "openai-codex", capability: "image" })).toBe(
      "gpt-5.5",
    );
    expect(resolveDefaultMediaModel({ providerId: "moonshot", capability: "image" })).toBe(
      "kimi-k2.6",
    );
    expect(resolveDefaultMediaModel({ providerId: "openrouter", capability: "image" })).toBe(
      "auto",
    );
    expect(resolveDefaultMediaModel({ providerId: "opencode", capability: "image" })).toBe(
      "gpt-5-nano",
    );
    expect(resolveDefaultMediaModel({ providerId: "opencode-go", capability: "image" })).toBe(
      "kimi-k2.6",
    );
  });

  it("prefers configured image models before manifest defaults", () => {
    const cfg = {
      models: {
        providers: {
          openrouter: {
            models: [{ id: "google/gemini-2.5-flash", input: ["text", "image"] }],
          },
        },
      },
    } as never;

    expect(resolveDefaultMediaModel({ providerId: "openrouter", capability: "image", cfg })).toBe(
      "google/gemini-2.5-flash",
    );
    expect(
      resolveDefaultMediaModel({
        providerId: "openrouter",
        capability: "image",
        cfg,
        includeConfiguredImageModels: false,
      }),
    ).toBe("auto");
  });
});

describe("resolveAutoMediaKeyProviders", () => {
  it("keeps the bundled audio fallback order", () => {
    expect(resolveAutoMediaKeyProviders({ capability: "audio" })).toEqual([
      "openai",
      "openai-codex",
      "xai",
      "openrouter",
      "google",
      "mistral",
    ]);
  });

  it("keeps the bundled image fallback order", () => {
    expect(resolveAutoMediaKeyProviders({ capability: "image" })).toEqual([
      "openai",
      "anthropic",
      "openai-codex",
      "google",
      "minimax",
      "minimax-portal",
      "zai",
    ]);
  });

  it("preserves configured MiniMax CN aliases for image auto discovery", () => {
    const providers = resolveAutoMediaKeyProviders({
      capability: "image",
      cfg: {
        models: {
          providers: {
            "minimax-cn": {
              models: [{ id: "MiniMax-M2.7", input: ["text", "image"] }],
            },
            "minimax-portal-cn": {
              models: [{ id: "MiniMax-M2.7", input: ["text", "image"] }],
            },
            gemini: {
              models: [{ id: "gemini-3-flash-preview", input: ["text", "image"] }],
            },
          },
        },
      } as never,
    });

    expect(providers).toContain("minimax-cn");
    expect(providers).toContain("minimax-portal-cn");
    expect(providers).not.toContain("gemini");
    expect(providers).toContain("google");
    expect(providers.indexOf("minimax-cn")).toBeLessThan(providers.indexOf("minimax"));
    expect(providers.indexOf("minimax-portal-cn")).toBeLessThan(
      providers.indexOf("minimax-portal"),
    );
  });

  it("keeps the bundled video fallback order", () => {
    expect(resolveAutoMediaKeyProviders({ capability: "video" })).toEqual([
      "google",
      "qwen",
      "moonshot",
    ]);
  });
});

describe("providerSupportsNativePdfDocument", () => {
  it("reads native PDF support from provider metadata", () => {
    const providerRegistry = new Map([
      ["anthropic", { id: "anthropic", nativeDocumentInputs: ["pdf" as const] }],
      ["google", { id: "google", nativeDocumentInputs: ["pdf" as const] }],
      ["openai", { id: "openai", nativeDocumentInputs: [] }],
    ]);
    expect(providerSupportsNativePdfDocument({ providerId: "anthropic", providerRegistry })).toBe(
      true,
    );
    expect(providerSupportsNativePdfDocument({ providerId: "google", providerRegistry })).toBe(
      true,
    );
    expect(providerSupportsNativePdfDocument({ providerId: "openai", providerRegistry })).toBe(
      false,
    );
  });
});
