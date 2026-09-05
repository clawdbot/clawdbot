import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");
const baselineVersion = "2026.7.1-2";
const candidateVersion = "2026.8.1";

describe.skipIf(process.platform === "win32")(
  "survivor installed version after update failure",
  () => {
    it.each([
      { packageState: "swapped", installedVersion: candidateVersion, exitCode: 1 },
      { packageState: "missing", installedVersion: null, exitCode: 42 },
      { packageState: "broken", installedVersion: null, exitCode: 43 },
      { packageState: "unchanged", installedVersion: baselineVersion, exitCode: 44 },
    ])("reports $packageState package bytes and preserves exit $exitCode", (fixture) => {
      const home = tempDirs.make("survivor-installed-version-");
      const state = join(home, "state");
      const tmp = join(home, "tmp");
      const artifacts = join(home, "artifacts");
      const prefix = join(artifacts, "npm-prefix");
      const packageRoot = join(prefix, "lib", "node_modules", "openclaw");
      const bin = join(prefix, "bin");
      for (const directory of [state, tmp, packageRoot, bin]) {
        mkdirSync(directory, { recursive: true });
      }
      writeFileSync(
        join(packageRoot, "package.json"),
        JSON.stringify({ name: "openclaw", version: baselineVersion }),
      );
      const entrypoint = join(packageRoot, "openclaw.mjs");
      // Inject the package-swap/finalization fault at the executable boundary.
      // The real update owner, package reader, assertions and exit summary still run.
      writeFileSync(
        entrypoint,
        `#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const args = process.argv.slice(2);
fs.appendFileSync(path.join(process.env.HOME, 'calls'), JSON.stringify(args) + '\\n');
if (args[0] === 'update') {
  const manifest = path.join(path.dirname(fileURLToPath(import.meta.url)), 'package.json');
  const packageState = ${JSON.stringify(fixture.packageState)};
  if (packageState === 'missing') {
    fs.unlinkSync(manifest);
  } else if (packageState !== 'unchanged') {
    const bytes = packageState === 'broken' ? '{' : JSON.stringify({name:'openclaw', version:${JSON.stringify(candidateVersion)}});
    fs.writeFileSync(manifest + '.next', bytes);
    fs.renameSync(manifest + '.next', manifest);
  }
  console.log(JSON.stringify({
    status:'error', mode:'npm', reason:'openclaw doctor',
    before:{version:${JSON.stringify(baselineVersion)}},
    after:{version:${JSON.stringify(candidateVersion)}},
    steps:[{name:'global update',exitCode:0},{name:'global install swap',exitCode:0},{name:'openclaw doctor',exitCode:${fixture.exitCode}}]
  }));
  console.error('target Doctor fixture failed');
  process.exitCode = ${fixture.exitCode};
} else {
  console.error('fixture CLI probe unavailable');
  process.exitCode = 45;
}
`,
        { mode: 0o755 },
      );
      symlinkSync(entrypoint, join(bin, "openclaw"));
      const prelude = join(home, "bash-env");
      writeFileSync(
        prelude,
        `install_fixture_phases() {
  trap - DEBUG
  phase() {
    CURRENT_PHASE="$1"
    shift
    case "$CURRENT_PHASE" in
      install-baseline)
        normalize_baseline
        installed_version="$(read_installed_version)"
        ;;
      resolve-candidate) candidate_version=${candidateVersion} ;;
      update-candidate) "$@" ;;
    esac
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
      );
      const summaryPath = join(artifacts, "summary.json");
      const result = spawnSync("bash", [runner], {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: home,
          USERPROFILE: home,
          OPENCLAW_HOME: home,
          OPENCLAW_STATE_DIR: state,
          OPENCLAW_CONFIG_PATH: join(state, "openclaw.json"),
          TMPDIR: tmp,
          OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(home, "runtime"),
          OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summaryPath,
          OPENCLAW_UPGRADE_SURVIVOR_BASELINE: `openclaw@${baselineVersion}`,
          OPENCLAW_UPGRADE_SURVIVOR_CANDIDATE_SPEC: join(home, "candidate.tgz"),
          BASH_ENV: prelude,
        },
      });
      expect(result.status, result.stderr).toBe(fixture.exitCode);
      expect(readFileSync(join(artifacts, "update.err"), "utf8")).toContain(
        "target Doctor fixture failed",
      );
      const summary = JSON.parse(readFileSync(summaryPath, "utf8"));
      expect(summary).toMatchObject({
        status: "failed",
        baseline: { version: baselineVersion },
        failure: {
          phase: "update-candidate",
          message: `phase update-candidate failed with status ${fixture.exitCode}`,
        },
      });
      const diagnostics = JSON.parse(
        readFileSync(join(artifacts, "diagnostics", "raw.json"), "utf8"),
      );
      expect(diagnostics).toMatchObject({
        phase: "update-candidate",
        exitStatus: fixture.exitCode,
      });
      const calls: string[][] = readFileSync(join(home, "calls"), "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      // Keep the existing failure probe; version discovery must add no CLI calls.
      expect(calls.map((args) => args[0])).toEqual(["update", "config"]);
      expect(calls[1]).toEqual(["config", "validate", "--json"]);
      expect(summary.installedVersion).toBe(fixture.installedVersion);
    });
  },
);
