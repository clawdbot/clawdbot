import { describe, expect, it } from "vitest";
import { MAX_CONFIG_JSON_NESTING_DEPTH, ConfigNestingDepthError } from "./env-substitution.js";
import { assertBoundedRawJsonNesting, assertBoundedJsonNesting } from "./nesting-limit.js";

describe("nesting-limit", () => {
  describe("assertBoundedRawJsonNesting", () => {
    it("allows shallow nesting", () => {
      const shallow = "[".repeat(50) + "]".repeat(50);
      expect(() => assertBoundedRawJsonNesting(shallow)).not.toThrow();
    });

    it("rejects deeply nested arrays", () => {
      const deep = "[".repeat(600) + "]".repeat(600);
      expect(() => assertBoundedRawJsonNesting(deep)).toThrow(ConfigNestingDepthError);
      expect(() => assertBoundedRawJsonNesting(deep)).toThrow(/nesting depth exceeds maximum/);
    });

    it("rejects deeply nested objects", () => {
      const deep = '{"a":'.repeat(600) + "1" + "}".repeat(600);
      expect(() => assertBoundedRawJsonNesting(deep)).toThrow(ConfigNestingDepthError);
    });

    it("handles mixed nesting", () => {
      const mixed = "[".repeat(300) + '{"x":'.repeat(300) + "1" + "}".repeat(300) + "]".repeat(300);
      expect(() => assertBoundedRawJsonNesting(mixed)).toThrow(ConfigNestingDepthError);
    });

    it("allows nesting within the limit", () => {
      const shallow = "[".repeat(100) + "]".repeat(100);
      expect(() => assertBoundedRawJsonNesting(shallow)).not.toThrow();
    });

    it("handles JSON5 comments", () => {
      const withComments = `
        // Line comment
        [
          /* Block comment */
          [
            // Another line comment
            [1, 2, 3]
          ]
        ]
      `;
      expect(() => assertBoundedRawJsonNesting(withComments)).not.toThrow();
    });

    it("handles JSON5 strings with brackets", () => {
      const withString = `["[", "{", "]", "}"]`;
      expect(() => assertBoundedRawJsonNesting(withString)).not.toThrow();
    });

    it("handles escaped characters in strings", () => {
      const withEscapes = `["\\\\", "\\"", "\\"]`;
      expect(() => assertBoundedRawJsonNesting(withEscapes)).not.toThrow();
    });
  });

  describe("assertBoundedJsonNesting", () => {
    it("allows shallow nesting", () => {
      const shallow = JSON.parse("[".repeat(50) + "]".repeat(50));
      expect(() => assertBoundedJsonNesting(shallow)).not.toThrow();
    });

    it("rejects deeply nested arrays", () => {
      const deep = JSON.parse("[".repeat(600) + "]".repeat(600));
      expect(() => assertBoundedJsonNesting(deep)).toThrow(ConfigNestingDepthError);
    });

    it("rejects deeply nested objects", () => {
      const deep = JSON.parse('{"a":'.repeat(600) + "1" + "}".repeat(600));
      expect(() => assertBoundedJsonNesting(deep)).toThrow(ConfigNestingDepthError);
    });

    it("handles mixed nesting", () => {
      const mixed = JSON.parse(
        "[".repeat(300) + '{"x":'.repeat(300) + "1" + "}".repeat(300) + "]".repeat(300),
      );
      expect(() => assertBoundedJsonNesting(mixed)).toThrow(ConfigNestingDepthError);
    });

    it("allows nesting within the limit", () => {
      const shallow = JSON.parse("[".repeat(100) + "]".repeat(100));
      expect(() => assertBoundedJsonNesting(shallow)).not.toThrow();
    });

    it("reports the correct path for arrays", () => {
      const deep = JSON.parse("[[[[[1]]]]]");
      try {
        assertBoundedJsonNesting(deep, 2);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigNestingDepthError);
        expect((err as ConfigNestingDepthError).path).toMatch(/^\[0\]\[0\]\[0\]/);
      }
    });

    it("reports the correct path for objects", () => {
      const deep = JSON.parse('{"a":{"b":{"c":1}}}');
      try {
        assertBoundedJsonNesting(deep, 2);
        expect.fail("should have thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(ConfigNestingDepthError);
        expect((err as ConfigNestingDepthError).path).toMatch(/^a\.b\.c/);
      }
    });
  });

  describe("MAX_CONFIG_JSON_NESTING_DEPTH", () => {
    it("is set to 512", () => {
      expect(MAX_CONFIG_JSON_NESTING_DEPTH).toBe(512);
    });
  });
});
