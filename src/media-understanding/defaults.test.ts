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
      "openai-codex": { capabilities: ["image"], defaultModels: { image: "gpt-5.5" } },
      opencode: { capabilities: ["image"], defaultModels: { image: "gpt-5-nano" } },
      "opencode-go": { capabilities: ["image"], defaultModels: { image: "kimi-k2.6" } },
      openrouter: { capabilities: ["image"], defaultModels: { image: "auto" } },
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
});

describe("resolveAutoMediaKeyProviders", () => {
  it("keeps the bundled audio fallback order", () => {
    expect(resolveAutoMediaKeyProviders({ capability: "audio" })).toEqual([
      "openai",
      "xai",
      "google",
      "mistral",
    ]);
  });

  it("keeps the bundled image fallback order", () => {
    expect(resolveAutoMediaKeyProviders({ capability: "image" })).toEqual([
      "openai",
      "anthropic",
      "google",
      "minimax",
      "minimax-portal",
      "zai",
    ]);
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
