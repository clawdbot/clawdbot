import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import type { WebFetchProviderToolDefinition } from "../../plugin-sdk/provider-web-fetch.js";
import { withFetchPreconnect } from "../../test-utils/fetch-mock.js";
import { createWebFetchTool } from "./web-fetch.js";

const { resolveWebFetchDefinition } = vi.hoisted(() => ({
  resolveWebFetchDefinition: vi.fn(),
}));
vi.mock("../../web-fetch/runtime.js", () => ({ resolveWebFetchDefinition }));
vi.mock("../../web-fetch/content-extractors.runtime.js", () => ({
  extractReadableContent: vi.fn(async () => null),
}));

describe("web_fetch provider cancellation", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resolveWebFetchDefinition.mockReset();
  });

  it.each(["network-error", "http-error", "empty-readability", "disabled-readability"])(
    "rejects late provider success without caching after %s",
    async (fallback) => {
      vi.stubGlobal(
        "fetch",
        withFetchPreconnect(
          vi.fn(async () => {
            if (fallback === "network-error") {
              throw new Error("network failed");
            }
            return new Response("<html><body>Upstream content</body></html>", {
              status: fallback === "http-error" ? 503 : 200,
              headers: { "content-type": "text/html" },
            });
          }),
        ),
      );
      const controller = new AbortController();
      const reason = new Error("parent run cancelled");
      const started = createDeferred();
      const pending = createDeferred<Record<string, unknown>>();
      const execute = vi
        .fn<WebFetchProviderToolDefinition["execute"]>()
        .mockImplementationOnce(async () => {
          started.resolve();
          return pending.promise;
        })
        .mockResolvedValue({ text: "fresh provider body" });
      resolveWebFetchDefinition.mockReturnValue({
        provider: { id: "test-fetch" },
        definition: { execute },
      });
      const tool = createWebFetchTool({
        config: {
          tools: {
            web: {
              fetch: { cacheTtlMinutes: 1, readability: fallback !== "disabled-readability" },
            },
          },
        },
      })!;
      const args = { url: `https://example.com/cancel-provider-${fallback}` };
      const outcome = Promise.allSettled([tool.execute("cancelled", args, controller.signal)]);
      await started.promise;
      controller.abort(reason);
      pending.resolve({ text: "stale provider body" });
      const [cancelled] = await outcome;
      const fresh = await tool.execute("fresh", args);
      const cached = await tool.execute("cached", args);

      // Soft assertions retain both the late-success and cache-poisoning evidence.
      expect.soft(cancelled).toEqual({ status: "rejected", reason });
      expect.soft(fresh.details).not.toHaveProperty("cached");
      expect
        .soft(fresh.details)
        .toMatchObject({ text: expect.stringContaining("fresh provider body") });
      expect.soft(execute).toHaveBeenCalledTimes(2);
      expect
        .soft(execute.mock.calls[0])
        .toEqual([
          { ...args, extractMode: "markdown", maxChars: 20_000 },
          { signal: controller.signal },
        ]);
      expect(cached.details).toMatchObject({
        cached: true,
        text: expect.stringContaining("fresh provider body"),
      });
    },
  );
});
