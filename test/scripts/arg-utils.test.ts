import { describe, expect, it } from "vitest";
import { intFlag, parseFlagArgs } from "../../scripts/lib/arg-utils.mjs";

describe("scripts/lib/arg-utils parseFlagArgs", () => {
  it("ignores the conventional option separator by default", () => {
    const parsed = parseFlagArgs(
      ["--", "--limit", "30"],
      { limit: 10 },
      [intFlag("--limit", "limit", { min: 1 })],
    );

    expect(parsed.limit).toBe(30);
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
