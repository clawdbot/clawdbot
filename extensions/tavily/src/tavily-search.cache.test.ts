import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTavilyWebSearchProvider } from "./tavily-search-provider.js";
import { createTavilySearchTool } from "./tavily-search-tool.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe.each(["web_search", "tavily_search"] as const)("%s cache TTL", (kind) => {
  it.each([0, 1])(
    "applies the current %s-minute TTL to cached results",
    async (cacheTtlMinutes) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let requests = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        requests += 1;
        return Response.json({
          results: [
            {
              title: `Result ${requests}`,
              url: `https://example.com/${requests}`,
              content: `Body ${requests}`,
            },
          ],
        });
      });
      const search = async (ttl: number) => {
        const searchConfig = { cacheTtlMinutes: ttl };
        const config = {
          tools: { web: { search: searchConfig } },
          plugins: {
            entries: { tavily: { config: { webSearch: { apiKey: "tavily-test-key" } } } },
          },
        };
        const query = `Tavily ${kind} current TTL ${cacheTtlMinutes}`;
        if (kind === "tavily_search") {
          const tool = createTavilySearchTool(createTestPluginApi({ config }));
          return (await tool.execute("cache-ttl", { query })).details as Record<string, unknown>;
        }
        const tool = createTavilyWebSearchProvider().createTool({ config, searchConfig });
        if (!tool) {
          throw new Error("Expected Tavily search tool");
        }
        return await tool.execute({ query });
      };

      const original = await search(15);
      expect(await search(15)).toEqual({ ...original, cached: true });
      expect(fetch).toHaveBeenCalledTimes(1);

      if (cacheTtlMinutes > 0) {
        clock.mockReturnValue(Date.now() + 60_000);
      }
      const fresh = await search(cacheTtlMinutes);
      expect(fresh.cached).toBeUndefined();
      expect(fresh.results).toEqual([expect.objectContaining({ url: "https://example.com/2" })]);
      expect(fetch).toHaveBeenCalledTimes(2);

      if (cacheTtlMinutes === 0) {
        const next = await search(0);
        expect(next.cached).toBeUndefined();
        expect(next.results).toEqual([expect.objectContaining({ url: "https://example.com/3" })]);
        expect(await search(15)).toEqual({ ...original, cached: true });
        expect(fetch).toHaveBeenCalledTimes(3);
      } else {
        expect(await search(1)).toEqual({ ...fresh, cached: true });
        expect(fetch).toHaveBeenCalledTimes(2);
      }
    },
  );
});
