// Covers the bounded JSON nesting contract for config and config-adjacent inputs.
import { describe, expect, it, vi } from "vitest";
import { parseConfigJson5 } from "./io.read-helpers.js";
import {
  assertBoundedJsonNesting,
  assertBoundedRawJsonNesting,
  ConfigNestingDepthError,
  formatConfigNestingDepthMessage,
  MAX_CONFIG_JSON_NESTING_DEPTH,
  parseJsonWithNestingGuard,
} from "./nesting-limit.js";

function buildDeepArray(depth: number): unknown {
  let value: unknown = 0;
  for (let i = 0; i < depth; i += 1) {
    value = [value];
  }
  return value;
}

describe("assertBoundedRawJsonNesting", () => {
  it("accepts shallow bracket nesting and ignores brackets inside strings", () => {
    expect(() => assertBoundedRawJsonNesting('{"a": "["}', "Test JSON")).not.toThrow();
    expect(() => assertBoundedRawJsonNesting('{"a": "[{[\\"', "Test JSON")).not.toThrow();
    expect(() => assertBoundedRawJsonNesting('{"a": "x]"}', "Test JSON")).not.toThrow();
    expect(() => assertBoundedRawJsonNesting("[1, [2, [3]]]", "Test JSON")).not.toThrow();
    expect(() =>
      assertBoundedRawJsonNesting('{"a": {"b": [1, {"c": "]"}]}}', "Test JSON"),
    ).not.toThrow();
    expect(() => assertBoundedRawJsonNesting('"plain string [ ]"', "Test JSON")).not.toThrow();
    expect(() => assertBoundedRawJsonNesting("'single quoted [ ]'", "Test JSON")).not.toThrow();
    expect(() =>
      assertBoundedRawJsonNesting(String.raw`{\"escaped\": \"a\\\"b[\"}`, "Test JSON"),
    ).not.toThrow();
  });

  it("ignores bracket-like characters that only appear inside string values", () => {
    // Over 512 brackets, all inside a quoted string: the raw scan must not
    // count them, or this would be misreported as an over-limit document.
    const bracketSoup = `{"a": "${"[".repeat(2_000)}${"]".repeat(2_000)}"}`;
    expect(() => assertBoundedRawJsonNesting(bracketSoup, "Test JSON")).not.toThrow();
  });

  it("ignores JSON5 line and block comments when measuring nesting depth", () => {
    // 513 brackets inside comments must not count toward the limit: the
    // document below is a legal, shallow JSON5 config.
    const manyOpen = "[".repeat(513);
    const manyClose = "]".repeat(513);
    const withLineComment = `{\n  // ${manyOpen}${manyClose}\n  "a": 1\n}`;
    expect(() => assertBoundedRawJsonNesting(withLineComment, "Test JSON")).not.toThrow();
    const withBlockComment = `{\n  /* ${manyOpen}${manyClose} */\n  "a": 1\n}`;
    expect(() => assertBoundedRawJsonNesting(withBlockComment, "Test JSON")).not.toThrow();
    const blockWithInnerStars = `{ /* ${manyOpen} * ${manyClose} */ "a": 1 }`;
    expect(() => assertBoundedRawJsonNesting(blockWithInnerStars, "Test JSON")).not.toThrow();
    const trailingLineComment = `{"a": 1} // ${manyOpen}`;
    expect(() => assertBoundedRawJsonNesting(trailingLineComment, "Test JSON")).not.toThrow();
    // Comment markers inside strings are string content, not comments.
    expect(() =>
      assertBoundedRawJsonNesting(`{"u": "https://example.com/[x]//[y]", "a": 1}`, "Test JSON"),
    ).not.toThrow();
    // An unterminated block comment must terminate the scan, not hang or leak.
    expect(() =>
      assertBoundedRawJsonNesting(`{"a": 1} /* ${manyOpen}${manyClose}`, "Test JSON"),
    ).not.toThrow();
  });

  it("still measures real nesting that appears after a comment", () => {
    // The comment brackets are skipped; the 514 real brackets are counted.
    const raw = `/* ${"]".repeat(10)} */ ${"[".repeat(514)}${"]".repeat(514)}`;
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      formatConfigNestingDepthMessage("Test JSON", 514),
    );
  });

  it("rejects pathological 100k-deep input iteratively with an exact measured depth", () => {
    const raw = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      formatConfigNestingDepthMessage("Test JSON", 100_000),
    );
  });
});

describe("assertBoundedJsonNesting", () => {
  it("accepts shallow parsed structures iteratively", () => {
    expect(() => assertBoundedJsonNesting([[[0]]], "Test JSON")).not.toThrow();
    expect(() => assertBoundedJsonNesting({ a: { b: [1, { c: 2 }] } }, "Test JSON")).not.toThrow();
    expect(() => assertBoundedJsonNesting("leaf", "Test JSON")).not.toThrow();
  });

  it("rejects pathological 100k-deep parsed values iteratively with an exact measured depth", () => {
    expect(() => assertBoundedJsonNesting(buildDeepArray(100_000), "Test JSON")).toThrowError(
      formatConfigNestingDepthMessage("Test JSON", 100_000),
    );
  });
});

describe("nesting depth assertions", () => {
  it("accepts raw and parsed values at the supported maximum", () => {
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH - 1), "Test JSON"),
    ).not.toThrow();
    expect(() =>
      assertBoundedRawJsonNesting(
        "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH) + "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH),
        "Test JSON",
      ),
    ).not.toThrow();
  });

  it("rejects parsed values past the supported maximum with a wrapped error", () => {
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH + 1), "Test JSON"),
    ).toThrowError(ConfigNestingDepthError);
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH + 1), "Test JSON"),
    ).toThrow(/maximum supported nesting depth/);
  });

  it("rejects raw text one level past the maximum with an exact measured depth", () => {
    const raw =
      "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1) + "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1);
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      formatConfigNestingDepthMessage("Test JSON", MAX_CONFIG_JSON_NESTING_DEPTH + 1),
    );
  });

  it("measures the parsed boundary with the same structural counting as the raw scan", () => {
    // 512 structural containers are the advertised maximum: the same document
    // must pass both the raw scan and the post-parse assertion, and one more
    // container must fail both, so the limit has one observable meaning.
    const boundary =
      "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH) + "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH);
    expect(() =>
      parseJsonWithNestingGuard(boundary, "Test JSON", (text) => JSON.parse(text)),
    ).not.toThrow();
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH), "Test JSON"),
    ).not.toThrow();
    expect(() =>
      assertBoundedJsonNesting(buildDeepArray(MAX_CONFIG_JSON_NESTING_DEPTH + 1), "Test JSON"),
    ).toThrowError(ConfigNestingDepthError);
  });

  it("rejects deep raw text before any parser runs", () => {
    const raw = "[".repeat(100_000) + "]".repeat(100_000);
    expect(() => assertBoundedRawJsonNesting(raw, "Test JSON")).toThrowError(
      ConfigNestingDepthError,
    );
  });
});

describe("parseConfigJson5", () => {
  it("rejects deeply-nested config text as a clean parse failure", () => {
    const deepRaw = "[".repeat(100_000) + "]".repeat(100_000);
    const result = parseConfigJson5(deepRaw);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("nesting depth");
      expect(result.error).toContain(String(MAX_CONFIG_JSON_NESTING_DEPTH));
    }
  });

  it("accepts ordinary config text unchanged", () => {
    expect(parseConfigJson5(`{"gateway": {"mode": "local"}}`)).toEqual({
      ok: true,
      parsed: { gateway: { mode: "local" } },
    });
  });
});

describe("parseJsonWithNestingGuard", () => {
  it("parses shallow input and passes it back unchanged", () => {
    const parse = vi.fn((text: string) => JSON.parse(text));
    expect(parseJsonWithNestingGuard('{"a": [1, 2]}', "Test JSON", parse)).toEqual({
      a: [1, 2],
    });
    expect(parse).toHaveBeenCalledTimes(1);
  });

  it("asserts raw nesting before the parser runs, so over-limit input never reaches it", () => {
    const parse = vi.fn((text: string) => JSON.parse(text));
    const raw =
      "[".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1) + "]".repeat(MAX_CONFIG_JSON_NESTING_DEPTH + 1);
    expect(() => parseJsonWithNestingGuard(raw, "Test JSON", parse)).toThrowError(
      ConfigNestingDepthError,
    );
    expect(parse).not.toHaveBeenCalled();
  });

  it("re-asserts nesting on the parsed value for in-process parser quirks", () => {
    // A parser that inflates shallow raw text into a deep value still trips the guard.
    const parse = () => {
      let value: unknown = 0;
      for (let i = 0; i < MAX_CONFIG_JSON_NESTING_DEPTH + 2; i += 1) {
        value = [value];
      }
      return value;
    };
    expect(() => parseJsonWithNestingGuard("{}", "Test JSON", parse)).toThrowError(
      ConfigNestingDepthError,
    );
  });
});
