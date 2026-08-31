import { describe, expect, it } from "vitest";
import { parseJsonWithRepair, parseStreamingJson, repairJson } from "./json-parse.js";

describe("parseJsonWithRepair", () => {
  it("preserves a valid \\n escape after a `<letter>:` token (Python `as f:`)", () => {
    // This is exactly how a model encodes a multi-line script argument: the
    // newline is a valid JSON `\n` escape. Regression for the bug where
    // repairJson's Windows-path heuristic doubled the backslash, turning the
    // newline into a literal backslash-n and breaking exec'd scripts.
    const command = 'with open(path, "w") as f:\n    f.write(content)\nprint("done")';
    const json = JSON.stringify({ command });

    const parsed = parseJsonWithRepair(json) as { command: string };

    expect(parsed.command).toBe(command);
    expect(parsed.command).toContain("\n");
    expect(parsed.command).not.toContain("\\n");
  });

  it("does not mutate other single-letter-colon idioms (`if x:`)", () => {
    const command = "if x:\n    return 1";
    expect((parseJsonWithRepair(JSON.stringify({ command })) as { command: string }).command).toBe(
      command,
    );
  });

  it("still repairs genuinely malformed JSON (raw control char in string)", () => {
    // A raw newline byte inside a string is invalid JSON; repair should escape
    // it and recover the intended value.
    const malformed = '{"text":"line1\nline2"}';
    const parsed = parseJsonWithRepair(malformed) as { text: string };
    expect(parsed.text).toBe("line1\nline2");
  });

  it("still doubles a lone backslash before an invalid escape", () => {
    // `\x` is not a valid JSON escape; repair should treat it as a literal
    // backslash so the value round-trips.
    const malformed = '{"path":"a\\xb"}';
    const parsed = parseJsonWithRepair(malformed) as { path: string };
    expect(parsed.path).toBe("a\\xb");
  });
});

describe("parseStreamingJson", () => {
  it("returns a real newline for the `as f:` idiom on a complete object", () => {
    const command = 'with open(p, "w") as f:\n    f.write(x)';
    const result = parseStreamingJson(JSON.stringify({ command })) as { command: string };
    expect(result.command).toBe(command);
    expect(result.command).not.toContain("\\n");
  });

  it("returns {} for empty/whitespace input", () => {
    expect(parseStreamingJson("")).toEqual({});
    expect(parseStreamingJson("   ")).toEqual({});
  });
});

describe("repairJson", () => {
  it("escapes a raw control character inside a string", () => {
    expect(repairJson('{"a":"x\ny"}')).toBe('{"a":"x\\ny"}');
  });
});
