import { describe, expect, it } from "vitest";
import { resolveRequestUrl } from "./request-url.js";

describe("resolveRequestUrl", () => {
  it.each([
    {
      name: "resolves string input",
      input: "https://example.com/a",
      expected: "https://example.com/a",
    },
    {
      name: "resolves URL input",
      input: new URL("https://example.com/b"),
      expected: "https://example.com/b",
    },
    {
      name: "resolves object input with url field",
      input: { url: "https://example.com/c" } as unknown as RequestInfo,
      expected: "https://example.com/c",
    },
  ])("$name", ({ input, expected }) => {
    expect(resolveRequestUrl(input)).toBe(expected);
  });
});
