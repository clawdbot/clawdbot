import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCENARIO = "scripts/e2e/lib/release-media-memory/scenario.sh";

describe("release media memory scenario", () => {
  it("fails when packaged plugin listing is broken or omits memory-core", () => {
    const script = readFileSync(SCENARIO, "utf8");
    const listIndex = script.indexOf(
      "openclaw plugins list --json >/tmp/openclaw-release-media-memory-plugins.json",
    );
    const assertIndex = script.indexOf(
      "assert-file-contains /tmp/openclaw-release-media-memory-plugins.json memory-core",
    );

    expect(listIndex).toBeGreaterThanOrEqual(0);
    expect(assertIndex).toBeGreaterThan(listIndex);
    expect(script.slice(listIndex, assertIndex)).not.toContain("|| true");
  });

  it("uses portable package file listing syntax", () => {
    const script = readFileSync(SCENARIO, "utf8");

    expect(script).not.toContain("-printf");
  });
});
