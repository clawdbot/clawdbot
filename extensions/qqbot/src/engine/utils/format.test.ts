import { describe, expect, it } from "vitest";
import { formatErrorMessage, formatDuration } from "./format.js";

describe("engine/utils/format", () => {
  describe("formatErrorMessage", () => {
    it("extracts message from Error instances", () => {
      expect(formatErrorMessage(new Error("boom"))).toBe("boom");
    });

    it("returns strings as-is", () => {
      expect(formatErrorMessage("plain text")).toBe("plain text");
    });

    it("traverses the .cause chain", () => {
      const inner = new Error("inner");
      const outer = new Error("outer", { cause: inner });
      expect(formatErrorMessage(outer)).toBe("outer | inner");
    });

    it("handles string cause", () => {
      const err = new Error("outer", { cause: "string cause" });
      expect(formatErrorMessage(err)).toBe("outer | string cause");
    });

    it("stringifies numbers", () => {
      expect(formatErrorMessage(42)).toBe("42");
    });

    it("stringifies null", () => {
      expect(formatErrorMessage(null)).toBe("null");
    });

    it("stringifies undefined", () => {
      expect(formatErrorMessage(undefined)).toBe("undefined");
    });

    it("JSON-stringifies plain objects", () => {
      expect(formatErrorMessage({ code: 500 })).toBe('{"code":500}');
    });
  });

  describe("formatDuration", () => {
    it("formats zero", () => {
      expect(formatDuration(0)).toBe("0s");
    });

    it("formats sub-minute durations as seconds", () => {
      expect(formatDuration(45_000)).toBe("45s");
    });

    it("formats exactly 60 seconds as 1m", () => {
      expect(formatDuration(60_000)).toBe("1m");
    });

    it("formats mixed minutes and seconds", () => {
      expect(formatDuration(90_000)).toBe("1m 30s");
    });

    it("formats exact minutes without trailing seconds", () => {
      expect(formatDuration(300_000)).toBe("5m");
    });

    it("rounds sub-second values", () => {
      expect(formatDuration(1_499)).toBe("1s");
      expect(formatDuration(1_500)).toBe("2s");
    });
  });
});
