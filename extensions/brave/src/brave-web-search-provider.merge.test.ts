// Brave tests cover brave web search provider.merge plugin behavior.
import { describe, expect, it, vi } from "vitest";

describe("brave web search config merge", () => {
  it("keeps plugin webSearch runtime-only after merging it for the tool", async () => {
    vi.resetModules();
    const searchConfigs: Array<Record<string, unknown> | undefined> = [];
    const executeBraveSearch = vi.fn(
      async (_args: unknown, searchConfig?: Record<string, unknown>) => {
        searchConfigs.push(searchConfig);
        return { results: [] };
      },
    );
    vi.doMock("./brave-web-search-provider.runtime.js", () => ({ executeBraveSearch }));

    try {
      const { createBraveWebSearchProvider } = await import("./brave-web-search-provider.js");
      const provider = createBraveWebSearchProvider();
      const tool = provider.createTool({
        config: {
          plugins: {
            entries: {
              brave: {
                config: {
                  webSearch: {
                    apiKey: "brave-test-key",
                    mode: "llm-context",
                  },
                },
              },
            },
          },
        },
        searchConfig: { provider: "brave" },
      });

      await tool?.execute({ query: "OpenClaw docs" });

      const [searchConfig] = searchConfigs;
      expect(searchConfig?.brave).toEqual({
        apiKey: "brave-test-key",
        mode: "llm-context",
      });
      expect(searchConfig?.apiKey).toBe("brave-test-key");
      expect(Object.keys(searchConfig ?? {})).toEqual(["provider", "apiKey"]);
      expect(Object.getOwnPropertyDescriptor(searchConfig ?? {}, "brave")?.enumerable).toBe(false);
    } finally {
      vi.doUnmock("./brave-web-search-provider.runtime.js");
      vi.resetModules();
    }
  });
});
