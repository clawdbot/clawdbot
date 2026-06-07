// Arg Utils tests cover arg utils script behavior.
import { describe, expect, it } from "vitest";
import {
  floatFlag,
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
      ["--label=changed-tests", "--limit=30", "--factor=1.5"],
      { factor: 1, label: "", limit: 10 },
      [
        stringFlag("--label", "label"),
        intFlag("--limit", "limit", { min: 1 }),
        floatFlag("--factor", "factor", { min: 0, includeMin: false }),
      ],
    );

    expect(parsed).toEqual({
      factor: 1.5,
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
      parseFlagArgs(["--limit", "--factor", "1.5"], { factor: 1, limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
        floatFlag("--factor", "factor", { min: 0, includeMin: false }),
      ]),
    ).toThrow("--limit requires a value");
    expect(() =>
      parseFlagArgs(["--factor", "--limit", "2"], { factor: 1, limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
        floatFlag("--factor", "factor", { min: 0, includeMin: false }),
      ]),
    ).toThrow("--factor requires a value");
    expect(() =>
      parseFlagArgs(["--limit", "20files"], { limit: 10 }, [
        intFlag("--limit", "limit", { min: 1 }),
      ]),
    ).toThrow("--limit must be an integer");
    expect(() =>
      parseFlagArgs(["--limit", "0"], { limit: 10 }, [intFlag("--limit", "limit", { min: 1 })]),
    ).toThrow("--limit must be at least 1");
    expect(() =>
      parseFlagArgs(["--factor", "1e3"], { factor: 1 }, [
        floatFlag("--factor", "factor", { min: 0, includeMin: false }),
      ]),
    ).toThrow("--factor must be a number");
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
