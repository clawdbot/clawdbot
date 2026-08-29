// GitHub upload projection; the original OpenGrep SARIF remains the audit artifact.
import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";

const auditPath = ".opengrep-out/precise.sarif";
const activePath = ".opengrep-out/precise-active.sarif";

try {
  // A failed read, parse, or write must never leave an earlier upload candidate.
  rmSync(activePath, { force: true });
  const report = JSON.parse(readFileSync(auditPath, "utf8"));
  assert.equal(report.version, "2.1.0", "Expected SARIF 2.1.0");
  assert.ok(Array.isArray(report.runs) && report.runs.length > 0, "Missing SARIF runs");
  let active = 0;
  let sourceSuppressed = 0;
  for (const run of report.runs) {
    assert.equal(run.tool?.driver?.name, "Opengrep OSS", "Expected OpenGrep audit run");
    assert.ok(Array.isArray(run.results), "Missing SARIF results");
    run.results = run.results.filter((result) => {
      assert.ok(result && typeof result === "object" && !Array.isArray(result), "Invalid result");
      assert.equal(typeof result.ruleId, "string", "Missing OpenGrep rule ID");
      assert.equal(typeof result.message?.text, "string", "Missing OpenGrep result message");
      // v1.27.1 Sarif_output.ml emits one inSource record for is_ignored=true.
      // Keep rejected, pending, unknown, and compound suppression states active.
      const suppression = result.suppressions?.[0];
      const suppressed =
        Array.isArray(result.suppressions) &&
        result.suppressions.length === 1 &&
        suppression?.kind === "inSource" &&
        (suppression.status === undefined || suppression.status === "accepted");
      if (suppressed) {
        sourceSuppressed++;
      } else {
        active++;
      }
      return !suppressed;
    });
  }
  writeFileSync(activePath, `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    `::notice title=OpenGrep upload projection::${active} active findings; ${sourceSuppressed} source-suppressed findings. Full audit retained in the workflow SARIF artifact (${auditPath}). Scan exit status is unchanged.`,
  );
} catch (error) {
  console.error(error);
  console.error("[project-opengrep-sarif] FAILED (exit 1)");
  process.exitCode = 1;
}
