import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/full-release-validation-at-sha.mjs";

describe("full-release-validation-at-sha", () => {
  it("parses release validation dispatch args", () => {
    expect(
      parseArgs([
        "--sha",
        "abc123",
        "--workflow-sha",
        "origin/main",
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
        reuse_evidence: "false",
      },
      sha: "abc123",
      workflowSha: "origin/main",
    });
  });

  it("rejects missing option values", () => {
    expect(() => parseArgs(["--sha", "--dry-run"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--sha", "-h"])).toThrow("--sha requires a value");
    expect(() => parseArgs(["--workflow-sha", "--dry-run"])).toThrow(
      "--workflow-sha requires a value",
    );
    expect(() => parseArgs(["--workflow-sha", "-h"])).toThrow("--workflow-sha requires a value");
    expect(() => parseArgs(["--branch"])).toThrow("--branch requires a value");
    expect(() => parseArgs(["--branch", "-h"])).toThrow("--branch requires a value");
    expect(() => parseArgs(["-f", "--dry-run"])).toThrow("-f requires a value");
    expect(() => parseArgs(["-f", "-h"])).toThrow("-f requires a value");
  });

  it("cannot enable evidence reuse on a temporary SHA-pinned workflow ref", () => {
    expect(() => parseArgs(["-f", "reuse_evidence=true"])).toThrow(
      "always disables evidence reuse",
    );
  });
});
