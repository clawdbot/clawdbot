import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("QA CLI onboarding evidence", () => {
  it("retains the bounded redacted child log", () => {
    const source = readFileSync("scripts/e2e/qa-cli-onboarding.mjs", "utf8");

    expect(source).toContain("writer.appendLog(chunk)");
    expect(source).toContain("const logArtifact = await writer.writeLog()");
    expect(source).toContain("artifactPaths: [logArtifact]");
    expect(source).not.toContain("artifactPaths: []");
  });
});
