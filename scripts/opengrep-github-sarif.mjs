import { readFileSync } from "node:fs";

try {
  const [inputPath, ...extraArgs] = process.argv.slice(2);
  if (!inputPath || extraArgs.length > 0) {
    throw new Error("Usage: node scripts/opengrep-github-sarif.mjs <raw.sarif>");
  }
  const report = JSON.parse(readFileSync(inputPath, "utf8"));
  if (report.version !== "2.1.0" || !Array.isArray(report.runs)) {
    throw new Error("Expected a SARIF 2.1.0 report with runs");
  }
  let omitted = 0;
  for (const run of report.runs) {
    if (run.results == null) {
      continue;
    }
    const resultCount = run.results.length;
    run.results = run.results.filter((result) => {
      // Opengrep 1.27.1 emits inSource without status for ignored matches;
      // GitHub ignores SARIF suppressions. Keep unknown or disputed decisions.
      const suppressions = result?.suppressions;
      return !(
        Array.isArray(suppressions) &&
        suppressions.length > 0 &&
        suppressions.every(
          (suppression) =>
            suppression?.kind === "inSource" &&
            (suppression.status === undefined || suppression.status === "accepted"),
        )
      );
    });
    omitted += resultCount - run.results.length;
  }
  console.error(
    `[opengrep-github-sarif] Omitted ${omitted} accepted in-source suppression(s); raw audit: ${inputPath}`,
  );
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  console.error("[opengrep-github-sarif] FAILED (exit 1)");
  process.exitCode = 1;
}
