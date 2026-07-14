// Arg Utils tests cover arg utils script behavior.
import { describe, expect, it } from "vitest";
import {
  booleanFlag,
  intFlag,
  parseFlagArgs,
  stringFlag,
  stringListFlag,
} from "../../scripts/lib/arg-utils.mjs";

describe("scripts/lib/arg-utils parseFlagArgs", () => {
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

  it("requires custom specs to declare consumed flags", () => {
    expect(() =>
      parseFlagArgs(["--custom"], {}, [
        {
          consume(argv, index) {
            if (argv[index] !== "--custom") {
              return null;
            }
            return {
              nextIndex: index,
              apply() {},
            };
          },
        },
      ]),
    ).toThrow("parseFlagArgs specs must declare a flag for consumed options");
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
