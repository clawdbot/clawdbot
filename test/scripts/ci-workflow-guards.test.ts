import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ci workflow guards", () => {
  it("runs the package patch guard in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("preflight-guards)"),
      workflow.indexOf("prod-types)"),
    );

    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });
});
