import { describe, expect, it } from "vitest";
import { readResponseTextSnippet } from "./response-snippet.js";

describe("readResponseTextSnippet", () => {
  it("does not wait for another chunk after reading the byte cap exactly", async () => {
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("abcd"));
      },
      cancel() {
        canceled = true;
      },
    });

    await expect(
      readResponseTextSnippet(new Response(stream), { maxBytes: 4, maxChars: 100 }),
    ).resolves.toBe("abcd... [truncated]");
    expect(canceled).toBe(true);
  });
});
