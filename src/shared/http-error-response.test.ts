import { describe, expect, it } from "vitest";
import { extractHttpResponseBody } from "./http-error-response.js";

describe("extractHttpResponseBody", () => {
  it.each([
    {
      name: "direct HTML body",
      rest: "<html><body>down</body></html>",
      expected: "<html><body>down</body></html>",
    },
    {
      name: "HTTP reason phrase before HTML",
      rest: "Bad Gateway\n\n<!doctype html><html><body>down</body></html>",
      expected: "<!doctype html><html><body>down</body></html>",
    },
    {
      name: "non-HTML status text",
      rest: "Service Unavailable",
      expected: "Service Unavailable",
    },
  ])("extracts $name", ({ rest, expected }) => {
    expect(extractHttpResponseBody({ code: 502, rest })).toEqual({
      code: 502,
      body: expected,
    });
  });

  it("preserves a missing status", () => {
    expect(extractHttpResponseBody(null)).toBeNull();
  });
});
