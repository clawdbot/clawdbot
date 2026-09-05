import { spawnSync } from "node:child_process";

// Use the installed CLI after normal onboarding; a source-tree API would hide missing package surfaces.
for (const only of [undefined, "codex/managed-app-server"]) {
  const args = ["doctor", "--lint", "--json", ...(only ? ["--only", only] : [])];
  const result = spawnSync("openclaw", args, { encoding: "utf8", timeout: 120_000 });
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(
      `doctor failed before producing findings: ${result.error?.message ?? result.stderr}`,
    );
  }
  const report = JSON.parse(result.stdout);
  if (only) {
    if (
      result.status !== 0 ||
      report.ok !== true ||
      report.checksRun !== 1 ||
      report.findings.length !== 0
    ) {
      throw new Error(`managed Codex doctor check failed: ${JSON.stringify(report)}`);
    }
  } else if (report.checksRun <= 1) {
    throw new Error(`ordinary doctor did not reach health checks: ${JSON.stringify(report)}`);
  }
  process.stdout.write(`[codex-doctor] ${only ?? "default"}: ${JSON.stringify(report)}\n`);
}
