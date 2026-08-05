import {
  parseJsonWithRepair,
  parseStreamingJson,
  recoverMalformedWindowsPath,
  repairJson,
} from "@openclaw/ai/internal/runtime";
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
    expect(
      recoverMalformedWindowsPath((parseStreamingJson(input) as { path: string }).path),
    ).toBe(expected);
    expect(
      recoverMalformedWindowsPath((parseJsonWithRepair(input) as { path: string }).path),
    ).toBe(expected);
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

describe("json-parse streaming content newlines (#114292)", () => {
  it("preserves \\n in content after a Windows-looking prefix", () => {
    const input = '{"content":"go to C:\\\\dir\\nand run"}';
    expect(parseStreamingJson(input)).toEqual({
      content: "go to C:\\dir\nand run",
    });
  });

  it("preserves \\n in unlisted tool arguments such as query", () => {
    const input = '{"query":"C:\\\\dir\\nnext line"}';
    expect(parseStreamingJson(input)).toEqual({
      query: "C:\\dir\nnext line",
    });
  });

  it("preserves \\n inside exec commands", () => {
    const input = '{"command":"cd C:\\\\dir\\nnext line"}';
    expect(parseStreamingJson(input)).toEqual({
      command: "cd C:\\dir\nnext line",
    });
  });

  it("applies malformed Windows path recovery at the tool boundary", () => {
    const paths = parseStreamingJson('{"paths":["C:\\\\new\\\\file"]}') as {
      paths: string[];
    };
    expect(paths.paths.map(recoverMalformedWindowsPath)).toEqual(["C:\\new\\file"]);
  });

  it("recovers malformed Windows paths in image arguments with the boundary helper", () => {
    const args = parseStreamingJson(
      '{"image":"C:\\\\new\\\\file","images":["D:\\\\reports\\\\q"]}',
    ) as { image: string; images: string[] };
    expect(recoverMalformedWindowsPath(args.image)).toBe("C:\\new\\file");
    expect(args.images.map(recoverMalformedWindowsPath)).toEqual(["D:\\reports\\q"]);
  });
});
