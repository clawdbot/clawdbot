import { describe, expect, it } from "vitest";
import { detectChangedLanes } from "../../scripts/changed-lanes.mts";
import { createChangedCheckPlan } from "../../scripts/check-changed.mts";

describe("generated extension asset lint planning", () => {
  it("still lints extension tests alongside a generated browser asset", () => {
    const generatedAsset = "extensions/canvas/src/host/a2ui/a2ui.bundle.js";
    const extensionTest = "extensions/canvas/scripts/bundle-a2ui.test.ts";
    const result = detectChangedLanes([generatedAsset, extensionTest]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expect(result.lanes.extensionTests).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "lint extension changed file",
        args: [
          "scripts/run-oxlint.mjs",
          "--tsconfig",
          "config/tsconfig/oxlint.extensions.json",
          extensionTest,
        ],
      }),
    );
    expect(
      plan.commands
        .filter((command) => command.args[0] === "scripts/run-oxlint.mjs")
        .flatMap((command) => command.args),
    ).not.toContain(generatedAsset);
  });

  it("keeps fallback extension lint for a manifest beside a generated browser asset", () => {
    const generatedAsset = "extensions/canvas/src/host/a2ui/a2ui.bundle.js";
    const manifest = "extensions/canvas/openclaw.plugin.json";
    const result = detectChangedLanes([generatedAsset, manifest]);
    const plan = createChangedCheckPlan(result, { env: { PATH: "/usr/bin" } });

    expect(result.lanes.extensions).toBe(true);
    expect(plan.commands).toContainEqual(
      expect.objectContaining({
        name: "lint extensions",
        args: ["lint:extensions"],
      }),
    );
    expect(
      plan.commands
        .filter((command) => command.args[0] === "scripts/run-oxlint.mjs")
        .flatMap((command) => command.args),
    ).not.toContain(generatedAsset);
  });
});
