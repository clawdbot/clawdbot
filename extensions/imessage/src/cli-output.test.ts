import { describe, expect, it } from "vitest";
import { appendIMessageCliStderrTail, appendIMessageCliStdout } from "./cli-output.js";

describe("iMessage CLI output bounds", () => {
  it("rejects stdout once the JSON capture exceeds the cap", () => {
    const result = appendIMessageCliStdout("abc", "def", 5);

    expect(result).toEqual({
      ok: false,
      message: "imsg stdout exceeded 5 characters",
    });
  });

  it("keeps only recent stderr details", () => {
    const result = appendIMessageCliStderrTail("old-noise:", "recent-error", 12);

    expect(result).toBe("recent-error");
  });
});
