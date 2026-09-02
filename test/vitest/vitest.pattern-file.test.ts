import { describe, expect, it } from "vitest";
import { intersectIncludePatterns } from "./vitest.pattern-file.ts";

describe("intersectIncludePatterns", () => {
  it("projects arbitrary candidate globs onto a finite literal owner", () => {
    const owner = [
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
      "ui/src/pages/workboard/workboard.e2e.test.ts",
    ];

    expect(intersectIncludePatterns(owner, ["ui/src/e2e/*.e2e.test.ts"])).toEqual([
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
    ]);
    expect(
      intersectIncludePatterns(owner, [
        "ui/src/e2e/chat*.e2e.test.ts",
        "ui/src/e2e/chat.e2e.test.ts",
      ]),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
  });

  it("retains the ambiguity guard for glob-owned inventories", () => {
    expect(() =>
      intersectIncludePatterns(["ui/src/**/*.e2e.test.ts"], ["ui/src/e2e/*.e2e.test.ts"]),
    ).toThrow("cannot safely intersect non-literal include path");
  });
});
