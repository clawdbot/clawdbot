import {
  collectBroadUnitFastTestCandidates,
  collectUnitFastTestFileAnalysis,
  collectUnitFastTestCandidates,
  getUnitFastTestFiles,
} from "../test/vitest/vitest.unit-fast-paths.mjs";

const args = new Set(process.argv.slice(2));
const json = args.has("--json");
const scope = args.has("--broad") ? "broad" : "current";

const analysis = collectUnitFastTestFileAnalysis(process.cwd(), { scope });
const rejected = analysis.filter((entry) => !entry.unitFast);
const reasonCounts = new Map();
const candidateCount =
  scope === "broad"
    ? collectBroadUnitFastTestCandidates(process.cwd()).length
    : collectUnitFastTestCandidates(process.cwd()).length;
const unitFastTestFiles = getUnitFastTestFiles();
const unitFastCount = analysis.filter((entry) => entry.unitFast).length;

for (const entry of rejected) {
  for (const reason of entry.reasons) {
    reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
  }
}

if (json) {
  console.log(
    JSON.stringify(
      {
        candidates: candidateCount,
        unitFast: unitFastCount,
        routed: unitFastTestFiles.length,
        rejected: rejected.length,
        reasonCounts: Object.fromEntries(
          [...reasonCounts.entries()].toSorted(([a], [b]) => a.localeCompare(b)),
        ),
        scope,
        files: analysis,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log(
  [
    `[test-unit-fast-audit] scope=${scope} candidates=${analysis.length} unitFast=${unitFastCount} routed=${unitFastTestFiles.length} rejected=${rejected.length}`,
    scope === "broad"
      ? `[test-unit-fast-audit] broad unit-fast candidates are not routed automatically`
      : "",
    "",
    "Rejected reasons:",
    ...[...reasonCounts.entries()]
      .toSorted((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([reason, count]) => `  ${String(count).padStart(4, " ")} ${reason}`),
  ].join("\n"),
);
