// Verifies catalog-backed endpoint classification for externalized official providers.
import { describe, expect, it, vi } from "vitest";

// Simulates a built dist tree: externalized provider metadata comes from the
// catalog, while one installed manifest proves first-match precedence.
vi.mock("../plugins/current-plugin-metadata-snapshot.js", async () => {
  const { buildPluginMetadataProviderFacts } =
    await import("../plugins/plugin-metadata-provider-facts.js");
  return {
    getCurrentPluginMetadataSnapshot: () => ({
      owners: buildPluginMetadataProviderFacts([
        {
          id: "installed-conflict-fixture",
          providerEndpoints: [
            { endpointClass: "openai-public", hosts: ["coding.dashscope.aliyuncs.com"] },
          ],
        } as never,
      ]),
    }),
  };
});

import {
  resolveProviderEndpoint,
  resolveProviderRequestCapabilities,
} from "./provider-attribution.js";

describe("catalog-backed provider endpoint classification", () => {
  it.each([
    ["https://dashscope.aliyuncs.com/compatible-mode/v1", "modelstudio-native"],
    ["https://dashscope-intl.aliyuncs.com/compatible-mode/v1", "modelstudio-native"],
    ["https://coding-intl.dashscope.aliyuncs.com/v1", "modelstudio-native"],
    [
      "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
      "modelstudio-native",
    ],
    ["https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1", "modelstudio-native"],
    ["https://api.moonshot.ai/v1", "moonshot-native"],
    ["https://api.moonshot.cn/v1", "moonshot-native"],
    ["https://api.z.ai/api/coding/paas/v4", "zai-native"],
    ["https://api.deepseek.com", "deepseek-native"],
    ["https://api.groq.com/openai/v1", "groq-native"],
    ["https://api.cerebras.ai/v1", "cerebras-native"],
    ["https://llm.chutes.ai/v1", "chutes-native"],
    ["https://api.meta.ai/v1", "meta-native"],
  ])("classifies %s as %s without an installed plugin manifest", (baseUrl, endpointClass) => {
    expect(resolveProviderEndpoint(baseUrl).endpointClass).toBe(endpointClass);
  });

  it("resolves DashScope request capabilities from catalog metadata", () => {
    // Image describe placement and streaming-usage compat both key off this
    // classification; see shouldPlaceImagePromptInUserContent and
    // normalizeModelCompat regressions when qwen was externalized.
    const capabilities = resolveProviderRequestCapabilities({
      provider: "qwen",
      api: "openai-completions",
      baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
      capability: "image",
      transport: "media-understanding",
    });
    expect(capabilities.endpointClass).toBe("modelstudio-native");
    expect(capabilities.supportsNativeStreamingUsageCompat).toBe(true);
    expect(capabilities.isKnownNativeEndpoint).toBe(true);
  });

  it("resolves Meta request capabilities from catalog metadata", () => {
    const capabilities = resolveProviderRequestCapabilities({
      provider: "meta",
      api: "openai-responses",
      baseUrl: "https://api.meta.ai/v1",
      capability: "llm",
      transport: "stream",
    });
    expect(capabilities.endpointClass).toBe("meta-native");
    expect(capabilities.isKnownNativeEndpoint).toBe(true);
  });

  it.each([
    "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
    "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
  ])("resolves Token Plan request capabilities for %s", (baseUrl) => {
    const capabilities = resolveProviderRequestCapabilities({
      provider: "qwen-token-plan",
      api: "openai-completions",
      baseUrl,
      capability: "llm",
      transport: "stream",
    });
    expect(capabilities.endpointClass).toBe("modelstudio-native");
    expect(capabilities.supportsNativeStreamingUsageCompat).toBe(true);
    expect(capabilities.isKnownNativeEndpoint).toBe(true);
  });

  it("prefers installed plugin manifest endpoints over catalog metadata", () => {
    expect(resolveProviderEndpoint("https://coding.dashscope.aliyuncs.com/v1").endpointClass).toBe(
      "openai-public",
    );
  });

  it("keeps unknown hosts classified as custom", () => {
    expect(resolveProviderEndpoint("https://proxy.example.com/v1").endpointClass).toBe("custom");
  });

  it("keeps removed and unsupported catalog endpoints custom", () => {
    expect(resolveProviderEndpoint("https://portal.qwen.ai/v1").endpointClass).toBe("custom");

    // deepinfra-native and gmi-native are mirrored faithfully from their manifests
    // but are not core ProviderEndpointClass members, so they must stay inert.
    expect(resolveProviderEndpoint("https://api.deepinfra.com/v1/openai").endpointClass).toBe(
      "custom",
    );
    expect(resolveProviderEndpoint("https://api.gmi-serving.com/v1").endpointClass).toBe("custom");
  });
});
