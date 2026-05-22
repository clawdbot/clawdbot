import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("ci workflow guards", () => {
  it("runs dependency policy guards in PR CI preflight", () => {
    const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
    const preflightGuards = workflow.slice(
      workflow.indexOf("guards)"),
      workflow.indexOf("prod-types)"),
    );

    expect(workflow).toContain("check-guards");
    expect(preflightGuards).toContain("pnpm deps:shrinkwrap:check");
    expect(preflightGuards).toContain("pnpm deps:patches:check");
  });

  it("keeps push docs validation ClawHub-backed", () => {
    const workflow = readFileSync(".github/workflows/docs.yml", "utf8");

    expect(workflow).toContain("repository: openclaw/clawhub");
    expect(workflow).toContain("path: clawhub-source");
    expect(workflow).toContain(
      "OPENCLAW_DOCS_SYNC_CLAWHUB_REPO: ${{ github.workspace }}/clawhub-source",
    );
  });
});
