// Firecrawl Compare tests cover firecrawl compare script behavior.
import { describe, expect, it } from "vitest";
import { testing as firecrawlCompareTesting } from "../../scripts/firecrawl-compare.ts";

const HTML_MAX_BYTES = 5 * 1024 * 1024;

describe("firecrawl-compare", () => {
  it("does not split surrogate pairs when truncating output", () => {
    expect(firecrawlCompareTesting.truncate(`ab🤖cd`, 3)).toBe("ab…");
  });

  it("fetches local HTML under the default byte cap", async () => {
    const result = await firecrawlCompareTesting.fetchHtml(
      "https://example.test/page",
      async () =>
        new Response("<html><body>ok</body></html>", {
          headers: { "content-type": "text/html" },
          status: 200,
        }),
    );

    expect(result).toMatchObject({
      body: "<html><body>ok</body></html>",
      contentType: "text/html",
      ok: true,
      status: 200,
    });
  });

  it("rejects declared local HTML sizes above the default byte cap", async () => {
    await expect(
      firecrawlCompareTesting.fetchHtml(
        "https://example.test/huge",
        async () =>
          new Response("<html></html>", {
            headers: {
              "content-length": String(HTML_MAX_BYTES + 1),
              "content-type": "text/html",
            },
          }),
      ),
    ).rejects.toThrow(`local HTML fetch response body exceeded ${HTML_MAX_BYTES} bytes`);
  });

  it("rejects streamed local HTML above the default byte cap", async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(HTML_MAX_BYTES + 1));
          controller.close();
        },
      }),
      { headers: { "content-type": "text/html" } },
    );

    await expect(
      firecrawlCompareTesting.fetchHtml("https://example.test/stream", async () => response),
    ).rejects.toThrow(`local HTML fetch response body exceeded ${HTML_MAX_BYTES} bytes`);
  });
});
