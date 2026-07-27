// Restart Mac tests cover restart mac script behavior.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const helperPath = "scripts/lib/restart-mac-gateway.sh";
const restartScriptPath = "scripts/restart-mac.sh";
const tempRoots: string[] = [];

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function runGatewayPortCheck(fakeLsof: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const lsofPath = join(binDir, "lsof");
  writeFileSync(lsofPath, fakeLsof);
  chmodSync(lsofPath, 0o755);

  return spawnSync(
    "bash",
    ["-c", `source ${shellQuote(helperPath)}; verify_gateway_port_listening 18789`],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
      },
    },
  );
}

function runCleanupFunction(fakePs: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const binDir = join(root, "bin");
  const killCallsPath = join(root, "kill-calls.txt");
  mkdirSync(binDir);
  for (const [name, body] of [
    ["ps", fakePs],
    ["sleep", "#!/usr/bin/env bash\nexit 0\n"],
  ] as const) {
    const toolPath = join(binDir, name);
    writeFileSync(toolPath, body);
    chmodSync(toolPath, 0o755);
  }

  const script = readFileSync(restartScriptPath, "utf8");
  const cleanupFunction = script.slice(
    script.indexOf("kill_all_openclaw()"),
    script.indexOf("stop_launch_agent()"),
  );
  const harnessPath = join(root, "cleanup-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      cleanupFunction,
      'ROOT_DIR="/worktree"',
      'APP_BUNDLE=""',
      'APP_EXECUTABLE_RELATIVE_PATH="Contents/MacOS/OpenClaw"',
      'DEBUG_PROCESS_PATTERN="/worktree/apps/macos/.build/debug/OpenClaw"',
      'LOCAL_PROCESS_PATTERN="/worktree/apps/macos/.build-local/debug/OpenClaw"',
      'RELEASE_PROCESS_PATTERN="/worktree/apps/macos/.build/release/OpenClaw"',
      "kill() {",
      '  printf "%s\\n" "$*" >> "$OPENCLAW_TEST_KILL_CALLS"',
      "  return 0",
      "}",
      "kill_all_openclaw",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  const result = spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TEST_KILL_CALLS: killCallsPath,
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  const killCalls = existsSync(killCallsPath) ? readFileSync(killCallsPath, "utf8") : "";
  return { killCalls, result };
}

function runManagedSupervisorClassifier(
  records: Array<{ domain: string; label: string; program: string; properties?: string }>,
  options: { failEnumeration?: boolean } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-supervisor-test-"));
  tempRoots.push(root);
  const recordsPath = join(root, "loaded-jobs.txt");
  writeFileSync(
    recordsPath,
    records
      .map(
        (record) => `${record.domain}|${record.label}|${record.program}|${record.properties ?? ""}`,
      )
      .join("\n"),
  );

  const script = readFileSync(restartScriptPath, "utf8");
  const classifierFunctions = script.slice(
    script.indexOf("print_managed_openclaw_supervisor_label()"),
    script.indexOf("kill_managed_openclaw()"),
  );
  const harnessPath = join(root, "supervisor-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      classifierFunctions,
      "loaded_launch_jobs() {",
      '  [[ "${OPENCLAW_TEST_FAIL_ENUMERATION:-0}" != "1" ]] || return 1',
      "  cut -d'|' -f1,2 \"$OPENCLAW_TEST_LOADED_JOBS\"",
      "}",
      "launch_job_snapshot() {",
      '  grep "^$1|$2|" "$OPENCLAW_TEST_LOADED_JOBS" |',
      "    awk -F'|' '{ print \"program = \" $3; print \"properties = \" $4 }'",
      "}",
      'TARGET_EXECUTABLE="/worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw"',
      'INSTALLED_EXECUTABLE="/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"',
      "managed_openclaw_supervisor_labels",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);
  return spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_TEST_FAIL_ENUMERATION: options.failEnumeration ? "1" : "0",
      OPENCLAW_TEST_LOADED_JOBS: recordsPath,
    },
  });
}

function runCanonicalizeAppBundle(appBundle: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const script = readFileSync(restartScriptPath, "utf8");
  const canonicalizeFunction = script.slice(
    script.indexOf("canonicalize_app_bundle()"),
    script.indexOf("trap cleanup"),
  );
  const harnessPath = join(root, "canonicalize-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      canonicalizeFunction,
      'APP_BUNDLE="$1"',
      "fail() {",
      "  printf 'ERROR: %s\\n' \"$*\" >&2",
      "  exit 1",
      "}",
      "canonicalize_app_bundle",
      'printf "%s\\n" "$APP_BUNDLE"',
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  return {
    result: spawnSync("bash", [harnessPath, appBundle], { cwd: root, encoding: "utf8" }),
    root,
  };
}

function runRestartArgParser(...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const script = readFileSync(restartScriptPath, "utf8");
  const parserBlock = script.slice(
    script.indexOf('for arg in "$@"; do'),
    script.indexOf('if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]'),
  );
  const harnessPath = join(root, "arg-parser-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "WAIT_FOR_LOCK=0",
      "NO_SIGN=0",
      "SIGN=0",
      "AUTO_DETECT_SIGNING=1",
      "ATTACH_ONLY=1",
      "BACKGROUND_ONLY=0",
      "TARGET_ONLY=0",
      'log() { printf "%s\\n" "$*"; }',
      'fail() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }',
      parserBlock,
      'printf "wait=%s no_sign=%s sign=%s attach_only=%s background_only=%s target_only=%s\\n" "$WAIT_FOR_LOCK" "$NO_SIGN" "$SIGN" "$ATTACH_ONLY" "$BACKGROUND_ONLY" "$TARGET_ONLY"',
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  return spawnSync("bash", [harnessPath, ...args], { encoding: "utf8" });
}

function runLaunchArgBuilder(...args: string[]) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const script = readFileSync(restartScriptPath, "utf8");
  const parserBlock = script.slice(
    script.indexOf('for arg in "$@"; do'),
    script.indexOf('if [[ "$NO_SIGN" -eq 1 && "$SIGN" -eq 1 ]]'),
  );
  const appLaunchArgBlock = script.slice(
    script.indexOf("APP_LAUNCH_ARGS=()"),
    script.indexOf('if [[ "$TARGET_ONLY" -eq 1 ]]; then', script.indexOf("APP_LAUNCH_ARGS=()")),
  );
  const openArgBlock = script.slice(
    script.indexOf('OPEN_ARGS=(-n "${APP_BUNDLE}")'),
    script.indexOf("# 4) Launch"),
  );
  const harnessPath = join(root, "launch-arg-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/bin/bash",
      "set -euo pipefail",
      "WAIT_FOR_LOCK=0",
      "NO_SIGN=0",
      "SIGN=0",
      "AUTO_DETECT_SIGNING=1",
      "ATTACH_ONLY=1",
      "BACKGROUND_ONLY=0",
      "TARGET_ONLY=0",
      'APP_BUNDLE="/tmp/OpenClaw.app"',
      'log() { printf "%s\\n" "$*"; }',
      'fail() { printf "ERROR: %s\\n" "$*" >&2; exit 1; }',
      parserBlock,
      appLaunchArgBlock,
      openArgBlock,
      'printf "<%s>\\n" "${OPEN_ARGS[@]}"',
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  return spawnSync("/bin/bash", [harnessPath, ...args], { encoding: "utf8" });
}

function runRestartLockHarness(lockDir: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);

  const script = readFileSync(restartScriptPath, "utf8");
  const lockBlock = script.slice(
    script.indexOf("cleanup()"),
    script.indexOf("check_signing_keys()"),
  );
  const harnessPath = join(root, "lock-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      `LOCK_DIR=${shellQuote(lockDir)}`,
      'LOCK_PID_FILE="${LOCK_DIR}/pid"',
      "LOCK_HELD=0",
      "WAIT_FOR_LOCK=0",
      'log() { printf "%s\\n" "$*"; }',
      lockBlock,
      "trap cleanup EXIT",
      "acquire_lock",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);

  return spawnSync("bash", [harnessPath], { encoding: "utf8" });
}

function runForeignProcessClassifier(fakePs: string) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
  tempRoots.push(root);
  const binDir = join(root, "bin");
  mkdirSync(binDir);
  const psPath = join(binDir, "ps");
  writeFileSync(psPath, fakePs);
  chmodSync(psPath, 0o755);

  const script = readFileSync(restartScriptPath, "utf8");
  const functions = script.slice(
    script.indexOf("process_pids_matching()"),
    script.indexOf("stop_launch_agent()"),
  );
  const harnessPath = join(root, "foreign-process-harness.sh");
  writeFileSync(
    harnessPath,
    [
      "#!/usr/bin/env bash",
      functions,
      'APP_EXECUTABLE_RELATIVE_PATH="Contents/MacOS/OpenClaw"',
      'TARGET_EXECUTABLE="/Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw"',
      'INSTALLED_EXECUTABLE="/Applications/OpenClaw.app/Contents/MacOS/OpenClaw"',
      "foreign_openclaw_process_pids",
    ].join("\n"),
  );
  chmodSync(harnessPath, 0o755);
  return spawnSync("bash", [harnessPath], {
    encoding: "utf8",
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ""}` },
  });
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/restart-mac.sh", () => {
  it("rejects unknown restart options before side effects", () => {
    const result = runRestartArgParser("--wat");

    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("ERROR: Unknown restart option: --wat");
  });

  it("parses restart mode flags before side effects", () => {
    const result = runRestartArgParser("--wait", "--no-sign", "--background-only", "--target-only");

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(
      "wait=1 no_sign=1 sign=0 attach_only=1 background_only=1 target_only=1",
    );
    expect(result.stderr).toBe("");
  });

  it("fails closed when loaded launchd jobs cannot be enumerated", () => {
    const result = runManagedSupervisorClassifier([], { failEnumeration: true });

    expect(result.status).toBe(1);
  });

  it("fails the gateway verification when lsof finds no listener", () => {
    const result = runGatewayPortCheck("#!/usr/bin/env bash\nexit 1\n");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No process is listening on gateway port 18789.");
    expect(result.stdout).toBe("");
  });

  it("prints listener diagnostics when the gateway port is open", () => {
    const result = runGatewayPortCheck(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' 'COMMAND   PID USER   FD   TYPE DEVICE SIZE/OFF NODE NAME'",
        "printf '%s\\n' 'node    12345 user   21u  IPv4 0x123      0t0  TCP 127.0.0.1:18789 (LISTEN)'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("127.0.0.1:18789 (LISTEN)");
    expect(result.stderr).toBe("");
  });

  it("uses a fail-closed gateway port verification helper", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain('source "${ROOT_DIR}/scripts/lib/restart-mac-gateway.sh"');
    expect(script).toContain(
      'run_step "verify gateway port ${GATEWAY_PORT} (unsigned)" verify_gateway_port_listening "${GATEWAY_PORT}"',
    );
    expect(script).not.toContain("lsof -iTCP:${GATEWAY_PORT} -sTCP:LISTEN | head -n 5 || true");
  });

  it("avoids login-shell noise and early-exit pipe warnings", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).not.toContain("bash -lc");
    expect(script).not.toContain(`printf '%s\\n' "\${job}" | /usr/bin/awk`);
    expect(script).toContain("/usr/bin/awk -F ' = '");
  });

  it("keeps the default restart log scoped to the current worktree lock", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_RESTART_LOG:-${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}.log}"',
    );
    expect(script).not.toContain('LOG_PATH="${OPENCLAW_RESTART_LOG:-/tmp/openclaw-restart.log}"');
  });

  it("does not remove a live restart lock it did not acquire", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
    tempRoots.push(root);
    const lockDir = join(root, "openclaw-restart-lock");
    mkdirSync(lockDir);
    writeFileSync(join(lockDir, "pid"), String(process.pid), "utf8");

    const result = runRestartLockHarness(lockDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(
      `Another restart is running (pid ${process.pid}); re-run with --wait.`,
    );
    expect(result.stderr).toBe("");
    expect(existsSync(lockDir)).toBe(true);
    expect(readFileSync(join(lockDir, "pid"), "utf8")).toBe(String(process.pid));
  });

  it("removes the restart lock it acquired", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
    tempRoots.push(root);
    const lockDir = join(root, "openclaw-restart-lock");

    const result = runRestartLockHarness(lockDir);

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("prefers the freshly packaged app unless an explicit app bundle is set", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const chooseBlock = script.slice(
      script.indexOf("choose_app_bundle()"),
      script.indexOf("choose_app_bundle", script.indexOf("choose_app_bundle()") + 1),
    );

    expect(script).toContain('fail "OPENCLAW_APP_BUNDLE does not exist: ${APP_BUNDLE}"');
    expect(chooseBlock).toContain("canonicalize_app_bundle");
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("/Applications/OpenClaw.app")).toBeGreaterThan(-1);
    expect(chooseBlock.indexOf("${ROOT_DIR}/dist/OpenClaw.app")).toBeLessThan(
      chooseBlock.indexOf("/Applications/OpenClaw.app"),
    );
  });

  it("keeps restart cleanup scoped to known OpenClaw app and build paths", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const cleanupBlock = script.slice(
      script.indexOf("kill_all_openclaw()"),
      script.indexOf("stop_launch_agent()"),
    );

    expect(cleanupBlock).toContain("ps axww -o pid=,command=");
    expect(cleanupBlock).toContain(
      '"${ROOT_DIR}/dist/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}"',
    );
    expect(cleanupBlock).toContain('"/Applications/OpenClaw.app/${APP_EXECUTABLE_RELATIVE_PATH}"');
    expect(cleanupBlock).toContain('"${DEBUG_PROCESS_PATTERN}"');
    expect(cleanupBlock).toContain('"${LOCAL_PROCESS_PATTERN}"');
    expect(cleanupBlock).toContain('"${RELEASE_PROCESS_PATTERN}"');
    expect(cleanupBlock).not.toContain("APP_PROCESS_PATTERN");
    expect(cleanupBlock).not.toContain("pkill");
    expect(cleanupBlock).not.toContain('pkill -x "OpenClaw"');
    expect(cleanupBlock).not.toContain("pgrep");
    expect(cleanupBlock).not.toContain('pgrep -x "OpenClaw"');
  });

  it("stops launchd supervision before killing app processes", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const stopIndex = script.indexOf("stop_launch_agent\n  log");
    const killIndex = script.indexOf("if ! kill_all_openclaw");

    expect(stopIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(killIndex);
  });

  it("target-only mode refuses foreign app processes without broad cleanup", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const initialTargetBlock = script.slice(
      script.indexOf('if [[ "$TARGET_ONLY" -eq 1 ]]; then', script.indexOf("# 1)")),
      script.indexOf("else", script.indexOf("# 1)")),
    );
    const switchTargetBlock = script.slice(
      script.indexOf('if [[ "$TARGET_ONLY" -eq 1 ]]; then', script.indexOf("APP_LAUNCH_ARGS")),
      script.indexOf("# 4) Launch"),
    );

    expect(initialTargetBlock).toContain("foreign_openclaw_process_pids");
    expect(initialTargetBlock).not.toContain("kill_managed_openclaw");
    expect(initialTargetBlock).not.toContain("stop_launch_agent");
    expect(initialTargetBlock).not.toContain("kill_all_openclaw");
    expect(switchTargetBlock).toContain("foreign_openclaw_process_pids");
    expect(switchTargetBlock).toContain("kill_managed_openclaw");
    expect(script).toContain('[[ "${executable}" == "${TARGET_EXECUTABLE}" ]] && continue');
    expect(script).toContain('process_pids_for_executable "${TARGET_EXECUTABLE}"');
    expect(script).toContain("target-only restart deferred");
  });

  it("passes background-only through to the launched app", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain("APP_LAUNCH_ARGS+=(--background-only)");
    expect(script).toContain('OPEN_ARGS+=(--args "${APP_LAUNCH_ARGS[@]}")');
    expect(script).toContain('/usr/bin/open "${OPEN_ARGS[@]}"');
  });

  it("keeps no-attach-only launches nounset-safe on the macOS system Bash", () => {
    const result = runLaunchArgBuilder("--no-attach-only");

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim()).toBe("<-n>\n</tmp/OpenClaw.app>");
  });

  it("finds persistent launchd supervisors across explicit domains", () => {
    const result = runManagedSupervisorClassifier([
      {
        domain: "gui/501",
        label: "ai.openclaw.mac.custom",
        program: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
        properties: "keepalive | runatload",
      },
      {
        domain: "user/501",
        label: "ai.openclaw.mac.target",
        program: "/worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw",
        properties: "keepalive",
      },
      {
        domain: "gui/501",
        label: "application.ai.openclaw.mac.123",
        program: "/Applications/OpenClaw.app/Contents/MacOS/OpenClaw",
      },
      {
        domain: "system",
        label: "com.example.other",
        program: "/Applications/Other.app/Contents/MacOS/Other",
        properties: "keepalive",
      },
    ]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim().split("\n").toSorted()).toEqual([
      "ai.openclaw.mac.custom",
      "ai.openclaw.mac.target",
    ]);
    expect(result.stderr).toBe("");
  });

  it("checks managed launchd supervisors before starting the Swift package build", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const supervisorIndex = script.indexOf(
      'managed_supervisors="$(managed_openclaw_supervisor_labels',
    );
    const packageIndex = script.indexOf('run_step "package app"');

    expect(supervisorIndex).toBeGreaterThan(-1);
    expect(packageIndex).toBeGreaterThan(supervisorIndex);
    expect(script).toContain("Unable to inspect loaded launchd jobs");
    expect(script).toContain("stop those jobs before a target-only restart");
  });

  it("lets the packager own the single incremental Swift product build", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).not.toContain('run_step "clean build cache"');
    expect(script).not.toContain('run_step "swift build"');
    expect(script).toContain('run_step "package app"');
  });

  it("keeps the managed app alive until the signed replacement is ready", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const packageIndex = script.indexOf('run_step "package app"');
    const verifyIndex = script.indexOf('run_step "verify packaged app"');
    const switchIndex = script.indexOf('log "==> Switching managed installed');
    const installIndex = script.indexOf('run_step "install packaged app"');
    const launchIndex = script.indexOf('run_step "launch app"');

    expect(packageIndex).toBeGreaterThan(-1);
    expect(script).toContain('OPENCLAW_PACKAGE_APP_ROOT="${STAGED_APP_BUNDLE}"');
    expect(verifyIndex).toBeGreaterThan(packageIndex);
    expect(switchIndex).toBeGreaterThan(packageIndex);
    expect(installIndex).toBeGreaterThan(switchIndex);
    expect(launchIndex).toBeGreaterThan(installIndex);
    expect(launchIndex).toBeGreaterThan(switchIndex);
  });

  it("restores the previous bundle if the staged install cannot complete", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const installBlock = script.slice(
      script.indexOf("install_staged_app()"),
      script.indexOf("choose_app_bundle()"),
    );

    expect(installBlock).toContain('mv "${TARGET_APP_BUNDLE}" "${previous}"');
    expect(installBlock).toContain('if ! mv "${STAGED_APP_BUNDLE}" "${TARGET_APP_BUNDLE}"');
    expect(installBlock).toContain('mv "${previous}" "${TARGET_APP_BUNDLE}"');
  });

  it("escalates only exact managed app processes when graceful shutdown stalls", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const managedKillBlock = script.slice(
      script.indexOf("kill_managed_openclaw()"),
      script.indexOf("stop_launch_agent()"),
    );
    const broadKillBlock = script.slice(
      script.indexOf("kill_all_openclaw()"),
      script.indexOf("known_openclaw_executables()"),
    );

    expect(managedKillBlock).toContain('kill -KILL "${pid}"');
    expect(managedKillBlock).toContain("managed_openclaw_process_pids");
    expect(broadKillBlock).not.toContain("kill -KILL");
  });

  it("treats the canonical installed app as managed but temp bundles as foreign", () => {
    const result = runForeignProcessClassifier(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  101 /Applications/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  102 /Users/steipete/openclaw/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  103 /tmp/agent/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "printf '%s\\n' '  104 /bin/sh test.sh /Applications/OpenClaw.app/Contents/MacOS/OpenClaw'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("103");
    expect(result.stderr).toBe("");
  });

  it("verifies the launched app through the chosen bundle executable", () => {
    const script = readFileSync(restartScriptPath, "utf8");
    const verifyBlock = script.slice(script.indexOf("# 5) Verify the app is alive."));

    expect(verifyBlock).toContain(
      'process_pids_matching "${APP_BUNDLE}/${APP_EXECUTABLE_RELATIVE_PATH}"',
    );
    expect(verifyBlock).not.toContain("APP_PROCESS_PATTERN");
    expect(verifyBlock).not.toContain("pgrep");
  });

  it("forces LaunchServices to start the selected app bundle", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain('OPEN_ARGS=(-n "${APP_BUNDLE}")');
    expect(script).toContain('/usr/bin/open "${OPEN_ARGS[@]}"');
    expect(script.indexOf("\nchoose_app_bundle\n")).toBeLessThan(
      script.indexOf('OPEN_ARGS=(-n "${APP_BUNDLE}")'),
    );
  });

  it("normalizes custom app bundle paths before process matching", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-restart-mac-test-"));
    tempRoots.push(root);
    const appBundle = join(root, "dist", "OpenClaw.app");
    mkdirSync(appBundle, { recursive: true });

    const { result } = runCanonicalizeAppBundle(`${appBundle}/../OpenClaw.app/`);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe(realpathSync(appBundle));
    expect(result.stderr).toBe("");
  });

  it("fails restart cleanup when scoped processes survive every kill attempt", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  321 /worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
      ].join("\n"),
    );

    expect(result.status).toBe(1);
    expect(killCalls).toContain("321\n");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("passes restart cleanup when the final kill attempt clears the process", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        'kill_count="$(wc -l < "$OPENCLAW_TEST_KILL_CALLS" 2>/dev/null || echo 0)"',
        'if [[ "$kill_count" -lt 10 ]]; then',
        "  printf '%s\\n' '  321 /worktree/dist/OpenClaw.app/Contents/MacOS/OpenClaw --attach-only'",
        "fi",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(killCalls.trim().split(/\r?\n/u)).toHaveLength(10);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("passes restart cleanup when scoped processes are gone", () => {
    const { killCalls, result } = runCleanupFunction("#!/usr/bin/env bash\nexit 0\n");

    expect(result.status).toBe(0);
    expect(killCalls).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  it("does not kill unrelated OpenClaw app bundles", () => {
    const { killCalls, result } = runCleanupFunction(
      [
        "#!/usr/bin/env bash",
        "printf '%s\\n' '  654 /tmp/Other/OpenClaw.app/Contents/MacOS/OpenClaw'",
      ].join("\n"),
    );

    expect(result.status).toBe(0);
    expect(killCalls).toBe("");
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});
