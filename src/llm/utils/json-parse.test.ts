import { parseJsonWithRepair, parseStreamingJson, repairJson } from "@openclaw/ai/internal/runtime";
// JSON parse tests cover tolerant parsing of partial model JSON output.
import { describe, expect, it } from "vitest";

describe("json-parse repairJson invalid \\u escapes", () => {
  it("repairs a \\u not followed by four hex digits so the result parses", () => {
    // JS string is: {"path":"C:\users"} — a model emitting an unescaped Windows path.
    const broken = '{"path":"C:\\users"}';
    expect(() => JSON.parse(repairJson(broken))).not.toThrow();
    expect(parseJsonWithRepair(broken)).toEqual({ path: "C:\\users" });
  });

  it("preserves valid \\uXXXX escapes", () => {
    expect(parseJsonWithRepair('{"e":"\\u0041"}')).toEqual({ e: "A" });
  });

  it.each([
    ['{"path":"C:\\bin\\app.exe"}', "C:\\bin\\app.exe"],
    ['{"path":"C:\\temp\\x"}', "C:\\temp\\x"],
    ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
    ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
  ])("preserves unescaped Windows path control-letter segments: %s", (input, expected) => {
    expect(parseStreamingJson(input)).toEqual({ path: expected });
    expect(parseJsonWithRepair(input)).toEqual({ path: expected });
  });

  it("honors already-valid JSON control escapes after a `<letter>:` (fixes #14452)", () => {
    // `{"path":"C:\new\file"}` is *valid* JSON: \n and \f are legal escapes, so
    // it must parse to real control characters, not be re-interpreted as a
    // Windows path. A `<letter>:` followed by a valid escape is byte-identical
    // to the Python `as f:\n` idiom, so re-corrupting it would reintroduce
    // #14452. A model that means the literal path must escape the backslashes
    // ("C:\\new\\file"), which stays valid JSON and round-trips unchanged.
    // Expected value written with explicit escapes: drive letter, LF, "ew", FF, "ile".
    const expected = "C:\u000Aew\u000Cile";
    expect(parseStreamingJson('{"path":"C:\\new\\file"}')).toEqual({ path: expected });
    expect(parseJsonWithRepair('{"path":"C:\\new\\file"}')).toEqual({ path: expected });
  });

  it("preserves legitimate JSON control escapes outside Windows paths", () => {
    expect(parseJsonWithRepair('{"message":"line\\nnext\\ttabbed"}')).toEqual({
      message: "line\nnext\ttabbed",
    });
  });

  it("recovers streaming tool-call arguments instead of dropping them to {}", () => {
    // LaTeX-style \u (\underline) is a valid string value the model may emit in args.
    const args = '{"cmd":"\\underline{x}"}';
    expect(parseStreamingJson(args)).toEqual({ cmd: "\\underline{x}" });
  });

  it.each(["null", "[]", '"text"', "1", "true"])(
    "returns an empty object for non-object streaming JSON: %s",
    (input) => {
      expect(parseStreamingJson(input)).toEqual({});
    },
  );
});
