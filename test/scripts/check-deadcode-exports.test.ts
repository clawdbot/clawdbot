// Check Deadcode Exports tests cover parsing, ratcheting, and baseline emission.
import { describe, expect, it } from "vitest";
import {
  compareUnusedExportsToBaseline,
  formatUnusedExportBaseline,
  parseKnipCompactUnusedExports,
  parseKnipCompactUnusedExportsResult,
} from "../../scripts/check-deadcode-exports.mjs";

describe("check-deadcode-exports", () => {
  it("parses all compact export sections and expands symbol lists", () => {
    expect(
      parseKnipCompactUnusedExports(`
Unused exports (2)
src/b.ts: beta, alpha
/tmp/outside.ts: noise

Unused exported types (1)
extensions/example/src/types.ts: ExampleType

Unused exported enum members (1)
packages/example/src/state.ts: Ready

Unused files (1)
src/noise.ts: src/noise.ts
`),
    ).toEqual([
      "extensions/example/src/types.ts: ExampleType",
      "packages/example/src/state.ts: Ready",
      "src/b.ts: alpha",
      "src/b.ts: beta",
    ]);
  });

  it("distinguishes a failed scan with no export sections from zero findings", () => {
    expect(parseKnipCompactUnusedExportsResult("Configuration error: invalid project\n")).toEqual({
      entries: [],
      sawExportSection: false,
    });
    expect(parseKnipCompactUnusedExportsResult("Unused exports (0)\n")).toEqual({
      entries: [],
      sawExportSection: true,
    });
  });

  it.each([
    {
      name: "unexpected and stale entries",
      actual: ["src/a.ts: kept", "src/new.ts: added"],
      required: ["src/a.ts: kept", "src/old.ts: removed"],
      optional: [],
      expected: { unexpected: ["src/new.ts: added"], stale: ["src/old.ts: removed"] },
    },
    {
      name: "optional entries present",
      actual: ["src/a.ts: kept", "src/platform.ts: variant"],
      required: ["src/a.ts: kept"],
      optional: ["src/platform.ts: variant"],
      expected: { unexpected: [], stale: [] },
    },
    {
      name: "optional entries absent",
      actual: ["src/a.ts: kept"],
      required: ["src/a.ts: kept"],
      optional: ["src/platform.ts: variant"],
      expected: { unexpected: [], stale: [] },
    },
  ])("ratchets $name", ({ actual, expected, optional, required }) => {
    expect(compareUnusedExportsToBaseline(actual, required, optional)).toMatchObject(expected);
  });

  it("rejects unsorted and duplicate required baselines", () => {
    expect(
      compareUnusedExportsToBaseline(
        ["src/a.ts: one", "src/b.ts: two"],
        ["src/b.ts: two", "src/a.ts: one", "src/a.ts: one"],
      ),
    ).toMatchObject({ allowlistIsSorted: false, duplicateAllowedCount: 1 });
  });

  it("emits a sorted baseline module while preserving optional entries", () => {
    expect(
      formatUnusedExportBaseline(
        ["src/b.ts: beta", "src/a.ts: alpha", "src/a.ts: alpha", "src/platform.ts: variant"],
        ["src/platform.ts: variant"],
      ),
    ).toBe(`// Pre-existing unused exports awaiting deletion.
// New entries fail CI. After deleting dead code, run \`pnpm deadcode:exports:update\`.
// Do not add entries to avoid fixing new findings.
export const KNIP_UNUSED_EXPORT_BASELINE = [
  "src/a.ts: alpha",
  "src/b.ts: beta",
];

// Platform-variant findings. Allowed when present; never required.
export const KNIP_OPTIONAL_UNUSED_EXPORT_BASELINE = [
  "src/platform.ts: variant",
];
`);
  });
});
