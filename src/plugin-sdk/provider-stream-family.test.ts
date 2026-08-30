import { describe, expect, it, vi } from "vitest";

const COMPATIBILITY_EXPORT_NAMES = [
  "GOOGLE_THINKING_STREAM_HOOKS",
  "KILOCODE_THINKING_STREAM_HOOKS",
  "MINIMAX_FAST_MODE_STREAM_HOOKS",
  "MOONSHOT_THINKING_STREAM_HOOKS",
  "OPENAI_RESPONSES_STREAM_HOOKS",
  "OPENROUTER_THINKING_STREAM_HOOKS",
  "TOOL_STREAM_DEFAULT_ON_HOOKS",
] as const;

describe("provider-stream-family compatibility exports", () => {
  it("constructs provider stream hooks without loading native search or transport runtime", async () => {
    vi.doMock("../agents/codex-native-web-search-core.js", () => {
      throw new Error("Stream hook registration loaded native search runtime");
    });
    vi.doMock("../agents/openai-transport-stream.js", () => {
      throw new Error("Stream hook registration loaded native transport runtime");
    });
    vi.resetModules();
    try {
      const providerStreamFamily = await import("./provider-stream-family.js");
      const providerStream = await import("./provider-stream.js");

      expect(providerStreamFamily.resolveOpenAIServiceTier({ serviceTier: "flex" })).toBe("flex");
      for (const family of ["openrouter-thinking", "openai-responses-defaults"] as const) {
        const hooks = providerStream.buildProviderStreamFamilyHooks(family);
        expect(hooks.wrapStreamFn?.({ provider: "fixture", modelId: "model" })).toBeTypeOf(
          "function",
        );
      }
    } finally {
      vi.doUnmock("../agents/codex-native-web-search-core.js");
      vi.doUnmock("../agents/openai-transport-stream.js");
      vi.resetModules();
    }
  });

  it.each(COMPATIBILITY_EXPORT_NAMES)("preserves the shipped %s shortcut", async (exportName) => {
    const providerStreamFamily = await import("./provider-stream-family.js");
    const providerStream = await import("./provider-stream.js");
    const value = providerStreamFamily[exportName];

    expect(value).toBeDefined();
    expect(value).toHaveProperty("wrapStreamFn");
    expect(value).toBe(providerStream[exportName]);
  });
});
