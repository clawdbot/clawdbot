// Capability registry tests cover plugin-owned capability precedence and
// config-derived image-provider fallback registration.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolvePluginCapabilityProvider } from "../plugins/capability-provider-runtime.js";
import { buildMediaUnderstandingCapabilityRegistry } from "./provider-capability-registry.js";

vi.mock("../plugins/capability-provider-runtime.js", () => ({
  resolvePluginCapabilityProvider: vi.fn(() => undefined),
}));

const resolveProviders = vi.mocked(resolvePluginCapabilityProvider);

describe("media-understanding capability registry", () => {
  beforeEach(() => {
    resolveProviders.mockReturnValue(undefined);
  });

  it("auto-registers config providers with image-capable models", () => {
    const registry = buildMediaUnderstandingCapabilityRegistry({
      tools: { media: { models: [{ provider: "glm" }, { provider: "textOnly" }] } },
      models: {
        providers: {
          glm: {
            models: [{ id: "glm-4.6v", input: ["text", "image"] }],
          },
          textOnly: {
            models: [{ id: "text-model", input: ["text"] }],
          },
        },
      },
    } as never);

    expect(registry.get("glm")?.capabilities).toEqual(["image"]);
    expect(registry.get("textOnly")).toBeUndefined();
  });

  it("keeps plugin-owned capabilities ahead of config auto-registration", () => {
    resolveProviders.mockReturnValue({ id: "google", capabilities: ["audio"] });

    const registry = buildMediaUnderstandingCapabilityRegistry({
      tools: { media: { models: [{ provider: "google" }] } },
      models: {
        providers: {
          google: {
            models: [{ id: "custom-gemini", input: ["text", "image"] }],
          },
        },
      },
    } as never);

    expect(registry.get("google")?.capabilities).toEqual(["audio"]);
  });
});
