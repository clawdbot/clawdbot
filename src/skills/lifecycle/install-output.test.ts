import { describe, expect, it } from "vitest";
import { formatInstallFailureMessage } from "./install-output.js";

describe("formatInstallFailureMessage", () => {
  it("drops a surrogate pair that straddles the summary limit", () => {
    // 198 ASCII units put the emoji's high surrogate at the old 199-unit cut.
    const prefix = "e".repeat(198);
    const msg = `${prefix}\u{1F600}tail`;
    const result = formatInstallFailureMessage({
      code: 1,
      stdout: "",
      stderr: msg,
    });
    expect(result).toBe(`Install failed (exit 1): ${prefix}…`);
  });
});
