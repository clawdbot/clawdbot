// Misc utility tests cover small shared helper behavior.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { asBoolean, parseBooleanValue } from "./boolean.js";
import { splitCommandArgs, splitShellArgs } from "./shell-argv.js";
import { safeParseJsonWithSchema, safeParseWithSchema } from "./zod-parse.js";

describe("asBoolean", () => {
  it("accepts booleans only", () => {
    expect(asBoolean(true)).toBe(true);
    expect(asBoolean(false)).toBe(false);
    expect(asBoolean("true")).toBeUndefined();
    expect(asBoolean(1)).toBeUndefined();
  });
});

describe("parseBooleanValue", () => {
  it("handles boolean inputs", () => {
    expect(parseBooleanValue(true)).toBe(true);
    expect(parseBooleanValue(false)).toBe(false);
  });

  it("parses default truthy/falsy strings", () => {
    expect(parseBooleanValue("true")).toBe(true);
    expect(parseBooleanValue("1")).toBe(true);
    expect(parseBooleanValue("yes")).toBe(true);
    expect(parseBooleanValue("on")).toBe(true);
    expect(parseBooleanValue("false")).toBe(false);
    expect(parseBooleanValue("0")).toBe(false);
    expect(parseBooleanValue("no")).toBe(false);
    expect(parseBooleanValue("off")).toBe(false);
  });

  it("respects custom truthy/falsy lists", () => {
    expect(
      parseBooleanValue("on", {
        truthy: ["true"],
        falsy: ["false"],
      }),
    ).toBeUndefined();
    expect(
      parseBooleanValue("yes", {
        truthy: ["yes"],
        falsy: ["no"],
      }),
    ).toBe(true);
  });

  it("returns undefined for unsupported values", () => {
    expect(parseBooleanValue("")).toBeUndefined();
    expect(parseBooleanValue("maybe")).toBeUndefined();
    expect(parseBooleanValue(1)).toBeUndefined();
  });
});

describe("splitShellArgs", () => {
  it("splits whitespace and respects quotes", () => {
    expect(splitShellArgs(`search --foo "bar baz"`)).toEqual(["search", "--foo", "bar baz"]);
    expect(splitShellArgs(`search --foo 'bar baz'`)).toEqual(["search", "--foo", "bar baz"]);
  });

  it("supports backslash escapes inside double quotes", () => {
    expect(splitShellArgs(String.raw`echo "a\"b"`)).toEqual(["echo", `a"b`]);
    expect(splitShellArgs(String.raw`echo "\$HOME"`)).toEqual(["echo", "$HOME"]);
  });

  it("returns null for unterminated quotes", () => {
    expect(splitShellArgs(`echo "oops`)).toBeNull();
    expect(splitShellArgs(`echo 'oops`)).toBeNull();
  });

  it("stops at unquoted shell comments but keeps quoted hashes literal", () => {
    expect(splitShellArgs(`echo hi # comment && whoami`)).toEqual(["echo", "hi"]);
    expect(splitShellArgs(`echo "hi # still-literal"`)).toEqual(["echo", "hi # still-literal"]);
    expect(splitShellArgs(`echo hi#tail`)).toEqual(["echo", "hi#tail"]);
  });
});

describe("splitCommandArgs", () => {
  it.each([
    {
      input: String.raw`program some\path 'a"b' #literal`,
      expected: ["program", String.raw`some\path`, 'a"b', "#literal"],
    },
    {
      input: String.raw`program "C:\some path\file.py" \\server\share\ #literal`,
      expected: ["program", String.raw`C:\some path\file.py`, "\\\\server\\share\\", "#literal"],
    },
    { input: 'program "unfinished', expected: null },
    { input: "program 'unfinished", expected: null },
    { input: "program unfinished\\", expected: ["program", "unfinished\\"] },
  ])("parses quote-only process arguments: $input", ({ input, expected }) => {
    expect(splitCommandArgs(input)).toEqual(expected);
  });

  it.each(['program "unfinished', "program 'unfinished"])(
    "allows unfinished quotes when requested: %s",
    (raw) => {
      expect(splitCommandArgs(raw, { allowUnclosedQuotes: true })).toEqual([
        "program",
        "unfinished",
      ]);
    },
  );
});

describe("zod parse helpers", () => {
  const schema = z.object({ name: z.string() });

  it("returns parsed data for schema-valid values", () => {
    expect(safeParseWithSchema(schema, { name: "Ada" })).toEqual({ name: "Ada" });
    expect(safeParseJsonWithSchema(schema, `{"name":"Ada"}`)).toEqual({ name: "Ada" });
  });

  it("returns null for schema failures or invalid JSON", () => {
    expect(safeParseWithSchema(schema, { name: 1 })).toBeNull();
    expect(safeParseJsonWithSchema(schema, `{"name":1}`)).toBeNull();
    expect(safeParseJsonWithSchema(schema, `{`)).toBeNull();
  });
});
