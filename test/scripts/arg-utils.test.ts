// Arg Utils tests cover arg utils script behavior.
import { describe, expect, it } from "vitest";
import {
  booleanFlag,
  classifyBoundedUnsignedDecimal,
  intFlag,
  isOpenEndedTruthyValue,
  isStrictAffirmativeValue,
  parseFlagArgs,
  parsePermissiveBooleanToken,
  parseStrictBooleanArg,
  readFlagValue,
  stringFlag,
  stringListFlag,
} from "../../scripts/lib/arg-utils.runtime.mjs";

describe("scripts/lib/arg-utils strict scalar grammars", () => {
  it.each([
    { input: "true", expected: true },
    { input: "false", expected: false },
    { input: "", error: "--enabled must be true or false." },
    { input: " ", error: "--enabled must be true or false." },
    { input: " true", error: "--enabled must be true or false." },
    { input: "false ", error: "--enabled must be true or false." },
    { input: "TRUE", error: "--enabled must be true or false." },
    { input: "False", error: "--enabled must be true or false." },
    { input: "1", error: "--enabled must be true or false." },
    { input: "0", error: "--enabled must be true or false." },
    { input: "yes", error: "--enabled must be true or false." },
    { input: true, error: "--enabled must be true or false." },
    { input: 1, error: "--enabled must be true or false." },
  ])("parses strict Boolean token %#", ({ input, expected, error }) => {
    if (error) {
      expect(() => parseStrictBooleanArg(input, "--enabled")).toThrow(error);
      return;
    }
    expect(parseStrictBooleanArg(input, "--enabled")).toBe(expected);
  });

  it.each([
    { input: "0", min: 0, max: 10, expected: { kind: "value", value: 0 } },
    { input: "001", min: 1, max: 10, expected: { kind: "value", value: 1 } },
    { input: "10", min: 0, max: 10, expected: { kind: "value", value: 10 } },
    { input: "0", min: 1, max: 10, expected: { kind: "below" } },
    { input: "11", min: 0, max: 10, expected: { kind: "above" } },
    { input: "9".repeat(400), min: 0, max: 10, expected: { kind: "above" } },
    { input: "", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: " ", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: " 1", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "1 ", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "+1", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "-1", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "1.0", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "1e1", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "0x10", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "0b10", min: 0, max: 10, expected: { kind: "syntax" } },
    { input: "1ms", min: 0, max: 10, expected: { kind: "syntax" } },
  ])("classifies bounded unsigned decimal %#", ({ input, min, max, expected }) => {
    expect(classifyBoundedUnsignedDecimal(input, min, max)).toEqual(expected);
  });
});

describe("scripts/lib/arg-utils permissive Boolean tokens", () => {
  it.each([
    { input: "true", expected: true },
    { input: "1", expected: true },
    { input: "yes", expected: true },
    { input: "on", expected: true },
    { input: "false", expected: false },
    { input: "0", expected: false },
    { input: "no", expected: false },
    { input: "off", expected: false },
    { input: " TRUE ", expected: true },
    { input: " Off ", expected: false },
    { input: "", expected: undefined },
    { input: " ", expected: undefined },
    { input: "enabled", expected: undefined },
    { input: true, expected: undefined },
    { input: 1, expected: undefined },
  ])("parses $input as $expected", ({ input, expected }) => {
    expect(parsePermissiveBooleanToken(input)).toBe(expected);
  });
});

describe("scripts/lib/arg-utils environment Boolean policies", () => {
  it.each([
    { input: undefined, expected: false },
    { input: "", expected: false },
    { input: "  ", expected: false },
    { input: "0", expected: false },
    { input: " FALSE ", expected: false },
    { input: "no", expected: false },
    { input: "off", expected: true },
    { input: "enabled", expected: true },
    { input: "1", expected: true },
  ])("applies open-ended truthiness to $input", ({ input, expected }) => {
    expect(isOpenEndedTruthyValue(input)).toBe(expected);
  });

  it.each([
    { input: undefined, expected: false },
    { input: "", expected: false },
    { input: "0", expected: false },
    { input: "on", expected: false },
    { input: "enabled", expected: false },
    { input: "1", expected: true },
    { input: " TRUE ", expected: true },
    { input: "Yes", expected: true },
  ])("applies strict affirmative truthiness to $input", ({ input, expected }) => {
    expect(isStrictAffirmativeValue(input)).toBe(expected);
  });
});

describe("scripts/lib/arg-utils parseFlagArgs", () => {
  it("uses the last value when a flag is repeated", () => {
    expect(readFlagValue(["-p", "first.json", "-p", "second.json"], "-p")).toBe("second.json");
    expect(
      readFlagValue(
        ["--tsBuildInfoFile=first.tsbuildinfo", "--tsBuildInfoFile", "second.tsbuildinfo"],
        "--tsBuildInfoFile",
      ),
    ).toBe("second.tsbuildinfo");
  });

  it("ignores the conventional option separator by default", () => {
    const parsed = parseFlagArgs(["--", "--limit", "30"], { limit: 10 }, [
      intFlag("--limit", "limit", { min: 1 }),
    ]);

    expect(parsed.limit).toBe(30);
  });

  it("parses inline flag assignments", () => {
    const parsed = parseFlagArgs(
      ["--label=changed-tests", "--limit=30"],
      { label: "", limit: 10 },
      [stringFlag("--label", "label"), intFlag("--limit", "limit", { min: 1 })],
    );

    expect(parsed).toEqual({
      label: "changed-tests",
      limit: 30,
    });
  });

  it("collects repeatable string flags", () => {
    const parsed = parseFlagArgs(["--match", "alpha", "--match=beta"], { match: [] as string[] }, [
      stringListFlag("--match", "match"),
    ]);

    expect(parsed.match).toEqual(["alpha", "beta"]);
  });

  it("supports split-only, empty, transformed, and last-value-wins string contracts", () => {
    expect(() =>
      parseFlagArgs(["--value=inline"], { value: "" }, [
        stringFlag("--value", "value", { allowInline: false }),
      ]),
    ).toThrow("Unknown option: --value=inline");
    expect(
      parseFlagArgs(["--value", "", "--value", "SECOND"], { value: "" }, [
        stringFlag("--value", "value", {
          allowEmpty: true,
          repeatable: true,
          transform: (value) => value.toLowerCase(),
        }),
      ]).value,
    ).toBe("second");
  });

  it("supports idempotent boolean flags", () => {
    expect(
      parseFlagArgs(["--verbose", "--verbose"], { verbose: false }, [
        booleanFlag("--verbose", "verbose", true, { repeatable: true }),
      ]).verbose,
    ).toBe(true);
  });

  it("rejects duplicate single-value flags", () => {
    expect(() =>
      parseFlagArgs(["--label", "first", "--label=second"], { label: "" }, [
        stringFlag("--label", "label"),
      ]),
    ).toThrow("--label was provided more than once");
    expect(() =>
      parseFlagArgs(["--limit", "1", "--limit=2"], { limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
      ]),
    ).toThrow("--limit was provided more than once");
    expect(() =>
      parseFlagArgs(["--json", "--json"], { json: false }, [booleanFlag("--json", "json")]),
    ).toThrow("--json was provided more than once");
  });

  it("rejects missing string flag values before consuming the next option", () => {
    expect(() =>
      parseFlagArgs(["--base", "--head", "HEAD"], { base: "origin/main", head: "HEAD" }, [
        stringFlag("--base", "base"),
        stringFlag("--head", "head"),
      ]),
    ).toThrow("--base requires a value");
  });

  it("can reject short options as string values for CLIs that reserve short flags", () => {
    expect(() =>
      parseFlagArgs(["--output", "-h"], { output: "" }, [
        stringFlag("--output", "output", { rejectShortOptions: true }),
      ]),
    ).toThrow("--output requires a value");
    expect(() =>
      parseFlagArgs(["--match=-h"], { match: [] as string[] }, [
        stringListFlag("--match", "match", { rejectShortOptions: true }),
      ]),
    ).toThrow("--match requires a value");
  });

  it("rejects missing and malformed numeric flag values", () => {
    expect(() =>
      parseFlagArgs(["--limit"], { limit: 10 }, [intFlag("--limit", "limit", { min: 1 })]),
    ).toThrow("--limit requires a value");
    expect(() =>
      parseFlagArgs(["--limit", "--factor", "1.5"], { limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
      ]),
    ).toThrow("--limit requires a value");
    expect(() =>
      parseFlagArgs(["--limit", "20files"], { limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
      ]),
    ).toThrow("--limit must be an integer");
    expect(() =>
      parseFlagArgs(["--limit", "0"], { limit: 10 }, [intFlag("--limit", "limit", { min: 1 })]),
    ).toThrow("--limit must be at least 1");
  });

  it("can preserve the option separator for callers that need to handle it", () => {
    const seen: string[] = [];

    parseFlagArgs(["--"], {}, [], {
      ignoreDoubleDash: false,
      onUnhandledArg(arg) {
        seen.push(arg);
        return "handled";
      },
    });

    expect(seen).toEqual(["--"]);
  });
});
