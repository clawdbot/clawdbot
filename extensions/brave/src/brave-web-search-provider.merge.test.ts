// Brave tests cover brave web search provider.merge plugin behavior.
import { describe, expect, it, vi } from "vitest";
import { createBraveWebSearchProvider } from "./brave-web-search-provider.js";

const runtimeMock = vi.hoisted(() => {
  const searchConfigs: Array<Record<string, unknown> | undefined> = [];
  return {
    searchConfigs,
    executeBraveSearch: vi.fn(async (_args: unknown, searchConfig?: Record<string, unknown>) => {
      searchConfigs.push(searchConfig);
      return { results: [] };
    }),
  };
});

vi.mock("./brave-web-search-provider.runtime.js", () => ({
  executeBraveSearch: runtimeMock.executeBraveSearch,
}));

describe("brave web search config merge", () => {
  it("keeps plugin webSearch runtime-only after merging it for the tool", async () => {
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

    const [searchConfig] = runtimeMock.searchConfigs;
    expect(searchConfig?.brave).toEqual({
      apiKey: "brave-test-key",
      mode: "llm-context",
    });
    expect(searchConfig?.apiKey).toBe("brave-test-key");
    expect(Object.keys(searchConfig ?? {})).toEqual(["provider", "apiKey"]);
    expect(Object.getOwnPropertyDescriptor(searchConfig ?? {}, "brave")?.enumerable).toBe(false);
  });
});
