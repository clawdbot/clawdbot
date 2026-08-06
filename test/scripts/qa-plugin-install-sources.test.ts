import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const FILE_SPEC_MARKER = "Testing install from npm spec (file:)...";

describe("QA plugin install source coverage", () => {
  it("requires the executable npm file-spec assertion marker", () => {
    const qaWrapper = readFileSync("scripts/e2e/qa-plugin-install-sources.mjs", "utf8");
    const pluginSweep = readFileSync("scripts/e2e/lib/plugins/sweep.sh", "utf8");

    expect(pluginSweep).toContain(`echo "${FILE_SPEC_MARKER}"`);
    expect(qaWrapper).toContain(`"${FILE_SPEC_MARKER}",`);
  });
});
