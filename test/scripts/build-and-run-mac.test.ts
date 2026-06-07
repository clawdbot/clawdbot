// Build And Run Mac tests cover build and run mac script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const scriptPath = "scripts/build-and-run-mac.sh";
const tempRoots: string[] = [];

function runStopExistingLocalApp(params: { fakeLsof?: string; fakePgrep: string }) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-build-run-mac-test-"));
  tempRoots.push(root);
  const binDir = join(root, "bin");
  const killCallsPath = join(root, "kill-calls.txt");
  const pgrepCallsPath = join(root, "pgrep-calls.txt");
  mkdirSync(binDir);

  for (const [name, body] of [
    ["pgrep", params.fakePgrep],
    [
      "lsof",
      params.fakeLsof ??
        [
          "#!/usr/bin/env bash",
          "pid=''",
          "while [[ $# -gt 0 ]]; do",
          '  if [[ "$1" == "-p" ]]; then pid="$2"; shift 2; continue; fi',
          "  shift",
          "done",
          'printf "p%s\\n" "$pid"',
          'printf "n/worktree/apps/macos\\n"',
          "exit 0",
        ].join("\n"),
    ],
    [
      "sed",
      [
        "#!/usr/bin/env bash",
        'if [[ "$1" == "-n" && "$2" == "s/^n//p" ]]; then',
        "  /usr/bin/sed -n 's/^n//p'",
        "else",
        '  /usr/bin/sed "$@"',
        "fi",
      ].join("\n"),
    ],
    ["head", ["#!/usr/bin/env bash", 'exec /usr/bin/head "$@"'].join("\n")],
    ["sleep", "#!/usr/bin/env bash\nexit 0\n"],
  ] as const) {
    const toolPath = join(binDir, name);
    writeFileSync(toolPath, body);
    chmodSync(toolPath, 0o755);
  }

  const script = readFileSync(scriptPath, "utf8");
  const stopFunction = script.slice(
    script.indexOf("process_cwd_matches()"),
    script.indexOf('printf "\\n▶️  Building'),
  );
  const harnessPath = join(root, "stop-existing-local-app.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      'BIN_ABS="/worktree/apps/macos/.build-local/debug/OpenClaw"',
      'BIN=".build-local/debug/OpenClaw"',
      'APP_CWD="/worktree/apps/macos"',
      "kill() {",
      '  printf "%s\\n" "$*" >> "$OPENCLAW_TEST_KILL_CALLS"',
      '  touch "$OPENCLAW_TEST_KILLED_MARKER"',
      "  return 0",
      "}",
      stopFunction,
      "stop_existing_local_app",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  const result = spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TEST_KILLED_MARKER: join(root, "killed"),
      OPENCLAW_TEST_KILL_CALLS: killCallsPath,
      OPENCLAW_TEST_PGREP_CALLS: pgrepCallsPath,
      OPENCLAW_TEST_PGREP_COUNT: join(root, "pgrep-count.txt"),
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  const killCalls = existsSync(killCallsPath) ? readFileSync(killCallsPath, "utf8") : "";
  const pgrepCalls = existsSync(pgrepCallsPath) ? readFileSync(pgrepCallsPath, "utf8") : "";
  return { killCalls, pgrepCalls, result };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/build-and-run-mac.sh", () => {
  it("keeps launch logs isolated unless an explicit log path is provided", () => {
    const script = readFileSync(scriptPath, "utf8");

    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_MAC_RUN_LOG:-$(mktemp "${TMPDIR:-/tmp}/openclaw-${PRODUCT}.XXXXXX.log")}"',
    );
    expect(script).toContain('nohup "$BIN_ABS" >"$LOG_PATH" 2>&1 &');
    expect(script).toContain('printf "Started $PRODUCT (PID $PID). Logs: $LOG_PATH\\n"');
    expect(script).not.toContain("/tmp/openclaw.log");
  });

  it("stops only the local debug app binary before relaunching", () => {
    const script = readFileSync(scriptPath, "utf8");
    const { killCalls, pgrepCalls, result } = runStopExistingLocalApp({
      fakePgrep: [
        "#!/usr/bin/env bash",
        `printf '%s\\n' "$*" >> "$OPENCLAW_TEST_PGREP_CALLS"`,
        'count="$(cat "$OPENCLAW_TEST_PGREP_COUNT" 2>/dev/null || echo 0)"',
        'next="$((count + 1))"',
        'printf "%s\\n" "$next" > "$OPENCLAW_TEST_PGREP_COUNT"',
        'if [[ "$2" == "/worktree/apps/macos/.build-local/debug/OpenClaw" ]]; then exit 1; fi',
        'if [[ "$2" == ".build-local/debug/OpenClaw" && "$count" == "1" ]]; then echo 321; exit 0; fi',
        "exit 1",
      ].join("\n"),
    });

    expect(result.status).toBe(0);
    expect(killCalls).toBe("321\n");
    expect(pgrepCalls).toContain("-f /worktree/apps/macos/.build-local/debug/OpenClaw");
    expect(pgrepCalls).toContain("-f .build-local/debug/OpenClaw");
    expect(script).toContain('BIN_ABS="$(pwd)/$BIN"');
    expect(script).toContain('pgrep -f "$BIN_ABS"');
    expect(script).toContain('pgrep -f "$BIN"');
    expect(script).toContain('kill "$pid"');
    expect(script).not.toContain('killall -q "$PRODUCT"');
    expect(script).not.toContain("pkill");
  });

  it("fails when the scoped local app process survives cleanup", () => {
    const { result } = runStopExistingLocalApp({
      fakePgrep: [
        "#!/usr/bin/env bash",
        'if [[ "$2" == ".build-local/debug/OpenClaw" ]]; then echo 321; exit 0; fi',
        "exit 1",
      ].join("\n"),
    });

    expect(result.status).toBe(1);
  });
});
