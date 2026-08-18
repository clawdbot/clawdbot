import { describe, expect, it, vi } from "vitest";

const warnSpy = vi.hoisted(() => vi.fn());

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: warnSpy }),
}));

import { readResponseBodySnippet } from "./http-error-body.js";

function streamResponse(text: string): Response {
  return new Response(new Blob([new TextEncoder().encode(text)]).stream());
}

describe("readResponseBodySnippet", () => {
  it("warns when a readable response fails while reading", async () => {
    const response = new Response(
      new ReadableStream<Uint8Array>({
        pull() {
          throw new Error("stream exploded");
        },
      }),
    );

    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 100,
    });

    expect(result).toBe("");
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("Failed to read response body snippet: stream exploded"),
    );
  });

  it("does not use whole-body methods for body-less responses", async () => {
    const text = vi.fn(async () => {
      throw new Error("text() should not be called for snippets");
    });
    const arrayBuffer = vi.fn(async () => {
      throw new Error("arrayBuffer() should not be called for snippets");
    });
    const response = { body: null, text, arrayBuffer } as unknown as Response;

    const result = await readResponseBodySnippet(response, {
      maxBytes: 3,
      maxChars: 100,
    });

    expect(result).toBe("");
    expect(text).not.toHaveBeenCalled();
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it("stream path still enforces maxBytes", async () => {
    const data = new Uint8Array(500).fill(97);
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(100);
  });

  it("stream path drops partial UTF-8 characters at the byte boundary", async () => {
    const result = await readResponseBodySnippet(streamResponse("ab😀cd"), {
      maxBytes: 3,
      maxChars: 100,
    });

    expect(result).toBe("ab");
  });

  it("stream path still enforces maxChars", async () => {
    const data = new Uint8Array(500).fill(97);
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 200,
      maxChars: 10,
    });
    expect(result.length).toBeLessThanOrEqual(10);
  });

  it.each([
    {
      name: "streamed response within byte limit",
      response: () => streamResponse("a" + "🧃".repeat(10)),
      maxBytes: 1024,
    },
    {
      name: "streamed response truncated by byte limit",
      response: () => streamResponse("a" + "🧃".repeat(10)),
      maxBytes: 30,
    },
  ])("preserves surrogate pairs for $name", async ({ response, maxBytes }) => {
    const result = await readResponseBodySnippet(response(), {
      maxBytes,
      maxChars: 10,
    });

    expect(result).toBe("a" + "🧃".repeat(4));
  });
});
