import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockWarn } = vi.hoisted(() => ({
  mockWarn: vi.fn(),
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({ warn: mockWarn }),
}));

import { readResponseBodySnippet } from "./http-error-body.js";

function bodyLessResponse(text: string): Response {
  return {
    body: null,
    text: async () => text,
  } as unknown as Response;
}

describe("readResponseBodySnippet", () => {
  it("returns full text when under both limits (body-less path)", async () => {
    const text = "short text";
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe(text);
  });

  it("truncates by maxChars when under maxBytes (body-less path)", async () => {
    const text = "abcdefghij";
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 1024,
      maxChars: 5,
    });
    expect(result).toBe("abcde");
  });

  it("truncates by maxBytes in the body-less path", async () => {
    const text = "a".repeat(200);
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 50,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(50);
    expect(result.length).toBeLessThan(text.length);
  });

  it("enforces maxBytes before maxChars in the body-less path", async () => {
    const text = "a".repeat(500);
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 30,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(30);
  });

  it("does not split multi-byte UTF-8 characters at the byte boundary", async () => {
    // U+1F600 (😀) is 4 bytes in UTF-8: F0 9F 98 80
    const text = "ab😀cd";
    // 2 ASCII bytes (ab) + cut before the 4-byte emoji
    const result = await readResponseBodySnippet(bodyLessResponse(text), {
      maxBytes: 3,
      maxChars: 100,
    });
    // With stream:true, incomplete multi-byte sequence is dropped
    expect(result).toBe("ab");
  });

  it("stream path still enforces maxBytes", async () => {
    const data = new Uint8Array(500).fill(97); // 500 'a' bytes
    const response = new Response(new Blob([data]).stream());
    const result = await readResponseBodySnippet(response, {
      maxBytes: 100,
      maxChars: 500,
    });
    const byteLen = new TextEncoder().encode(result).length;
    expect(byteLen).toBeLessThanOrEqual(100);
  });

  it("stream path drops partial UTF-8 characters at the byte boundary", async () => {
    const response = new Response(new Blob([new TextEncoder().encode("ab😀cd")]).stream());
    const result = await readResponseBodySnippet(response, {
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

  it("returns empty string when maxBytes is 0 (body-less path)", async () => {
    const result = await readResponseBodySnippet(bodyLessResponse("some text"), {
      maxBytes: 0,
      maxChars: 100,
    });
    expect(result).toBe("");
  });

  it("returns empty string for empty response body", async () => {
    const result = await readResponseBodySnippet(bodyLessResponse(""), {
      maxBytes: 1024,
      maxChars: 50,
    });
    expect(result).toBe("");
  });

  it.each([
    {
      name: "body-less response under the byte limit",
      response: () => bodyLessResponse("a" + "🦞".repeat(10)),
      maxBytes: 1024,
    },
    {
      name: "body-less response truncated by the byte limit",
      response: () => bodyLessResponse("a" + "🦞".repeat(10)),
      maxBytes: 30,
    },
    {
      name: "streamed response",
      response: () =>
        new Response(new Blob([new TextEncoder().encode("a" + "🦞".repeat(10))]).stream()),
      maxBytes: 1024,
    },
  ])("preserves surrogate pairs for $name", async ({ response, maxBytes }) => {
    const result = await readResponseBodySnippet(response(), {
      maxBytes,
      maxChars: 10,
    });

    expect(result).toBe("a" + "🦞".repeat(4));
  });
});

describe("readResponseBodySnippet error visibility", () => {
  beforeEach(() => {
    mockWarn.mockClear();
  });

  it.each([
    {
      name: "response.text() rejection",
      response: () =>
        ({
          body: null,
          text: async () => {
            throw new Error("body already consumed");
          },
        }) as unknown as Response,
      expectedError: "body already consumed",
    },
    {
      name: "body stream failure",
      response: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("partial"));
              controller.error(new Error("stream aborted"));
            },
          }),
        ),
      expectedError: "stream aborted",
    },
  ])(
    "logs the read error and preserves the empty fallback for $name",
    async ({ response, expectedError }) => {
      const result = await readResponseBodySnippet(response(), {
        maxBytes: 1024,
        maxChars: 50,
      });

      expect(result).toBe("");
      expect(mockWarn).toHaveBeenCalledExactlyOnceWith(
        `Failed to read response body snippet: ${expectedError}`,
      );
    },
  );
});
