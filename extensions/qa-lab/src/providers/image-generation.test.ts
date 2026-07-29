// Qa Lab tests cover image generation plugin behavior.
import { describe, expect, it } from "vitest";
import { buildQaImageGenerationConfigPatch } from "./image-generation.js";

describe("QA provider image generation config", () => {
  it("uses the OpenAI image provider against the selected mock-openai endpoint", () => {
    const patch = buildQaImageGenerationConfigPatch({
      providerMode: "mock-openai",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      requiredPluginIds: ["qa-channel"],
    });

    expect(patch.plugins.allow).toEqual(["acpx", "memory-core", "openai", "qa-channel"]);
    expect(patch.plugins.entries?.openai).toEqual({ enabled: true });
    expect(patch.agents.defaults.mediaModels.image.primary).toBe("openai/gpt-image-1");
    expect(patch.models?.providers["mock-openai"]?.baseUrl).toBe("http://127.0.0.1:44080/v1");
    expect(patch.models?.providers.openai?.baseUrl).toBe("http://127.0.0.1:44080/v1");
  });

  it("preserves already-allowed plugins when configuring image generation", () => {
    const patch = buildQaImageGenerationConfigPatch({
      providerMode: "mock-openai",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      requiredPluginIds: ["qa-channel"],
      existingPluginIds: ["openai", "anthropic", "qa-channel"],
    });

    expect(patch.plugins.allow).toEqual([
      "acpx",
      "memory-core",
      "openai",
      "anthropic",
      "qa-channel",
    ]);
  });

  it("keeps forced Codex text routing reproducible while images use the mock", () => {
    const patch = buildQaImageGenerationConfigPatch({
      providerMode: "mock-openai",
      providerBaseUrl: "http://127.0.0.1:44080/v1",
      requiredPluginIds: ["qa-channel"],
      existingPluginIds: ["codex", "openai"],
      forcedRuntime: "codex",
    });

    expect(patch.models?.mode).toBe("merge");
    expect(patch.models?.providers["mock-openai"]).toBeUndefined();
    expect(patch.models?.providers.openai?.baseUrl).toBe("https://api.openai.com/v1");
    expect(patch.models?.providers.openai?.request).toBeUndefined();
    expect(
      patch.models?.providers.openai?.models.find((model) => model.id === "gpt-5.6-luna-alt")
        ?.baseUrl,
    ).toBeUndefined();
    expect(
      patch.models?.providers.openai?.models.find((model) => model.id === "gpt-image-1")?.baseUrl,
    ).toBe("http://127.0.0.1:44080/v1");
  });
  it("routes AIMock image generation through the OpenAI image provider", () => {
    const patch = buildQaImageGenerationConfigPatch({
      providerMode: "aimock",
      providerBaseUrl: "http://127.0.0.1:45080/v1",
      requiredPluginIds: [],
    });

    expect(patch.plugins.allow).toEqual(["acpx", "memory-core", "openai"]);
    expect(patch.plugins.entries).toEqual({ openai: { enabled: true } });
    expect(patch.agents.defaults.mediaModels.image.primary).toBe("openai/gpt-image-1");
    expect(patch.models?.providers.aimock?.baseUrl).toBe("http://127.0.0.1:45080/v1");
    expect(patch.models?.providers["mock-openai"]).toBeUndefined();
  });

  it("enables the live image provider plugin without replacing live model config", () => {
    const patch = buildQaImageGenerationConfigPatch({
      providerMode: "live-frontier",
      requiredPluginIds: ["qa-channel"],
    });

    expect(patch.plugins).toEqual({
      allow: ["acpx", "memory-core", "openai", "qa-channel"],
      entries: {
        openai: {
          enabled: true,
        },
      },
    });
    expect(patch.agents.defaults.mediaModels.image.primary).toBe("openai/gpt-image-1");
    expect(patch).not.toHaveProperty("models");
  });
});
