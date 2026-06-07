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

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { force: true, recursive: true });
  }
});

describe("scripts/restart-mac.sh", () => {
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

  it("keeps the default restart log scoped to the current worktree lock", () => {
    const script = readFileSync(restartScriptPath, "utf8");

    expect(script).toContain(
      'LOG_PATH="${OPENCLAW_RESTART_LOG:-${TMPDIR:-/tmp}/openclaw-restart-${LOCK_KEY}.log}"',
    );
    expect(script).not.toContain('LOG_PATH="${OPENCLAW_RESTART_LOG:-/tmp/openclaw-restart.log}"');
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
    const stopIndex = script.indexOf("stop_launch_agent\nlog");
    const killIndex = script.indexOf("if ! kill_all_openclaw");

    expect(stopIndex).toBeGreaterThan(-1);
    expect(killIndex).toBeGreaterThan(-1);
    expect(stopIndex).toBeLessThan(killIndex);
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

    expect(script).toContain('/usr/bin/open -n "${APP_BUNDLE}"');
    expect(script).not.toContain('/usr/bin/open "${APP_BUNDLE}"');
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
