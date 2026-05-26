import { describe, expect, it } from "vitest";
import { asBoolean, parseBooleanValue } from "./boolean.js";
import { splitShellArgs } from "./shell-argv.js";

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
    expect(splitShellArgs(`qmd --foo "bar baz"`)).toEqual(["qmd", "--foo", "bar baz"]);
    expect(splitShellArgs(`qmd --foo 'bar baz'`)).toEqual(["qmd", "--foo", "bar baz"]);
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
