import { afterEach, describe, expect, it, vi } from "vitest";
import { createDuckDuckGoWebSearchProvider } from "./ddg-search-provider.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DuckDuckGo provider cache TTL", () => {
  it.each([0, 1])(
    "applies the current %s-minute TTL to cached results",
    async (cacheTtlMinutes) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());
      let requests = 0;
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
        requests += 1;
        return new Response(
          `<a class="result__a" href="https://example.com/${requests}">Result ${requests}</a>`,
          { headers: { "content-type": "text/html" } },
        );
      });
      const search = async (ttl: number) => {
        const searchConfig = { cacheTtlMinutes: ttl };
        const tool = createDuckDuckGoWebSearchProvider().createTool({
          config: { tools: { web: { search: searchConfig } } },
          searchConfig,
        });
        if (!tool) {
          throw new Error("Expected DuckDuckGo search tool");
        }
        return await tool.execute({ query: `DuckDuckGo current TTL ${cacheTtlMinutes}` });
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
