// E2E Shell Tempfiles tests cover e2e shell tempfiles script behavior.
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function listShellScripts(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const scripts: string[] = [];

  for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      scripts.push(...(await listShellScripts(entryPath)));
    } else if (entry.isFile() && entry.name.endsWith(".sh")) {
      scripts.push(entryPath);
    }
  }

  return scripts;
}

async function extractClawhubSkillInstallVerifier(): Promise<string> {
  const script = await readFile("scripts/e2e/lib/skills/clawhub-install-proof.sh", "utf8");
  const marker =
    'node --input-type=module - "$OPENCLAW_CONFIG_PATH" "$skill_dir" "$origin_json" "$lock_json" "$info_json" "$slug" <<\'NODE\'\n';
  const start = script.indexOf(marker);
  if (start === -1) {
    throw new Error("ClawHub skill install verifier heredoc was not found");
  }
  const verifierStart = start + marker.length;
  const verifierEnd = script.indexOf("\nNODE", verifierStart);
  if (verifierEnd === -1) {
    throw new Error("ClawHub skill install verifier heredoc was not terminated");
  }
  return script.slice(verifierStart, verifierEnd);
}

describe("e2e shell tempfile hygiene", () => {
  it("does not allocate FIFO paths with mktemp -u", async () => {
    const offenders: string[] = [];

    for (const scriptPath of await listShellScripts("scripts/e2e")) {
      const contents = await readFile(path.resolve(scriptPath), "utf8");
      if (contents.includes("mktemp -u")) {
        offenders.push(scriptPath);
      }
    }

    expect(offenders).toEqual([]);
  });

  it("preserves wizard exit status when reporting failures", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-status-test-"));
    const fixturePath = path.join(tempRoot, "wizard-status.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
openclaw_test_state_create() { :; }
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_run_script_with_pty() {
  local _command="$1"
  local log_path="$2"
  printf 'fake wizard log\\n' >"$log_path"
  exit 7
}

send_noop() { :; }

run_wizard_cmd failing-wizard fake-state "node fake-wizard" send_noop false
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(7);
      expect(output).toContain("Wizard exited with status 7");
      expect(output).toContain("fake wizard log");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("does not wait for a skills prompt after the ready state renders", async () => {
    const tempRoot = tempDirs.make("openclaw-onboard-skills-ready-");
    const fixturePath = path.join(tempRoot, "skills-ready.sh");
    const sentPath = path.join(tempRoot, "sent.txt");
    const wizardLogPath = path.join(tempRoot, "skills.log");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

sleep() { :; }
WIZARD_LOG_PATH=${JSON.stringify(wizardLogPath)}
printf 'Skills status\\nAll skills ready\\n' >"$WIZARD_LOG_PATH"
exec 3>${JSON.stringify(sentPath)}
send_skills_flow
exec 3>&-
test ! -s ${JSON.stringify(sentPath)}
`,
    );

    const result = spawnSync("bash", [fixturePath], {
      cwd: process.cwd(),
      encoding: "utf8",
    });

    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(`${result.stdout}\n${result.stderr}`).not.toContain("Timeout waiting");
  });

  it("checks local onboarding logs for systemd noise", async () => {
    const contents = await readFile("scripts/e2e/lib/onboard/scenario.sh", "utf8");

    expect(contents).toContain(
      'ONBOARD_TMP_DIR="$(mktemp -d "$ONBOARD_TMP_ROOT/openclaw-onboard.XXXXXX")"',
    );
    expect(contents).toContain('OPENCLAW_E2E_LOG_DIR="$ONBOARD_TMP_DIR/logs"');
    expect(contents).toContain('GATEWAY_LOG_PATH="$ONBOARD_TMP_DIR/gateway-e2e.log"');
    expect(contents).not.toContain("/tmp/gateway-e2e.log");
    expect(contents).toContain('validate_local_basic_log "$OPENCLAW_E2E_LAST_LOG_PATH"');
    expect(contents).not.toContain(
      "validate_local_basic_log /tmp/openclaw-onboard-local-basic.log",
    );
    expect(contents).toContain(
      'openclaw_e2e_assert_log_not_contains "$log_path" "systemctl --user unavailable"',
    );
  });

  it("probes onboarding gateway readiness through TCP", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-log-"));
    const fixturePath = path.join(tempRoot, "gateway-log.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() { return 0; }
sleep 30 &
GATEWAY_PID="$!"
printf 'listening on ws://127.0.0.1:18789\\n' >"$GATEWAY_LOG_PATH"
wait_for_gateway
case "$GATEWAY_LOG_PATH" in
  "$ONBOARD_TMP_DIR"/*) ;;
  *) echo "gateway log escaped scratch root: $GATEWAY_LOG_PATH" >&2; exit 1 ;;
esac
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects onboarding gateway readiness when the TCP probe fails", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-tcp-"));
    const fixturePath = path.join(tempRoot, "gateway-tcp.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2
export OPENCLAW_ONBOARD_GATEWAY_WAIT_INTERVAL_S=0.1
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() { return 1; }
sleep 30 &
GATEWAY_PID="$!"
printf 'listening on ws://127.0.0.1:18789\\n' >"$GATEWAY_LOG_PATH"
if wait_for_gateway; then
  echo "gateway readiness passed without TCP reachability" >&2
  cleanup_onboard_artifacts
  exit 1
fi
cleanup_onboard_artifacts
test ! -e "$ONBOARD_TMP_DIR"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      expect(result.stdout).toContain("Gateway failed to start");
      expect(result.stdout).toContain("TCP probe never succeeded");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects invalid onboarding gateway wait attempts before probing", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-onboard-gateway-attempts-"));
    const fixturePath = path.join(tempRoot, "gateway-attempts.sh");
    await writeFile(
      fixturePath,
      `#!/usr/bin/env bash
set -euo pipefail

export OPENCLAW_ONBOARD_SCENARIO_SOURCE_ONLY=1
export OPENCLAW_ONBOARD_E2E_TMPDIR=${JSON.stringify(tempRoot)}
export OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS=2x
OPENCLAW_ENTRY=node
source scripts/e2e/lib/onboard/scenario.sh

openclaw_e2e_probe_tcp() {
  echo "probe should not run" >&2
  return 1
}
set +e
wait_for_gateway
status="$?"
set -e
cleanup_onboard_artifacts
exit "$status"
`,
    );

    try {
      const result = spawnSync("bash", [fixturePath], {
        cwd: process.cwd(),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_ONBOARD_GATEWAY_WAIT_ATTEMPTS: 2x");
      expect(result.stderr).not.toContain("probe should not run");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("removes fallback ClawHub skill install HOME on failure", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-home-test-"));
    const fakeBin = path.join(tempRoot, "bin");
    const scratchRoot = path.join(tempRoot, "scratch");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(scratchRoot, { recursive: true });
    await writeFile(
      path.join(fakeBin, "pnpm"),
      `#!/usr/bin/env bash
exit 42
`,
      { mode: 0o755 },
    );

    try {
      const result = spawnSync("bash", ["scripts/e2e/lib/skills/clawhub-install-proof.sh"], {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_CURRENT_PACKAGE_TGZ: "",
          OPENCLAW_TEST_STATE_SCRIPT_B64: "",
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          TMPDIR: scratchRoot,
        },
      });

      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(42);
      const scratchEntries = await readdir(scratchRoot);
      expect(
        scratchEntries.filter((entry) => entry.startsWith("openclaw-skill-install-home.")),
      ).toEqual([]);
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });

  it("rejects ClawHub skill info paths that only share a resolved prefix", async () => {
    const tempRoot = await mkdtemp(path.join(tmpdir(), "openclaw-clawhub-info-path-"));
    const workspaceDir = path.join(tempRoot, "workspace");
    const slug = "demo";
    const skillDir = path.join(workspaceDir, "skills", slug);
    const escapedInfoPath = path.join(workspaceDir, "skills", `${slug}-escape`, "SKILL.md");
    const configPath = path.join(tempRoot, "openclaw.json");
    const originPath = path.join(skillDir, ".clawhub", "origin.json");
    const lockPath = path.join(workspaceDir, ".clawhub", "lock.json");
    const infoPath = path.join(tempRoot, "info.json");

    try {
      await mkdir(path.dirname(originPath), { recursive: true });
      await mkdir(path.dirname(lockPath), { recursive: true });
      await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: Demo\n---\n`);
      await writeFile(
        configPath,
        `${JSON.stringify({ skills: { install: { allowUploadedArchives: false } } })}\n`,
      );
      await writeFile(
        originPath,
        `${JSON.stringify({
          installedVersion: "1.0.0",
          registry: "https://clawhub.ai",
          slug,
        })}\n`,
      );
      await writeFile(
        lockPath,
        `${JSON.stringify({ skills: { [slug]: { version: "1.0.0" } } })}\n`,
      );
      await writeFile(
        infoPath,
        `${JSON.stringify({ filePath: escapedInfoPath, skillKey: "wrong-skill" })}\n`,
      );

      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-", configPath, skillDir, originPath, lockPath, infoPath, slug],
        {
          encoding: "utf8",
          input: await extractClawhubSkillInstallVerifier(),
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("skills info did not report installed skill demo");
    } finally {
      await rm(tempRoot, { force: true, recursive: true });
    }
  });
});
