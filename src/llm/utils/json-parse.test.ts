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
    ['{"path":"C:\\new\\file"}', "C:\\new\\file"],
    ['{"path":"D:\\reports\\q"}', "D:\\reports\\q"],
    ['{"path":"C:\\users\\bob"}', "C:\\users\\bob"],
  ])("preserves unescaped Windows path control-letter segments: %s", (input, expected) => {
    expect(parseStreamingJson(input)).toEqual({ path: expected });
    expect(parseJsonWithRepair(input)).toEqual({ path: expected });
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

describe("json-parse repairJson Windows-path false positives (issue #93139)", () => {
  it.each([
    ["if x", '{"command": "if x:\\n    pass"}', "if x:\n    pass"],
    [
      "as f",
      '{"command": "with open(path) as f:\\n    read(f)"}',
      "with open(path) as f:\n    read(f)",
    ],
    ["in d", '{"command": "if x in d:\\n    pass"}', "if x in d:\n    pass"],
    ["match x", '{"command": "match x:\\n    pass"}', "match x:\n    pass"],
    ["case x", '{"command": "case x:\\n    pass"}', "case x:\n    pass"],
  ])("preserves real newlines after code keyword candidates: %s", (_name, input, expected) => {
    expect(parseJsonWithRepair(input)).toEqual({ command: expected });
    expect(parseStreamingJson(input)).toEqual({ command: expected });
  });

  it("preserves the reported if r code candidate", () => {
    const input = '{"command": "r = re.match(p, s)\\nif r:\\n    print(r)"}';
    const expected = { command: "r = re.match(p, s)\nif r:\n    print(r)" };
    expect(parseJsonWithRepair(input)).toEqual(expected);
    expect(parseStreamingJson(input)).toEqual(expected);
  });

  it("preserves uppercase batch paths after guarded keywords", () => {
    const input = '{"command":"if C:\\new==C:\\temp echo same"}';
    const expected = { command: "if C:\\new==C:\\temp echo same" };
    expect(parseJsonWithRepair(input)).toEqual(expected);
    expect(parseStreamingJson(input)).toEqual(expected);
  });

  it.each([
    ["comma", '{"value":"if,C:\\new"}', "if,C:\\new"],
    ["parentheses", '{"value":"(C:\\new)"}', "(C:\\new)"],
    ["braces", '{"value":"{C:\\new}"}', "{C:\\new}"],
  ])("preserves punctuation-wrapped Windows paths: %s", (_name, input, expected) => {
    expect(parseJsonWithRepair(input)).toEqual({ value: expected });
    expect(parseStreamingJson(input)).toEqual({ value: expected });
  });

  it("preserves a malformed Windows path after code-like command text", () => {
    const input = '{"cmd": "python -c \'x\'; C:\\new\\file.txt"}';
    expect(repairJson(input)).not.toBe(input);
    expect(parseJsonWithRepair(input)).toEqual({
      cmd: "python -c 'x'; C:\\new\\file.txt",
    });
    expect(parseStreamingJson(input)).toEqual({
      cmd: "python -c 'x'; C:\\new\\file.txt",
    });
  });
});
