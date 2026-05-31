import { describe, expect, it } from "vitest";
import { qaLabUpTesting } from "../../scripts/qa-lab-up.js";

describe("scripts/qa-lab-up", () => {
  it("prints help before loading the Docker runtime", () => {
    const args = qaLabUpTesting.parseQaLabUpArgs(["--help"]);

    expect(args.help).toBe(true);
    expect(qaLabUpTesting.usage()).toContain("Usage: pnpm qa:lab:up");
  });
});
