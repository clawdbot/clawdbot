import { describe, expect, it } from "vitest";
import { testForceTesting } from "../../scripts/test-force.js";

describe("scripts/test-force.ts", () => {
  it("prints help without clearing ports or running tests", () => {
    const args = testForceTesting.parseArgs(["--help"]);

    expect(args).toEqual({ help: true });
    expect(testForceTesting.usage()).toContain("Usage: node --import tsx scripts/test-force.ts");
    expect(testForceTesting.usage()).not.toContain("test:force - clearing gateway");
    expect(testForceTesting.usage()).not.toContain("running pnpm test");
  });

  it("rejects unknown arguments before clearing ports or running tests", () => {
    expect(() => testForceTesting.parseArgs(["--bogus"])).toThrow(
      /unknown argument: --bogus[\s\S]*Usage: node --import tsx scripts\/test-force\.ts/u,
    );
  });
});
