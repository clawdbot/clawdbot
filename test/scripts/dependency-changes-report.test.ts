import { describe, expect, it } from "vitest";
import { createDependencyChangesReport } from "../../scripts/dependency-changes-report.mjs";

describe("dependency-changes-report", () => {
  it("reports added, removed, and changed packages", () => {
    const report = createDependencyChangesReport({
      basePayload: {
        removed: ["1.0.0"],
        stable: ["1.0.0"],
        changed: ["1.0.0"],
      },
      headPayload: {
        added: ["1.0.0"],
        stable: ["1.0.0"],
        changed: ["2.0.0"],
      },
      dependencyFileChanges: [
        { status: "M", path: "pnpm-lock.yaml", oldPath: null },
        { status: "M", path: "pnpm-workspace.yaml", oldPath: null },
      ],
      generatedAt: "2026-05-12T00:00:00Z",
    });

    expect(report.summary).toEqual({
      basePackages: 3,
      headPackages: 3,
      addedPackages: 1,
      removedPackages: 1,
      changedPackages: 1,
      dependencyFileChanges: 2,
    });
    expect(report.dependencyFileChanges).toEqual([
      { status: "M", path: "pnpm-lock.yaml", oldPath: null },
      { status: "M", path: "pnpm-workspace.yaml", oldPath: null },
    ]);
    expect(report.addedPackages).toEqual([{ packageName: "added", versions: ["1.0.0"] }]);
    expect(report.removedPackages).toEqual([{ packageName: "removed", versions: ["1.0.0"] }]);
    expect(report.changedPackages).toEqual([
      { packageName: "changed", addedVersions: ["2.0.0"], removedVersions: ["1.0.0"] },
    ]);
  });
});
