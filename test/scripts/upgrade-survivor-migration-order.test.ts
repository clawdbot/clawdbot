import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const runner = resolve("scripts/e2e/lib/upgrade-survivor/run.sh");

function runFirstHop(scenario: string, automatic: boolean) {
  const home = tempDirs.make("survivor-migration-order-");
  const state = join(home, "state");
  mkdirSync(state);
  const prelude = join(home, "bash-env");
  // BASH_ENV replaces expensive phase bodies, leaving the real runner's ordering,
  // errexit, diagnostics and final summary in charge of the outcome.
  writeFileSync(
    prelude,
    `install_fixture_phases() {
  trap - DEBUG
  phase() {
    CURRENT_PHASE="$1"
    shift
    case "$CURRENT_PHASE" in
      update-candidate)
        printf 'update\\n' >>"$HOME/events"
        if [ "$FIXTURE_AUTOMATIC" = 1 ]; then touch "$HOME/migrated"; fi
        ;;
      doctor)
        printf 'doctor\\n' >>"$HOME/events"
        touch "$HOME/migrated"
        ;;
      assert-automatic-migration|assert-survival)
        printf 'observe\\n' >>"$HOME/events"
        if [ ! -f "$HOME/migrated" ]; then
          echo 'first-hop migration missing' >&2
          return 42
        fi
        ;;
      fixture-plugin-consent) printf 'consent\\n' >>"$HOME/events" ;;
    esac
  }
}
trap 'case "$BASH_COMMAND" in "phase "*) install_fixture_phases ;; esac' DEBUG
`,
  );
  const summary = join(home, "artifacts", "summary.json");
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
      OPENCLAW_UPGRADE_SURVIVOR_RUNTIME_ROOT: join(home, "runtime"),
      OPENCLAW_UPGRADE_SURVIVOR_SUMMARY_JSON: summary,
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE: "openclaw@2026.7.1-2",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIO: scenario,
      BASH_ENV: prelude,
      FIXTURE_AUTOMATIC: automatic ? "1" : "0",
    },
  });
  return {
    result,
    events: readFileSync(join(home, "events"), "utf8").trim().split("\n"),
    migrated: existsSync(join(home, "migrated")),
    summary: JSON.parse(readFileSync(summary, "utf8")),
  };
}

describe.skipIf(process.platform === "win32")("survivor first-hop observation", () => {
  it.each(["base", "configured-plugin-installs", "sqlite-volume"])(
    "rejects missing automatic migration before manual Doctor can repair %s",
    (scenario) => {
      const { result, events, migrated, summary } = runFirstHop(scenario, false);
      expect(result.status, result.stderr).toBe(42);
      expect(events).toEqual(["update", "observe"]);
      expect(migrated).toBe(false);
      expect(summary).toMatchObject({
        status: "failed",
        failure: { phase: "assert-automatic-migration" },
      });
    },
  );

  it("observes automatic migration before allowing manual Doctor and explicit consent", () => {
    const { result, events, summary } = runFirstHop("base", true);
    expect(result.status, result.stderr).toBe(0);
    expect(events).toEqual(["update", "observe", "doctor", "observe", "consent"]);
    expect(summary.status).toBe("passed");
  });
});
