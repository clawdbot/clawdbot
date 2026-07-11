import fs from "node:fs";
import JSON5 from "json5";
import { describe, expect, it } from "vitest";
import { STRICT_RATCHET_PACKAGE_DIRS, detectChangedLanes } from "../../scripts/changed-lanes.mjs";
import { createChangedCheckPlan } from "../../scripts/check-changed.mjs";

const config: unknown = JSON5.parse(fs.readFileSync("tsconfig.strict-ratchet.json", "utf8"));
if (
  !config ||
  typeof config !== "object" ||
  !("include" in config) ||
  !Array.isArray(config.include) ||
  !config.include.every((entry) => typeof entry === "string")
) {
  throw new Error("expected strict-ratchet tsconfig includes to be strings");
}
const includedPackages = config.include
  .filter(
    (entry) =>
      entry.startsWith("packages/") &&
      (entry.endsWith("/**/*") || entry.endsWith("/*.ts") || entry.endsWith("/**/*.ts")),
  )
  .map((include) => ({
    include,
    packageDir: include.replace(/\/(?:src\/\*\*\/\*|\*\.ts|\*\*\/\*\.ts)$/u, ""),
  }));
const includedPackageDirs = includedPackages.map(({ packageDir }) => packageDir);

describe("strict ratchet routing", () => {
  it("keeps the changed-lane package list pinned to the tsconfig", () => {
    expect(includedPackageDirs).toEqual(STRICT_RATCHET_PACKAGE_DIRS);
  });

  it.each(includedPackages)(
    "routes $packageDir changes through the ratchet lane",
    ({ include }) => {
      const result = detectChangedLanes([include.replace(/(?:\*\*\/\*|\*)/u, "example")]);
      const plan = createChangedCheckPlan(result);

      expect(result.lanes.strictRatchet).toBe(true);
      expect(plan.commands.map((command) => command.args[0])).toContain("tsgo:strict-ratchet");
    },
  );

  it("routes the ratchet tsconfig through its lane", () => {
    expect(detectChangedLanes(["tsconfig.strict-ratchet.json"]).lanes.strictRatchet).toBe(true);
  });
});
