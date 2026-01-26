import { describe, expect, it } from "vitest";

import { isSenderAllowed } from "./monitor.js";

describe("isSenderAllowed", () => {
  it("matches allowlist entries with users/<email>", () => {
    expect(
      isSenderAllowed("users/123", "Jane@Example.com", ["users/jane@example.com"]),
    ).toBe(true);
  });

  it("matches allowlist entries with raw email", () => {
    expect(isSenderAllowed("users/123", "Jane@Example.com", ["jane@example.com"])).toBe(
      true,
    );
  });

  it("still matches user id entries", () => {
    expect(isSenderAllowed("users/abc", "jane@example.com", ["users/abc"])).toBe(true);
  });

  it("rejects non-matching emails", () => {
    expect(isSenderAllowed("users/123", "jane@example.com", ["users/other@example.com"])).toBe(
      false,
    );
  });
});
