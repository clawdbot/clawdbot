// Firecrawl Compare tests cover firecrawl compare script behavior.
import { describe, expect, it } from "vitest";
import { testing as firecrawlCompareTesting } from "../../scripts/firecrawl-compare.ts";

describe("firecrawl-compare", () => {
  it("fetches local HTML under the byte cap", async () => {
    const result = await firecrawlCompareTesting.fetchHtml("https://example.test/page", {
      fetchImpl: (() =>
        Promise.resolve(
          new Response("<html><body>ok</body></html>", {
            headers: { "content-type": "text/html" },
            status: 200,
          }),
        )) as typeof fetch,
      maxBytes: 1024,
    });

    expect(result).toMatchObject({
      body: "<html><body>ok</body></html>",
      contentType: "text/html",
      ok: true,
      status: 200,
    });
  });

  it("rejects local HTML bodies that exceed declared content-length", async () => {
    await expect(
      firecrawlCompareTesting.fetchHtml("https://example.test/huge", {
        fetchImpl: (() =>
          Promise.resolve(
            new Response("<html></html>", {
              headers: { "content-length": "1025", "content-type": "text/html" },
            }),
          )) as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("local HTML fetch response body exceeded 1024 bytes");
  });

  it("rejects local HTML bodies that exceed the stream byte cap", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(1025));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/html" } },
    );

    await expect(
      firecrawlCompareTesting.fetchHtml("https://example.test/stream", {
        fetchImpl: (() => Promise.resolve(response)) as typeof fetch,
        maxBytes: 1024,
      }),
    ).rejects.toThrow("local HTML fetch response body exceeded 1024 bytes");
  });
});
