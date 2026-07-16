import { describe, expect, it } from "vitest";
import { readBody, resolveTargetIdFromBody, resolveTargetIdFromQuery } from "./agent.shared.js";
import type { BrowserRequest } from "./types.js";

function requestWithBody(body: unknown): BrowserRequest {
  return {
    params: {},
    query: {},
    body,
  };
}

describe("browser route shared helpers", () => {
  describe("readBody", () => {
    it("returns object bodies", () => {
      expect(readBody(requestWithBody({ one: 1 }))).toEqual({ one: 1 });
    });

    it("normalizes non-object bodies to empty object", () => {
      expect(readBody(requestWithBody(null))).toEqual({});
      expect(readBody(requestWithBody("text"))).toEqual({});
      expect(readBody(requestWithBody(["x"]))).toEqual({});
    });
  });

  describe("target id parsing", () => {
    it("extracts and trims targetId from body", () => {
      expect(resolveTargetIdFromBody({ targetId: "  tab-1  " })).toBe("tab-1");
      expect(resolveTargetIdFromBody({ targetId: "   " })).toBeUndefined();
      expect(resolveTargetIdFromBody({ targetId: 123 })).toBeUndefined();
    });

    it("extracts and trims targetId from query", () => {
      expect(resolveTargetIdFromQuery({ targetId: "  tab-2  " })).toBe("tab-2");
      expect(resolveTargetIdFromQuery({ targetId: "" })).toBeUndefined();
      expect(resolveTargetIdFromQuery({ targetId: false })).toBeUndefined();
    });
  });
});
