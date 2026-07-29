// Session id tests cover session id parsing and generation helpers.
import { describe, expect, it } from "vitest";
import { SESSION_ID_RE, looksLikeSessionId } from "./session-id.js";

describe("session-id", () => {
  it("matches canonical UUID session ids", () => {
    expect(SESSION_ID_RE.test("123e4567-e89b-12d3-a456-426614174000")).toBe(true);
    expect(looksLikeSessionId(" 123e4567-e89b-12d3-a456-426614174000 ")).toBe(true);
  });

  it("rejects non-session-id values", () => {
    expect(SESSION_ID_RE.test("agent:main:main")).toBe(false);
    expect(looksLikeSessionId("session-label")).toBe(false);
  });
});
