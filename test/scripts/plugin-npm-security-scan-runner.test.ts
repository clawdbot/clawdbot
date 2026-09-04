import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const CANDIDATE_SHA = "1".repeat(40);
const TOOLING_SHA = "2".repeat(40);

describe.skipIf(process.platform === "win32")("plugin npm security runner RSS samples", () => {
  it.each([
    ["zero", "0", true],
    ["negative", "-1", false],
    ["nonnumeric", "invalid", false],
    ["fractional", "0.5", false],
    ["unsafe integer", "9007199254740992", false],
  ] as const)("handles a non-zombie %s RSS sample", (_label, rss, accepted) => {
    const root = tempDirs.make("openclaw-plugin-npm-security-rss-sample-");
    const childPath = join(root, "child.mjs");
    const pidPath = join(root, "child.pid");
    const samplePath = join(root, "sample.txt");
    const reportPath = join(root, "report.json");
    const binDir = join(root, "bin");
    const childReport = {
      candidateSha: CANDIDATE_SHA,
      errors: [],
      layout: null,
      packages: [],
      scanScope: "supplemental-inert-package-input",
      schemaVersion: 1,
      status: "pass",
      summary: {
        findingCount: 0,
        packageCount: 0,
        reviewedCriticalFindingCount: 0,
        unexpectedCriticalFindingCount: 0,
      },
      toolingSha: TOOLING_SHA,
    };
    // Keep the child alive until ps observes readiness and emits the controlled sample.
    writeFileSync(
      childPath,
      `import { renameSync, writeFileSync } from "node:fs";
const keepAlive = setInterval(() => {}, 1000);
process.once("SIGUSR2", () => clearInterval(keepAlive));
writeFileSync(${JSON.stringify(reportPath)}, ${JSON.stringify(JSON.stringify(childReport))});
writeFileSync(${JSON.stringify(`${pidPath}.ready`)}, String(process.pid));
renameSync(${JSON.stringify(`${pidPath}.ready`)}, ${JSON.stringify(pidPath)});
`,
    );
    mkdirSync(binDir);
    writeFileSync(
      join(binDir, "ps"),
      `#!${process.execPath}
const { spawnSync } = require("node:child_process");
const { existsSync, readFileSync, writeFileSync, writeSync } = require("node:fs");
const args = process.argv.slice(2);
if (args.join(" ") !== "-A -o pid=,pgid=,rss=,stat=" || !existsSync(${JSON.stringify(pidPath)})) {
  const result = spawnSync("/bin/ps", args, { stdio: "inherit" });
  process.exit(result.status ?? 1);
}
const pid = Number(readFileSync(${JSON.stringify(pidPath)}, "utf8"));
const row = pid + " " + pid + " " + ${JSON.stringify(rss)} + " S\\n";
writeFileSync(${JSON.stringify(samplePath)}, row);
writeSync(1, row);
process.kill(pid, "SIGUSR2");
`,
      { mode: 0o755 },
    );

    const result = spawnSync(
      process.execPath,
      [
        "scripts/plugin-npm-security-scan-runner.mjs",
        "--artifact-root",
        root,
        "--candidate-sha",
        CANDIDATE_SHA,
        "--tooling-sha",
        TOOLING_SHA,
        "--report",
        reportPath,
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          NODE_ENV: "test",
          OPENCLAW_PLUGIN_SECURITY_RUNNER_CHILD: childPath,
          OPENCLAW_PLUGIN_SECURITY_RUNNER_TIMEOUT_MS: "5000",
          PATH: `${binDir}${delimiter}${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    );

    const pid = Number(readFileSync(pidPath, "utf8"));
    expect(readFileSync(samplePath, "utf8")).toBe(`${pid} ${pid} ${rss} S\n`);
    expect(JSON.parse(readFileSync(reportPath, "utf8"))).toEqual({
      ...childReport,
      errors: accepted ? [] : ["Plugin npm security scanner could not measure RSS."],
      status: accepted ? "pass" : "fail",
    });
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(accepted ? 0 : 1);
  });
});
