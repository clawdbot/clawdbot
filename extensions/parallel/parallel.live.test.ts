import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { createParallelWebSearchProvider } from "./src/parallel-web-search-provider.js";

const PARALLEL_API_KEY = process.env.PARALLEL_API_KEY?.trim() ?? "";
const describeLive = isLiveTestEnabled() && PARALLEL_API_KEY.length > 0 ? describe : describe.skip;

const PARALLEL_LIVE_TIMEOUT_MS = 120_000;

describeLive("parallel plugin live", () => {
  it(
    "runs Parallel web search through the provider tool",
    async () => {
      const provider = createParallelWebSearchProvider();
      const tool = provider.createTool?.({
        config: {},
        searchConfig: { parallel: { apiKey: PARALLEL_API_KEY } },
      });
      if (!tool) {
        throw new Error("Expected Parallel provider tool");
      }

      const result = (await tool.execute({
        objective:
          "Find the OpenClaw GitHub repository and recent project activity for a quick smoke test.",
        search_queries: ["openclaw github repository", "openclaw release notes"],
        count: 3,
        client_model: "claude-opus-4-7",
      })) as {
        provider?: string;
        count?: number;
        results?: Array<{ url?: string; title?: string }>;
        sessionId?: string;
      };

      expect(result.provider).toBe("parallel");
      expect(typeof result.count).toBe("number");
      expect(Array.isArray(result.results)).toBe(true);
      expect((result.results ?? []).length).toBeGreaterThan(0);
      const first = result.results?.[0];
      expect((first?.url ?? "").startsWith("http")).toBe(true);
      expect(typeof result.sessionId).toBe("string");
    },
    PARALLEL_LIVE_TIMEOUT_MS,
  );
});
