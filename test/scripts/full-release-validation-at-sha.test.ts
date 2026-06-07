import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/full-release-validation-at-sha.mjs";

describe("full-release-validation-at-sha", () => {
  it("parses release validation dispatch args", () => {
    expect(
      parseArgs([
        "--sha",
        "abc123",
        "--branch",
        "release/proof",
        "--keep-branch",
        "--dry-run",
        "-f",
        "provider=anthropic",
        "--",
        "mode=linux",
      ]),
    ).toMatchObject({
      branch: "release/proof",
      dryRun: true,
      keepBranch: true,
      inputs: {
        mode: "linux",
        provider: "anthropic",
      },
      sha: "abc123",
    });
  });

  it("rejects missing option values", () => {
    expect(() => parseArgs(["--sha", "--dry-run"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--branch"])).toThrow("--branch requires a value");
    expect(() => parseArgs(["-f", "--dry-run"])).toThrow("-f requires a value");
  });
});
