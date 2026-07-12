// Crabbox Wrapper tests cover crabbox wrapper script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canonicalProviderName,
  isProviderAdvertised,
  parseProvidersFromHelp,
} from "../../scripts/crabbox-wrapper-providers.mjs";

const tempDirs: string[] = [];
const repoRoot = process.cwd();
const fakeCrabboxBinDirs = new Map<string, string>();
const fakeGitBinDirs = new Map<string, string>();
const timingPreloads = new Map<string, string>();
const GIT_COMMON_DIR_KEY = "rev-parse\u0000--git-common-dir";
const GIT_CONFIG_SPARSE_KEY = "config\u0000--bool\u0000core.sparseCheckout";
const GIT_SPARSE_LIST_KEY = "sparse-checkout\u0000list";
const GIT_STATUS_PORCELAIN_KEY = "status\u0000--porcelain=v1";
const GIT_MERGE_BASE_MAIN_HEAD_KEY = "merge-base\u0000origin/main\u0000HEAD";
const defaultGitResponses: Record<string, { status?: number; stdout?: string; stderr?: string }> = {
  [GIT_CONFIG_SPARSE_KEY]: { stdout: "false\n" },
  [GIT_SPARSE_LIST_KEY]: { status: 1 },
};

function makeFakeCrabbox(helpText: string): string {
  const cached = fakeCrabboxBinDirs.get(helpText);
  if (cached) {
    return cached;
  }
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-crabbox-"));
  tempDirs.push(binDir);
  writeFakeCrabbox(binDir, helpText);
  fakeCrabboxBinDirs.set(helpText, binDir);
  return binDir;
}

function writeFakeCrabbox(binDir: string, helpText: string): string {
  mkdirSync(binDir, { recursive: true });
  const crabboxPath = path.join(binDir, "crabbox");
  const helperPath = path.join(binDir, "fake-crabbox-json.cjs");

  if (process.platform !== "win32") {
    const signalIgnoringDescendantScript = [
      "process.on('SIGHUP', () => {});",
      "process.on('SIGINT', () => {});",
      "process.on('SIGTERM', () => {});",
      "setInterval(() => {}, 1000);",
    ].join("");
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then',
      '  printf "%s\\n" "${OPENCLAW_FAKE_CRABBOX_VERSION:-crabbox 0.22.1}"',
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ] && [ "$2" = "--help" ]; then',
      `  printf "%s" ${shellSingleQuote(helpText)}`,
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ] && [ -n "${OPENCLAW_FAKE_CRABBOX_RUN_STATUS:-}" ] && [ "$OPENCLAW_FAKE_CRABBOX_RUN_STATUS" != "0" ]; then',
      '  printf "%s\\n" "fake run failure" >&2',
      '  exit "$OPENCLAW_FAKE_CRABBOX_RUN_STATUS"',
      "fi",
      'if [ "$1" = "config" ] && [ "$2" = "show" ]; then',
      '  for arg in "$@"; do',
      '    if [ "$arg" = "--json" ]; then',
      '      status="${OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS:-0}"',
      '      if [ "$status" != "0" ]; then',
      '        printf "%s\\n" "config unavailable" >&2',
      '        exit "$status"',
      "      fi",
      '      if [ -n "${OPENCLAW_FAKE_CRABBOX_CONFIG_JSON+x}" ]; then',
      '        printf "%s" "$OPENCLAW_FAKE_CRABBOX_CONFIG_JSON"',
      "      else",
      '        printf "%s" "{\\"coordinator\\":\\"configured-broker\\",\\"brokerAuth\\":\\"configured\\"}"',
      "      fi",
      "      exit 0",
      "    fi",
      "  done",
      "fi",
      'if [ "$1" = "whoami" ]; then',
      '  status="${OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS:-0}"',
      '  if [ "$status" != "0" ]; then',
      '    printf "%s\\n" "coordinator GET /v1/whoami: http 401: {\\"error\\":\\"unauthorized\\"}" >&2',
      '    exit "$status"',
      "  fi",
      '  printf "%s\\n" "fake-crabbox-user"',
      "  exit 0",
      "fi",
      'for arg in "$@"; do',
      '  if [ "$arg" = "--artifact-glob" ] || [ "$arg" = "-artifact-glob" ]; then',
      "    mkdir -p .crabbox/runs/run_fake",
      '    printf "%s\\n" "fake artifact" > .crabbox/runs/run_fake/fake-artifacts.tgz',
      "  fi",
      "done",
      'script_path=""',
      'previous_arg=""',
      'for arg in "$@"; do',
      '  if [ "$previous_arg" = "--script" ] || [ "$previous_arg" = "-script" ]; then',
      '    script_path="$arg"',
      "    break",
      "  fi",
      '  previous_arg="$arg"',
      "done",
      'if [ "${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT:-}" = "1" ]; then',
      // Let the wrapper finish its synchronous keepalive check so this fixture
      // exercises the post-exit checkout guard, not the active-child monitor.
      "  sleep 0.1",
      '  deleted_cwd="$PWD"',
      "  cd / || exit 1",
      '  rm -rf "$deleted_cwd"',
      "  exit 0",
      "fi",
      'if [ "${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE:-}" = "1" ]; then',
      '  deleted_cwd="$PWD"',
      "  cd / || exit 1",
      '  rm -rf "$deleted_cwd"',
      // Fail-safe only: the wrapper normally kills this child mid-loop. The
      // deadline just has to outlast wrapper timer starvation under
      // parallel-suite load, or the child exits 66 before the wrapper reacts
      // and the test asserts on the wrong stderr message.
      "  deadline=1000",
      '  while [ "$deadline" -gt 0 ] && [ ! -d "$deleted_cwd" ]; do',
      "    deadline=$((deadline - 1))",
      "    sleep 0.01",
      "  done",
      '  if [ ! -d "$deleted_cwd" ]; then',
      '    printf "%s\\n" "cwd was not restored: $deleted_cwd" >&2',
      "    exit 66",
      "  fi",
      '  cd "$deleted_cwd" || exit 1',
      "fi",
      'if [ -n "${OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH:-}" ]; then',
      `  ${shellSingleQuote(process.execPath)} --input-type=module --eval ${shellSingleQuote(signalIgnoringDescendantScript)} &`,
      '  printf "%s" "$!" > "$OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH"',
      '  trap "exit 0" INT TERM HUP',
      "  while :; do sleep 1; done",
      "fi",
      'printf "%s\\0" "__OPENCLAW_FAKE_CRABBOX_V1__"',
      'printf "%s\\0" "$PWD"',
      'printf "%s\\0" "$#"',
      'for arg in "$@"; do',
      '  printf "%s\\0" "$arg"',
      "done",
      'if [ -n "$script_path" ] && [ -f "$script_path" ]; then',
      '  cat "$script_path"',
      "fi",
    ].join("\n");
    writeFileSync(crabboxPath, `${script}\n`, "utf8");
    chmodSync(crabboxPath, 0o755);
    return crabboxPath;
  }

  const helperScript = [
    "const args = process.argv.slice(2);",
    'if (args[0] === "config" && args[1] === "show" && args.includes("--json")) {',
    "  const status = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS || '0', 10);",
    "  if (status !== 0) {",
    "    process.stderr.write('config unavailable\\n');",
    "    process.exit(status);",
    "  }",
    '  process.stdout.write(process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_JSON || \'{"coordinator":"configured-broker","brokerAuth":"configured"}\');',
    "  process.exit(0);",
    "}",
    'if (args[0] === "whoami") {',
    "  const status = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS || '0', 10);",
    "  if (status !== 0) {",
    '    process.stderr.write(\'coordinator GET /v1/whoami: http 401: {"error":"unauthorized"}\\n\');',
    "    process.exit(status);",
    "  }",
    "  process.stdout.write('fake-crabbox-user\\n');",
    "  process.exit(0);",
    "}",
    "const scriptIndex = args.findIndex((arg) => arg === '--script' || arg === '-script');",
    "const scriptPath = scriptIndex >= 0 ? args[scriptIndex + 1] : '';",
    "const scriptContent = scriptPath ? require('node:fs').readFileSync(scriptPath, 'utf8') : '';",
    "if (args.includes('--artifact-glob') || args.includes('-artifact-glob')) {",
    "  require('node:fs').mkdirSync('.crabbox/runs/run_fake', { recursive: true });",
    "  require('node:fs').writeFileSync('.crabbox/runs/run_fake/fake-artifacts.tgz', 'fake artifact\\n');",
    "}",
    "console.log(JSON.stringify({ args, cwd: process.cwd(), scriptContent }));",
  ].join("\n");
  writeFileSync(helperPath, `${helperScript}\n`, "utf8");

  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") {',
    "  console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || 'crabbox 0.22.1');",
    "  process.exit(0);",
    "}",
    'if (args[0] === "run" && args[1] === "--help") {',
    `  process.stdout.write(${JSON.stringify(helpText)});`,
    "  process.exit(0);",
    "}",
    'if (args[0] === "run" && Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_RUN_STATUS || "0", 10) !== 0) {',
    "  process.stderr.write('fake run failure\\n');",
    "  process.exit(Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_RUN_STATUS, 10));",
    "}",
    `require(${JSON.stringify(helperPath)});`,
  ].join("\n");
  writeFileSync(crabboxPath, `${script}\n`, "utf8");
  writeFileSync(`${crabboxPath}.cmd`, windowsNodeCmdShim("crabbox"), "utf8");
  chmodSync(crabboxPath, 0o755);
  return crabboxPath;
}

function makeSlowVersionCrabbox(helpText: string): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-slow-crabbox-"));
  tempDirs.push(binDir);
  const crabboxPath = path.join(binDir, "crabbox");

  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    'if (args[0] === "--version") { setTimeout(() => process.exit(0), 1_000); }',
    `else if (args[0] === "run" && args[1] === "--help") { process.stdout.write(${JSON.stringify(helpText)}); }`,
  ].join("\n");
  writeFileSync(crabboxPath, `${script}\n`, "utf8");
  writeFileSync(`${crabboxPath}.cmd`, windowsNodeCmdShim("crabbox"), "utf8");
  chmodSync(crabboxPath, 0o755);
  return binDir;
}

// Fake Crabbox whose `run --help` is slow on every call and, like real Crabbox
// 0.36, renders the provider help to stderr. Used to prove the wrapper retries a
// cold/slow metadata probe instead of hard-failing.
function makeSlowHelpCrabbox(helpText: string, delayMs: number): string {
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-slow-help-crabbox-"));
  tempDirs.push(binDir);
  const crabboxPath = path.join(binDir, "crabbox");

  const script = [
    "#!/usr/bin/env node",
    "const args = process.argv.slice(2);",
    "if (args[0] === '--version') {",
    "  console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || 'crabbox 0.22.1');",
    "  process.exit(0);",
    "} else if (args[0] === 'run' && args[1] === '--help') {",
    `  setTimeout(() => { process.stderr.write(${JSON.stringify(helpText)}); process.exit(0); }, ${delayMs});`,
    "} else {",
    "  process.exit(0);",
    "}",
  ].join("\n");
  writeFileSync(crabboxPath, `${script}\n`, "utf8");
  writeFileSync(`${crabboxPath}.cmd`, windowsNodeCmdShim("crabbox"), "utf8");
  chmodSync(crabboxPath, 0o755);
  return binDir;
}

function testTimingPreload(options: { clockScale?: number; spawnTimeoutMs?: number }): string {
  const key = JSON.stringify(options);
  let preloadPath = timingPreloads.get(key);
  if (!preloadPath) {
    const dir = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-timing-"));
    tempDirs.push(dir);
    preloadPath = path.join(dir, "preload.cjs");
    const script: string[] = [];
    if (options.clockScale !== undefined) {
      script.push(
        "const realNow = Date.now.bind(Date);",
        "const startedAt = realNow();",
        `Date.now = () => startedAt + (realNow() - startedAt) * ${options.clockScale};`,
      );
    }
    if (options.spawnTimeoutMs !== undefined) {
      script.push(
        'const childProcess = require("node:child_process");',
        'const { syncBuiltinESMExports } = require("node:module");',
        "const realSpawnSync = childProcess.spawnSync;",
        "childProcess.spawnSync = (command, args, spawnOptions) =>",
        "  realSpawnSync(command, args,",
        `    spawnOptions?.timeout ? { ...spawnOptions, timeout: Math.min(spawnOptions.timeout, ${options.spawnTimeoutMs}) } : spawnOptions);`,
        "syncBuiltinESMExports();",
      );
    }
    writeFileSync(preloadPath, `${script.join("\n")}\n`, "utf8");
    timingPreloads.set(key, preloadPath);
  }
  return preloadPath;
}

function windowsNodeCmdShim(target: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\' +
      target +
      '" %*',
    "",
  ].join("\r\n");
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function makeFakeGit(
  responses: Record<string, { status?: number; stdout?: string; stderr?: string }>,
): string {
  const key = JSON.stringify(responses);
  const cached = fakeGitBinDirs.get(key);
  if (cached) {
    return cached;
  }
  const binDir = mkdtempSync(path.join(tmpdir(), "openclaw-fake-git-"));
  tempDirs.push(binDir);
  const gitPath = path.join(binDir, "git");
  if (process.platform !== "win32") {
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "worktree" ] && [ "$2" = "add" ]; then',
      '  mkdir -p "$4"',
      "  exit 0",
      "fi",
      'if [ "$1" = "-C" ] && [ "$3" = "sparse-checkout" ] && [ "$4" = "disable" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "-C" ] && [ "$3" = "reset" ] && [ "$4" = "--mixed" ]; then',
      "  exit 0",
      "fi",
      'if [ "$1" = "worktree" ] && [ "$2" = "remove" ]; then',
      '  rm -rf "$4"',
      "  exit 0",
      "fi",
      ...Object.entries(responses).flatMap(([responseKey, response]) => {
        const args = responseKey.split("\u0000");
        return [
          `if ${shellArgListCondition(args)}; then`,
          response.stdout ? `  printf "%s" ${shellSingleQuote(response.stdout)}` : "",
          response.stderr ? `  printf "%s" ${shellSingleQuote(response.stderr)} >&2` : "",
          `  exit ${response.status ?? 0}`,
          "fi",
        ].filter(Boolean);
      }),
      "exit 1",
    ].join("\n");
    writeFileSync(gitPath, `${script}\n`, "utf8");
    chmodSync(gitPath, 0o755);
    fakeGitBinDirs.set(key, binDir);
    return binDir;
  }

  const script = [
    "#!/usr/bin/env node",
    "const fs = require('node:fs');",
    "const responses = new Map(Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_GIT_RESPONSES || '{}')));",
    "const args = process.argv.slice(2);",
    "if (args[0] === 'worktree' && args[1] === 'add') { fs.mkdirSync(args[3], { recursive: true }); process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'sparse-checkout' && args[3] === 'disable') { process.exit(0); }",
    "if (args[0] === '-C' && args[2] === 'reset' && args[3] === '--mixed') { process.exit(0); }",
    "if (args[0] === 'worktree' && args[1] === 'remove') { fs.rmSync(args[3], { recursive: true, force: true }); process.exit(0); }",
    "const key = args.join('\\u0000');",
    "const response = responses.get(key);",
    "if (!response) { process.exit(1); }",
    "if (response.stdout) process.stdout.write(response.stdout);",
    "if (response.stderr) process.stderr.write(response.stderr);",
    "process.exit(response.status ?? 0);",
  ].join("\n");
  writeFileSync(gitPath, `${script}\n`, "utf8");
  writeFileSync(`${gitPath}.cmd`, windowsNodeCmdShim("git"), "utf8");
  chmodSync(gitPath, 0o755);
  fakeGitBinDirs.set(key, binDir);
  return binDir;
}

function shellArgListCondition(args: string[]): string {
  const checks = [`[ "$#" -eq ${args.length} ]`];
  for (const [index, arg] of args.entries()) {
    checks.push(`[ "$${index + 1}" = ${shellSingleQuote(arg)} ]`);
  }
  return checks.join(" && ");
}

function runWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  const nodeArgs = [
    ...(options.nodePreload ? ["--require", options.nodePreload] : []),
    "scripts/crabbox-wrapper.mjs",
    ...args,
  ];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    env: wrapperEnv(helpText, options),
    timeout: 10_000,
  });
}

type WrapperOptions = {
  configJson?: Record<string, unknown>;
  configStatus?: number;
  env?: Record<string, string>;
  extraPathEntries?: string[];
  gitResponses?: Record<string, { status?: number; stdout?: string; stderr?: string }>;
  input?: string;
  nodePreload?: string;
};

function spawnWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  const nodeArgs = [
    ...(options.nodePreload ? ["--require", options.nodePreload] : []),
    "scripts/crabbox-wrapper.mjs",
    ...args,
  ];
  return spawn(process.execPath, nodeArgs, {
    cwd: repoRoot,
    env: wrapperEnv(helpText, options),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function wrapperEnv(helpText: string, options: WrapperOptions): NodeJS.ProcessEnv {
  const binDir = makeFakeCrabbox(helpText);
  const gitResponses = { ...defaultGitResponses, ...options.gitResponses };
  const gitBinDir = makeFakeGit(gitResponses);
  return {
    ...process.env,
    PATH: [...(options.extraPathEntries ?? []), binDir, gitBinDir, process.env.PATH ?? ""]
      .filter(Boolean)
      .join(path.delimiter),
    CRABBOX_PROVIDER: "",
    OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "",
    OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "0",
    OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
    ...(options.configJson
      ? { OPENCLAW_FAKE_CRABBOX_CONFIG_JSON: JSON.stringify(options.configJson) }
      : {}),
    ...(options.configStatus
      ? { OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS: String(options.configStatus) }
      : {}),
    ...options.env,
    OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(gitResponses),
  };
}

function parseFakeCrabboxOutput(result: ReturnType<typeof runWrapper>): {
  args: string[];
  cwd: string;
  scriptContent?: string;
} {
  const marker = "__OPENCLAW_FAKE_CRABBOX_V1__\0";
  if (result.stdout.startsWith(marker)) {
    let offset = marker.length;
    const readField = () => {
      const end = result.stdout.indexOf("\0", offset);
      if (end < 0) {
        throw new Error("missing fake Crabbox output field terminator");
      }
      const value = result.stdout.slice(offset, end);
      offset = end + 1;
      return value;
    };
    const cwd = readField();
    const argCount = Number.parseInt(readField(), 10);
    const args = Array.from({ length: argCount }, () => readField());
    const scriptContent = result.stdout.slice(offset);
    return { args, cwd, scriptContent };
  }
  return JSON.parse(result.stdout.trim()) as {
    args: string[];
    cwd: string;
    scriptContent?: string;
  };
}

function normalizeShellLineEndings(value: string): string {
  return value.replace(/\r\n/g, "\n");
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) {
      return;
    }
    await delay(50);
  }
  throw new Error("timed out waiting for condition");
}

async function waitForProcessExit(
  child: ReturnType<typeof spawnWrapper>,
  timeoutMs = 12_000,
): Promise<{ status: number | null; signal: NodeJS.Signals | null }> {
  return await Promise.race([
    new Promise<{ status: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (status, signal) => resolve({ status, signal }));
    }),
    delay(timeoutMs).then(() => {
      throw new Error("timed out waiting for wrapper process exit");
    }),
  ]);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function runSignalCleanupProof(sendSignals: (pid: number) => Promise<void>): Promise<void> {
  const root = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-descendant-"));
  tempDirs.push(root);
  const descendantPidPath = path.join(root, "descendant.pid");
  let descendantPid = 0;
  const runner = spawnWrapper(
    "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
    ["run", "--provider", "aws", "--", "echo ok"],
    {
      env: {
        OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH: descendantPidPath,
        OPENCLAW_TEST_CRABBOX_CHILD_KILL_GRACE_MS: "100",
      },
      nodePreload: testTimingPreload({ clockScale: 20 }),
    },
  );

  try {
    await waitForCondition(() => existsSync(descendantPidPath));
    descendantPid = Number.parseInt(readFileSync(descendantPidPath, "utf8"), 10);
    expect(Number.isInteger(descendantPid)).toBe(true);
    expect(isProcessAlive(descendantPid)).toBe(true);

    const runnerExit = waitForProcessExit(runner);
    await sendSignals(runner.pid!);
    await expect(runnerExit).resolves.toEqual({ status: 143, signal: null });
    await waitForCondition(() => !isProcessAlive(descendantPid));
  } finally {
    if (runner.pid && isProcessAlive(runner.pid)) {
      runner.kill("SIGKILL");
    }
    if (descendantPid && isProcessAlive(descendantPid)) {
      process.kill(descendantPid, "SIGKILL");
    }
  }
}

function testCrabboxConfigDir(home: string): string {
  if (process.platform === "darwin") {
    return path.join(home, "Library", "Application Support", "crabbox");
  }
  if (process.platform === "win32") {
    return path.join(home, "AppData", "Roaming", "crabbox");
  }
  return path.join(home, ".config", "crabbox");
}

function testHomeEnv(home: string): Record<string, string> {
  return {
    APPDATA: path.join(home, "AppData", "Roaming"),
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
  };
}

function expectGroupedShellCommand(remoteCommand: string, command: string): void {
  expect(remoteCommand).toContain(`&& { ${command}`);
  if (process.platform !== "win32") {
    expect(remoteCommand).toContain(`${command}\n}`);
  }
}

const remoteChangedGateEnvPrefix =
  "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1";
const remoteChangedGateExport = `export ${remoteChangedGateEnvPrefix};`;
const remoteChangedGateFetch =
  'git fetch -q --depth=1 origin "$openclaw_changed_gate_base:refs/remotes/origin/main"';

function expectChangedGateGitBootstrap(remoteCommand: string): void {
  expect(remoteCommand).toContain("command -v git");
  expect(remoteCommand).toContain(
    "openclaw_changed_gate_base=${OPENCLAW_CHANGED_GATE_BASE:-abc123}",
  );
  expect(remoteCommand).toContain(
    'openclaw_changed_gate_remote_base="$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)"',
  );
  expect(remoteCommand).toContain(
    '[ "$openclaw_changed_gate_remote_base" != "$openclaw_changed_gate_base" ]',
  );
  expect(remoteCommand).toContain("git init -q");
  expect(remoteCommand).toContain(remoteChangedGateFetch);
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/crabbox-wrapper", () => {
  const azureProviderHelp =
    "provider: hetzner, aws, azure, local-container, blacksmith-testbox, or cloudflare\n";
  const advertisedProviderAliasHelp = [
    "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
    "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
    "",
  ].join("\n");
  const advertisedProviderAliases = [
    ["blacksmith", "blacksmith-testbox"],
    ["cf", "cloudflare"],
    ["container", "local-container"],
    ["docker", "local-container"],
    ["exe", "exe-dev"],
    ["exedev", "exe-dev"],
    ["google", "gcp"],
    ["google-cloud", "gcp"],
    ["local-docker", "local-container"],
    ["namespace", "namespace-devbox"],
    ["namespace-devboxes", "namespace-devbox"],
    ["rail", "railway"],
    ["railwayapp", "railway"],
    ["run-pod", "runpod"],
    ["runpodio", "runpod"],
    ["sem", "semaphore"],
    ["static", "ssh"],
    ["static-ssh", "ssh"],
  ];
  beforeAll(() => {
    runWrapper("provider: aws\n", ["--version"]);
  });

  it("accepts advertised canonical providers from Crabbox help", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("local-container");
  });

  it("hints at lease expiry when a reused-lease run fails fast", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--id", "tbx_expired_fixture", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "1" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "run --id tbx_expired_fixture failed fast; reusable leases expire after their idle timeout",
    );
  });

  it("keeps failed runs without a reused lease free of the expiry hint", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "1" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("failed fast; reusable leases expire");
  });

  it("requires a current Crabbox binary for Blacksmith Testbox runs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.22.0");
    expect(result.stderr).toContain("selected binary reported version=crabbox 0.21.9");
  });

  it("applies the Blacksmith version gate to provider aliases", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.22.0");
  });

  it("rejects prerelease Crabbox builds at the Blacksmith minimum boundary", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.0-rc.1" } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary reported version=crabbox 0.22.0-rc.1");
  });

  it("rejects unsafe Crabbox version numbers at the Blacksmith minimum gate", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.9007199254740993.0" } },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "selected binary reported version=crabbox 0.9007199254740993.0",
    );
  });

  it("accepts post-release Crabbox describe builds at the Blacksmith minimum boundary", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.0-3-gabc1234" } },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("blacksmith-testbox");
  });

  it("tells operators how to read delegated Testbox proof status", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegated Testbox proof uses the wrapper exitCode");
    expect(result.stderr).toContain("Actions run can show cancelled during external lease cleanup");
  });

  it("rejects reused Blacksmith Testboxes that were not created by Crabbox", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--id", "tbx_direct", "--", "echo ok"],
      { env: testHomeEnv(home) },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=blacksmith-testbox --id tbx_direct");
    expect(result.stderr).toContain("has no Crabbox SSH key");
    expect(result.stderr).toContain("direct `blacksmith testbox warmup` leases");
  });

  it("allows reused Blacksmith Testboxes when the Crabbox SSH key exists", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const keyPath = path.join(testCrabboxConfigDir(home), "testboxes", "tbx_owned", "id_ed25519");
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "fake test key\n", "utf8");

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--id", "tbx_owned", "--", "echo ok"],
      { env: testHomeEnv(home) },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--id",
      "tbx_owned",
      "--",
      "env",
      "CI=true",
      "echo ok",
    ]);
  });

  it("fails before reuse when a Blacksmith Testbox is claimed by another repo", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const id = "tbx_claimed";
    const keyPath = path.join(testCrabboxConfigDir(home), "testboxes", id, "id_ed25519");
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "fake test key\n", "utf8");
    const stateRoot = path.join(home, ".local", "state");
    const claimPath = path.join(stateRoot, "crabbox", "claims", `${id}.json`);
    mkdirSync(path.dirname(claimPath), { recursive: true });
    writeFileSync(
      claimPath,
      `${JSON.stringify({ leaseID: id, repoRoot: "/tmp/other-repo" })}\n`,
      "utf8",
    );

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--", "echo ok"],
      { env: { ...testHomeEnv(home), XDG_STATE_HOME: stateRoot } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`lease ${id} is claimed by repo /tmp/other-repo`);
    expect(result.stderr).toContain(`use --reclaim to claim it for ${repoRoot}`);

    const reclaimed = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--reclaim", "--", "echo ok"],
      { env: { ...testHomeEnv(home), XDG_STATE_HOME: stateRoot } },
    );
    expect(reclaimed.status).toBe(0);
    expect(parseFakeCrabboxOutput(reclaimed).args).toContain("--reclaim");
  });

  it("lets Crabbox resolve reusable Testbox slugs", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--id", "blue-hermit", "--", "echo ok"],
      { env: testHomeEnv(home) },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--id",
      "blue-hermit",
      "--",
      "env",
      "CI=true",
      "echo ok",
    ]);
  });

  it("exports CI for complete Blacksmith Testbox shell snippets", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--shell",
        "--",
        "cd packages && pnpm install && pnpm build",
      ],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--shell",
      "--",
      "export CI=true; cd packages && pnpm install && pnpm build",
    ]);
  });

  it("only forces the short local-container Docker work root on Linux", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    const expectedMessage =
      "[crabbox] provider=docker using short host-visible work root for OpenClaw Docker tests";
    if (process.platform === "linux") {
      expect(result.stderr).toContain(expectedMessage);
    } else {
      expect(result.stderr).not.toContain(expectedMessage);
    }
  });

  it("defaults AWS macOS runs to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--",
      "echo ok",
    ]);
  });

  it("prefers Azure for unqualified Windows runs", () => {
    const result = runWrapper(azureProviderHelp, [
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--",
      "corepack",
      "pnpm",
      "check:changed",
    ]);

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.scriptContent!);
    expect(result.status).toBe(0);
    expect(output.args.slice(0, 7)).toEqual([
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--provider",
      "azure",
    ]);
    expect(output.args).toContain("--no-hydrate");
    expect(output.args).toContain("--script");
    expect(output.args).not.toContain("--shell");
    expect(output.args.join(" ")).not.toContain("openclaw_crabbox_bootstrap_wsl2_js");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_wsl2_js");
    expect(remoteCommand).toContain("node-v${node_version}-linux-${node_arch}.tar.gz");
    expect(remoteCommand).toContain("sha256sum -c -");
    expect(remoteCommand).toContain("corepack enable --install-directory");
    expect(remoteCommand).toContain("pnpm install --frozen-lockfile");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_wsl2_js || exit $?");
    expect(remoteCommand).toContain(
      `{ openclaw_crabbox_env ${remoteChangedGateEnvPrefix} corepack pnpm check:changed\n}`,
    );
    expect(result.stderr).toContain("provider=azure");
  });

  it("keeps WSL2 non-JavaScript commands on the default hydrate path", () => {
    const result = runWrapper(azureProviderHelp, [
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--",
      "echo",
      "ok",
    ]);

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).toEqual([
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--provider",
      "azure",
      "--",
      "echo",
      "ok",
    ]);
    expect(output.args).not.toContain("--no-hydrate");
    expect(output.args).not.toContain("--shell");
  });

  it("keeps explicit provider env overrides for Windows runs", () => {
    const result = runWrapper(azureProviderHelp, ["run", "--target", "windows", "--", "echo ok"], {
      env: { CRABBOX_PROVIDER: "aws" },
    });

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps the AWS provider env for Windows runs when Azure is unavailable", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--target", "windows", "--", "echo ok"],
      {
        env: {
          CRABBOX_PROVIDER: "aws",
          OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps existing Windows lease selections on the configured provider", () => {
    const result = runWrapper(
      azureProviderHelp,
      ["run", "--id", "cbx_existing", "--target", "windows", "--", "echo ok"],
      {
        env: {
          CRABBOX_PROVIDER: "aws",
          OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "1",
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--id",
      "cbx_existing",
      "--target",
      "windows",
      "--",
      "echo ok",
    ]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("uses the native Windows daemon job for Windows hydrate actions", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--id",
      "cbx_existing",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--id",
      "cbx_existing",
      "--job",
      "hydrate-windows-daemon",
    ]);
  });

  it("repairs generic hydrate jobs for native Windows hydrate actions", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job",
      "hydrate",
      "--id",
      "cbx_existing",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job",
      "hydrate-windows-daemon",
      "--id",
      "cbx_existing",
    ]);
  });

  it("repairs generic hydrate job assignments for native Windows hydrate actions", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job=hydrate",
      "--id",
      "cbx_existing",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job=hydrate-windows-daemon",
      "--id",
      "cbx_existing",
    ]);
  });

  it("keeps post-delimiter hydrate payloads untouched for native Windows hydrate actions", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--id",
      "cbx_existing",
      "--",
      "--job",
      "hydrate",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--id",
      "cbx_existing",
      "--job",
      "hydrate-windows-daemon",
      "--",
      "--job",
      "hydrate",
    ]);
  });

  it("keeps explicit non-native hydrate jobs for Windows hydrate actions", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job",
      "hydrate-github",
      "--id",
      "cbx_existing",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--job",
      "hydrate-github",
      "--id",
      "cbx_existing",
    ]);
  });

  it("keeps WSL2 hydrate actions on the requested job", () => {
    const result = runWrapper(azureProviderHelp, [
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--job",
      "hydrate",
      "--id",
      "cbx_existing",
    ]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "actions",
      "hydrate",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--job",
      "hydrate",
      "--id",
      "cbx_existing",
    ]);
  });

  it("prefers Azure for unqualified Windows warmups", () => {
    const result = runWrapper(azureProviderHelp, ["warmup", "--target", "windows"]);

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "warmup",
      "--target",
      "windows",
      "--provider",
      "azure",
    ]);
  });

  it("rejects Blacksmith Testbox for Windows-shaped proof", () => {
    for (const args of [
      ["run", "--provider", "blacksmith-testbox", "--target", "windows", "--", "echo ok"],
      ["run", "--provider", "blacksmith-testbox", "--windows-mode", "wsl2", "--", "echo ok"],
    ]) {
      const result = runWrapper(azureProviderHelp, args);

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        "provider=blacksmith-testbox supports Linux Testbox proof only",
      );
      expect(result.stderr).toContain("windows-testbox-probe.yml");
    }
  });

  it("fails closed for AWS proof when broker auth is missing", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      { configJson: { coordinator: "", brokerAuth: "missing" } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws requires a configured Crabbox broker");
    expect(result.stderr).toContain(
      "crabbox login --url https://crabbox.openclaw.ai --provider aws",
    );
  });

  it("fails closed for AWS proof when broker auth is stale", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      {
        configJson: { coordinator: "https://crabbox.openclaw.ai", brokerAuth: "configured" },
        env: { OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS: "1" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws requires a configured Crabbox broker");
  });

  it("allows explicit direct AWS debugging without broker auth", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      {
        configJson: { coordinator: "", brokerAuth: "missing" },
        env: { OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "1" },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--",
      "echo ok",
    ]);
  });

  it("defaults AWS macOS warmups to on-demand capacity", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["warmup", "--provider", "aws", "--target", "macos"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toEqual([
      "warmup",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
    ]);
  });

  it("does not override explicit AWS macOS market or lease selections", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    const explicitMarket = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    const existingLease = runWrapper(helpText, [
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);

    expect(explicitMarket.status).toBe(0);
    expect(parseFakeCrabboxOutput(explicitMarket).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    expect(existingLease.status).toBe(0);
    expect(parseFakeCrabboxOutput(existingLease).args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--id",
      "cbx_existing",
      "--",
      "echo ok",
    ]);
  });

  it("bootstraps only Node for raw AWS macOS node commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "node", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("node-v${node_version}-darwin-${node_arch}.tar.gz");
    expect(remoteCommand).toContain("node --version >&2 || return 1");
    expect(remoteCommand).not.toContain("corepack enable");
    expect(remoteCommand).not.toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "node --version");
  });

  it("preflights Swift 6.2 for raw AWS macOS Swift app builds", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "swift",
        "build",
        "--package-path",
        "apps/macos",
        "--product",
        "OpenClaw",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(remoteCommand).toContain("/Applications/Xcode_26.1.app");
    expect(remoteCommand).toContain("/Applications/Xcode-26*.app");
    expect(remoteCommand).toContain('sudo xcode-select -s "$openclaw_developer"');
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Swift tools 6.2+");
    expect(remoteCommand).toContain("xcodebuild -version");
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Xcode 26.x");
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(
      remoteCommand,
      "swift build --package-path apps/macos --product OpenClaw",
    );
  });

  it("preflights Swift and JS tooling for raw AWS macOS package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "pnpm", "mac:package"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Swift tools 6.2+");
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Xcode 26.x");
    expectGroupedShellCommand(remoteCommand, "pnpm mac:package");
  });

  it("preserves sanitized env pnpm package commands when Swift preflight is needed", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "env", "-i", "pnpm", "mac:package"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -i pnpm mac:package");
  });

  it("preserves sanitized env package script commands when JS tooling is needed", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "env",
        "-i",
        "bash",
        "scripts/package-mac-app.sh",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    );
  });

  it("does not bootstrap JS tooling for env package scripts behind command", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "command",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "bash",
        "scripts/package-mac-app.sh",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap JS tooling for nested env package scripts that cannot be shimmed", () => {
    for (const args of [
      ["--", "bash", "-lc", "env -i PATH=/usr/bin:/bin bash scripts/package-mac-app.sh"],
      ["--shell", "--", "bash -lc 'env -i PATH=/usr/bin:/bin bash scripts/package-mac-app.sh'"],
    ]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--target", "macos", ...args],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    }
  });

  it("does not bootstrap Corepack for nested env pnpm commands that cannot be shimmed", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "bash -lc 'env -i PATH=/usr/bin:/bin pnpm --version'",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toBe("bash -lc 'env -i PATH=/usr/bin:/bin pnpm --version'");
  });

  it("preserves sanitized env shell package scripts when JS tooling is needed", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "env -i bash scripts/package-mac-app.sh",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    );
  });

  it("preserves shell syntax when sanitizing env package scripts", () => {
    for (const [shellCommand, expectedCommand] of [
      [
        "env -i PATH=$PATH bash scripts/package-mac-app.sh > out.log",
        "openclaw_crabbox_env -i PATH=$PATH bash scripts/package-mac-app.sh > out.log",
      ],
      [
        "env -i bash scripts/package-mac-app.sh >out.log 2>&1",
        "openclaw_crabbox_env -i bash scripts/package-mac-app.sh >out.log 2>&1",
      ],
    ]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellCommand],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(output.args).toContain("--shell");
      expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("pnpm --version >&2");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
      expect(remoteCommand).not.toContain("'>'");
      expectGroupedShellCommand(remoteCommand, expectedCommand);
    }
  });

  it("preserves trailing shell segments when sanitizing env package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "env -i bash scripts/package-mac-app.sh && echo done",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh && echo done",
    );
  });

  it("preserves prefixed shell segments when sanitizing env package scripts", () => {
    for (const [shellCommand, expectedCommand] of [
      [
        "set -e; env -i bash scripts/package-mac-app.sh",
        "set -e; openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
      [
        "time env -i bash scripts/package-mac-app.sh",
        "time openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
    ]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellCommand],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(output.args).toContain("--shell");
      expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("pnpm --version >&2");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
      expectGroupedShellCommand(remoteCommand, expectedCommand);
    }
  });

  it("preserves grouped shell segments when sanitizing env package scripts", () => {
    for (const [shellCommand, expectedCommand] of [
      [
        "(env -i bash scripts/package-mac-app.sh)",
        "(openclaw_crabbox_env -i bash scripts/package-mac-app.sh)",
      ],
      [
        "{ env -i bash scripts/package-mac-app.sh; }",
        "{ openclaw_crabbox_env -i bash scripts/package-mac-app.sh; }",
      ],
    ]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellCommand],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(output.args).toContain("--shell");
      expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("pnpm --version >&2");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
      expectGroupedShellCommand(remoteCommand, expectedCommand);
    }
  });

  it("does not rewrite heredoc bodies when sanitizing env package scripts", () => {
    const shellCommand = [
      "env -i bash scripts/package-mac-app.sh",
      "cat <<EOF",
      "env -i bash scripts/package-mac-app.sh",
      "EOF",
    ].join("\n");
    const expectedCommand = [
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      "cat <<EOF",
      "env -i bash scripts/package-mac-app.sh",
      "EOF",
    ].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellCommand],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, expectedCommand);
    expect(remoteCommand).not.toContain("cat <<EOF\nopenclaw_crabbox_env");
  });

  it("preserves control-flow shell segments when sanitizing env package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "if true; then env -i bash scripts/package-mac-app.sh; fi",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(
      remoteCommand,
      "if true; then openclaw_crabbox_env -i bash scripts/package-mac-app.sh; fi",
    );
  });

  it("preserves assignment prefixes when sanitizing env package scripts", () => {
    for (const [shellCommand, expectedCommand] of [
      [
        "FOO=1 env -i bash scripts/package-mac-app.sh",
        "FOO=1 openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
      [
        "FOO= env -i bash scripts/package-mac-app.sh",
        "FOO= openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
      [
        "FOO='a b' env -i bash scripts/package-mac-app.sh",
        "FOO='a b' openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
      [
        "PATH=/usr/bin:/bin env -i bash scripts/package-mac-app.sh",
        "PATH=/usr/bin:/bin openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
      ],
    ]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellCommand],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(output.args).toContain("--shell");
      expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("pnpm --version >&2");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
      expect(remoteCommand).toContain('export OPENCLAW_CRABBOX_BOOTSTRAP_PATH="$PATH";');
      expectGroupedShellCommand(remoteCommand, expectedCommand);
    }
  });

  it("preflights Swift and JS tooling for raw AWS macOS shell-launched package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "bash", "scripts/package-mac-app.sh"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, "bash scripts/package-mac-app.sh");
  });

  it("preflights Swift and JS tooling for raw AWS macOS dist package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "bash",
        "scripts/package-mac-dist.sh",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, "bash scripts/package-mac-dist.sh");
  });

  it("preflights Swift and JS tooling for raw AWS macOS restart scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "bash", "scripts/restart-mac.sh"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, "bash scripts/restart-mac.sh");
  });

  it("keeps raw AWS macOS build-and-run scripts Swift-only", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "bash",
        "scripts/build-and-run-mac.sh",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, "bash scripts/build-and-run-mac.sh");
  });

  it("does not preflight Swift for raw AWS macOS commands that only mention package scripts", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "echo", "scripts/package-mac-app.sh"],
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--shell");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--",
      "echo",
      "scripts/package-mac-app.sh",
    ]);
  });

  it("normalizes inherited Linux UTF-8 locale names for raw AWS macOS bootstrap", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "node", "--version"],
      {
        env: {
          LANG: "C.UTF-8",
          LC_ALL: "C.UTF-8",
          LC_CTYPE: "C.UTF-8",
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain('macos_locale="${OPENCLAW_CRABBOX_MACOS_LOCALE:-en_US.UTF-8}"');
    expect(remoteCommand).toContain(
      'case "${LANG:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LANG="$macos_locale" ;; esac;',
    );
    expect(remoteCommand).toContain(
      'case "${LC_ALL:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LC_ALL="$macos_locale" ;; esac;',
    );
    expect(remoteCommand).toContain(
      'case "${LC_CTYPE:-}" in C.UTF-8|C.utf8|c.UTF-8|c.utf8) export LC_CTYPE="$macos_locale" ;; esac;',
    );
    expectGroupedShellCommand(remoteCommand, "node --version");
  });

  it("bootstraps Bun for raw AWS macOS bun commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "bun", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(result.stderr).toContain("Node/Corepack/pnpm/Bun");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("bun_version=1.3.14");
    expect(remoteCommand).toContain('bun_root="$tool_root/bun-v${bun_version}"');
    expect(remoteCommand).toContain(
      'npm install --global --prefix "$bun_root" --fetch-timeout=120000 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 "bun@${bun_version}"',
    );
    expect(remoteCommand).toContain("bun --version >&2 || return 1");
    expect(remoteCommand).not.toContain("corepack enable");
    expectGroupedShellCommand(remoteCommand, "bun --version");
  });

  it("bootstraps Bun for raw AWS macOS env-prefixed bun commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "env", "-i", "bun", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("bun --version >&2 || return 1");
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -i bun --version");
  });

  it("bootstraps Corepack for raw AWS macOS pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(result.stderr).toContain(
      "bootstrapping pinned user-local JavaScript tooling before the command",
    );
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("node-v${node_version}-darwin-${node_arch}.tar.gz");
    expect(remoteCommand).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 -o "$tmp_dir/$pkg"',
    );
    expect(remoteCommand).toContain(
      'curl -fsSL --connect-timeout 10 --max-time 60 --retry 2 --retry-delay 2 -o "$tmp_dir/SHASUMS256.txt"',
    );
    expect(remoteCommand).toContain("shasum -a 256 -c -");
    expect(remoteCommand).toContain('ready_marker="$node_dir/.openclaw-crabbox-node-ready"');
    expect(remoteCommand).toContain(
      'if [ -x "$node_dir/bin/node" ] && [ -f "$ready_marker" ]; then break; fi;',
    );
    expect(remoteCommand).toContain('touch "$ready_marker"');
    expect(remoteCommand).toContain(
      'install_lock="$tool_root/.node-${node_version}-${node_arch}.lock"',
    );
    expect(remoteCommand).toContain("lock_deadline=$((SECONDS + 300))");
    expect(remoteCommand).toContain('printf "%s\\n" "$$" >"$install_lock/pid"');
    expect(remoteCommand).toContain(
      "timed out waiting for active macOS Node toolchain install lock: $install_lock pid=$lock_pid",
    );
    expect(remoteCommand).toContain(
      "reclaiming stale macOS Node toolchain install lock: $install_lock",
    );
    expect(remoteCommand).toContain('rm -rf "$install_lock"');
    expect(remoteCommand).toContain("release_install_lock");
    expect(remoteCommand).not.toContain("set -euo pipefail");
    expect(remoteCommand).toContain('return "$status"');
    expect(remoteCommand).toContain('if [ -z "${TMPDIR:-}" ]; then export TMPDIR="/tmp"; fi;');
    expect(remoteCommand).toContain('mkdir -p "$TMPDIR"');
    expect(remoteCommand).toContain("usable TMPDIR not found: $TMPDIR");
    expect(remoteCommand).toContain("node --version >&2 || return 1");
    expect(remoteCommand).toContain('export PNPM_HOME="${PNPM_HOME:-$tool_root/pnpm-home}"');
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "pnpm --version");
  });

  it("bootstraps Corepack for raw AWS macOS env-prefixed pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "/usr/bin/env", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env pnpm --version");
  });

  it("bootstraps Corepack for raw AWS macOS env option pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_env");
    expect(remoteCommand).not.toContain("export -f env openclaw_crabbox_env");
    expect(remoteCommand).not.toContain('env() { openclaw_crabbox_env "$@"; };');
    expect(remoteCommand).toContain("PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}:${1#PATH=}");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i PATH=/usr/bin:/bin pnpm --version",
    );
  });

  it("bootstraps Corepack for raw AWS macOS env options before ignore-environment", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "env",
        "-u",
        "FOO",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("-u|--unset|-C|--chdir)");
    expect(remoteCommand).toContain("-i|--ignore-environment)");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -u FOO -i PATH=/usr/bin:/bin pnpm --version",
    );
  });

  it("bootstraps Corepack for raw AWS macOS absolute env ignore-environment commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "/usr/bin/env",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      "openclaw_crabbox_env -i PATH=/usr/bin:/bin pnpm --version",
    );
  });

  it("injects the bootstrapped PATH for raw AWS macOS absolute env -i commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "/usr/bin/env",
        "-i",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain(
      'if [ "$openclaw_env_ignore" = "1" ] && [ "$openclaw_env_path_seen" = "0" ]; then openclaw_env_args+=("PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}"); fi;',
    );
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -i pnpm --version");
  });

  it("does not rewrite custom env executables for raw AWS macOS ignore-environment commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "./tools/env",
        "-i",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.args).not.toContain("--shell");
  });

  it("does not bootstrap env ignore-environment commands that bypass shell functions", () => {
    for (const prefix of ["command", "exec"]) {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        [
          "run",
          "--provider",
          "aws",
          "--target",
          "macos",
          "--",
          prefix,
          "env",
          "-i",
          "PATH=/usr/bin:/bin",
          "pnpm",
          "--version",
        ],
      );

      const output = parseFakeCrabboxOutput(result);
      const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
      expect(result.status).toBe(0);
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(output.args).not.toContain("--shell");
    }
  });

  it("bootstraps env commands behind command when they keep the inherited PATH", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "command",
        "env",
        "CI=1",
        "pnpm",
        "--version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "command env CI=1 pnpm --version");
  });

  it("does not shadow unrelated env calls in AWS macOS shell commands", () => {
    const shellScript = "node --version; env -i PATH=/usr/bin:/bin printenv PATH";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_env");
    expect(remoteCommand).not.toContain('env() { openclaw_crabbox_env "$@"; };');
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("does not bootstrap env split-string commands after ignore-environment", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "env", "-i", "-S", "pnpm --version"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.args).not.toContain("--shell");
  });

  it("bootstraps Corepack for raw AWS macOS env split-string pnpm commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "/usr/bin/env",
        "-S",
        "pnpm --version",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand.indexOf("-S|--split-string|-S*|--split-string=*)")).toBeLessThan(
      remoteCommand.indexOf("-[!-]*i*)"),
    );
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -S 'pnpm --version'");
  });

  it("bootstraps Corepack for AWS macOS node changed-gate commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "node", "scripts/check-changed.mjs"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("node --version >&2");
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} node scripts/check-changed.mjs`,
    );
  });

  it("bootstraps Corepack for AWS macOS node option changed-gate commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "node",
        "--max-old-space-size",
        "4096",
        "--env-file-if-exists",
        ".env",
        "--unhandled-rejections",
        "strict",
        "--trace-warnings",
        "--import=tsx",
        "scripts/check-changed.mjs",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} node --max-old-space-size 4096 --env-file-if-exists .env --unhandled-rejections strict --trace-warnings --import=tsx scripts/check-changed.mjs`,
    );
  });

  it("does not treat node script arguments as changed-gate commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--",
        "node",
        "--trace-warnings",
        "scripts/other.mjs",
        "scripts/check-changed.mjs",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expectGroupedShellCommand(
      remoteCommand,
      "node --trace-warnings scripts/other.mjs scripts/check-changed.mjs",
    );
  });

  it("preserves shell commands when bootstrapping raw AWS macOS JavaScript commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", "pnpm check:changed"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} pnpm check:changed`);
  });

  it("bootstraps raw AWS macOS shell scripts that set up before JavaScript commands", () => {
    const shellScript = [
      "set -euo pipefail",
      'repo_tmp=$(node -e "console.log(require(\\"node:os\\").tmpdir())")',
      "pnpm --version",
    ].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript commands", () => {
    const shellScript = "/usr/bin/env CI=1 pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps AWS macOS script-stdin runs before the uploaded script body", () => {
    const script = ["set -euo pipefail", "node -v", "pnpm --version"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--script-stdin");
    expect(output.args).toContain("--script");
    expect(result.stderr).toContain(
      "bootstrapping pinned user-local JavaScript tooling before the command",
    );
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain('if [ ! -d "$TMPDIR" ]; then mkdir -p "$TMPDIR"');
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain(`\n${script}`);
  });

  it("preserves AWS macOS script-stdin shebang payloads behind the bootstrap wrapper", () => {
    const script = ["#!/usr/bin/env node", "console.log(process.version);"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin", "--", "arg1"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--script-stdin");
    expect(output.args).toContain("--script");
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).not.toContain("corepack enable");
    expect(output.scriptContent).not.toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("cat >\"$tmp_script\" <<'OPENCLAW_CRABBOX_SCRIPT_0'");
    expect(output.scriptContent).toContain(`\n${script}\nOPENCLAW_CRABBOX_SCRIPT_0\n`);
    expect(output.scriptContent).toContain('chmod 700 "$tmp_script" || exit $?');
    expect(output.scriptContent).toContain('"$tmp_script" "$@"');
    expect(output.args.at(-1)).toBe("arg1");
  });

  it("bootstraps AWS macOS script-stdin shell shebang bodies before the uploaded script", () => {
    const script = [
      "#!/usr/bin/env bash",
      "set -euo pipefail",
      "pnpm --version",
      "bun --version",
    ].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("bun --version >&2 || return 1");
    expect(output.scriptContent).toContain(`\n${script}\n`);
  });

  it("preflights Swift for AWS macOS script-stdin Swift builds", () => {
    const script = [
      "set -euo pipefail",
      "swift build --package-path apps/macos --product OpenClaw",
    ].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62 || exit $?");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Swift tools 6.2+");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Xcode 26.x");
    expect(output.scriptContent).toContain(`\n${script}`);
  });

  it("preflights Swift and JS for AWS macOS script-stdin package scripts", () => {
    const script = ["#!/usr/bin/env bash", "set -euo pipefail", "pnpm mac:package"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62 || exit $?");
    expect(output.scriptContent).toContain(`\n${script}\n`);
  });

  it("bootstraps Corepack for AWS macOS script-stdin env shebangs with option values", () => {
    const script = ["#!/usr/bin/env -C /tmp -u OPENCLAW_FAKE_VAR pnpm", "--version"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain(`\n${script}\n`);
  });

  it("bootstraps Bun for AWS macOS script-stdin bun shebangs", () => {
    const script = ["#!/usr/bin/env bun", "console.log(Bun.version);"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--script-stdin"],
      { input: script },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.scriptContent).toContain("bun_version=1.3.14");
    expect(output.scriptContent).toContain(
      'npm install --global --prefix "$bun_root" --fetch-timeout=120000 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 "bun@${bun_version}"',
    );
    expect(output.scriptContent).toContain("bun --version >&2 || return 1");
    expect(output.scriptContent).not.toContain("corepack enable");
  });

  it("does not treat run option values as AWS macOS script-stdin flags", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--label",
        "--script-stdin",
        "--",
        "echo ok",
      ],
      { input: "node -v\n" },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).toContain("--label");
    expect(output.args).toContain("--script-stdin");
    expect(output.args).not.toContain("--script");
    expect(output.scriptContent).toBe("");
  });

  it("bootstraps raw AWS macOS shell scripts with setup inside command substitutions", () => {
    const shellScript = "version=$(cd repo && pnpm --version)";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with assignment-prefix command substitutions", () => {
    const shellScript = "TOOL_ROOT=$(pwd) pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with case branches inside command substitutions", () => {
    const shellScript = 'version=$(case "$pm" in pnpm) pnpm --version ;; esac)';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with grouped setup inside command substitutions", () => {
    const shellScript = 'echo "$( (echo setup); pnpm --version )"';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after comments and setup commands", () => {
    const shellScript = ["# setup", "cd repo && pnpm --version"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after escaped newlines", () => {
    const shellScript = "cd repo && \\\npnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with exec-prefixed JavaScript commands", () => {
    const shellScript = "set -e; exec pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("bootstraps raw AWS macOS shell scripts with command-prefixed JavaScript commands", () => {
    const shellScript = "command pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with time-prefixed JavaScript commands", () => {
    const shellScript = "time -p node -e 'process.exit(0)'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with absolute time-prefixed JavaScript commands", () => {
    const shellScript = "/usr/bin/time -l pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript control conditions", () => {
    const shellScript = "if node -e 'process.exit(0)'; then echo ok; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript control conditions", () => {
    const shellScript = "if CI=1 pnpm --version; then echo ok; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript pipeline stages", () => {
    const shellScript = "echo '{}' | node -e 'process.stdin.resume()'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts after background setup commands", () => {
    const shellScript = "setup_task & pnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript else branches", () => {
    const shellScript = "if test -d node_modules; then echo cached; else pnpm --version; fi";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with JavaScript case branches", () => {
    const shellScript = 'case "$(uname -m)" in arm64|x64) pnpm --version ;; esac';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("does not bootstrap raw AWS macOS shell scripts for JavaScript-named case labels", () => {
    const shellScript = 'case "$packageManager" in pnpm) echo "$packageManager" ;; esac';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts that only mention JavaScript tools", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'echo "node and pnpm are documented here"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for quoted JavaScript tool mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'echo "docs; pnpm --version"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for inline comment mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "echo ok # $(pnpm --version)",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for reserved words in arguments", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "echo then pnpm --version && echo use-case",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for arithmetic expansion names", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "node=1; echo $((node + 1))",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for quoted assignment mentions", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        'MSG="use pnpm here" printf "%s\\n" "$MSG"',
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for command lookup checks", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", "command -v pnpm"],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap raw AWS macOS shell scripts for timed command lookup checks", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "/usr/bin/time -l command -v pnpm",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("groups shell commands so fallbacks cannot mask AWS macOS bootstrap failures", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        "--shell",
        "--",
        "pnpm check:changed || true",
      ],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(
      remoteCommand,
      `${remoteChangedGateExport} pnpm check:changed || true`,
    );
  });

  it("does not bootstrap non-macOS AWS JavaScript commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "linux", "--", "pnpm", "--version"],
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "linux",
      "--",
      "pnpm",
      "--version",
    ]);
  });

  it("restores hydrated node_modules before AWS native Windows shell commands", () => {
    const result = runWrapper("provider: hetzner, aws, azure, local-container\n", [
      "run",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--windows-mode",
      "normal",
      "--id",
      "cbx_test",
      "--shell",
      "--",
      "corepack pnpm check:changed",
    ]);

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = output.args.at(-1) ?? "";
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("$openclawModulesDir = $env:PNPM_CONFIG_MODULES_DIR");
    expect(remoteCommand).toContain('mklink /J "$openclawSelfModules" "$openclawModulesDir"');
    expect(remoteCommand).toContain('mklink /J "$openclawWorkspaceModules" "$openclawModulesDir"');
    expect(remoteCommand).toContain("corepack pnpm check:changed");
  });

  it("restores hydrated node_modules before Azure native Windows shell commands", () => {
    const result = runWrapper("provider: hetzner, aws, azure, local-container\n", [
      "run",
      "--provider",
      "azure",
      "--target",
      "windows",
      "--windows-mode",
      "normal",
      "--id",
      "cbx_test",
      "--shell",
      "--",
      "corepack pnpm check:changed",
    ]);

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = output.args.at(-1) ?? "";
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("$openclawModulesDir = $env:PNPM_CONFIG_MODULES_DIR");
    expect(remoteCommand).toContain('mklink /J "$openclawSelfModules" "$openclawModulesDir"');
    expect(remoteCommand).toContain('mklink /J "$openclawWorkspaceModules" "$openclawModulesDir"');
    expect(remoteCommand).toContain("corepack pnpm check:changed");
  });

  it("restores hydrated node_modules before AWS native Windows direct commands", () => {
    const result = runWrapper("provider: hetzner, aws, azure, local-container\n", [
      "run",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--windows-mode",
      "normal",
      "--id",
      "cbx_test",
      "--",
      "pnpm",
      "--filter",
      "@openclaw/discord",
      "test",
    ]);

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = output.args.at(-1) ?? "";
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("$openclawModulesDir = $env:PNPM_CONFIG_MODULES_DIR");
    expect(remoteCommand).toContain("pnpm --filter '@openclaw/discord' test");
  });

  const itWithPosixLinkedWorktreeFixture = process.platform === "win32" ? it.skip : it;

  itWithPosixLinkedWorktreeFixture(
    "finds a Crabbox checkout next to the Git common dir in linked worktrees",
    () => {
      const fakeWorkspaceParent = mkdtempSync(path.join(tmpdir(), "openclaw-linked-worktree-"));
      tempDirs.push(fakeWorkspaceParent);
      const gitCommonDir = path.join(fakeWorkspaceParent, "openclaw", ".git");
      const crabboxBinDir = path.join(fakeWorkspaceParent, "crabbox", "bin");
      mkdirSync(gitCommonDir, { recursive: true });
      writeFakeCrabbox(crabboxBinDir, "provider: aws\n");
      const gitResponses = {
        [GIT_COMMON_DIR_KEY]: { stdout: `${gitCommonDir}\n` },
      };
      const gitBinDir = makeFakeGit(gitResponses);

      const result = spawnSync(
        process.execPath,
        ["scripts/crabbox-wrapper.mjs", "run", "--provider", "aws", "--", "echo ok"],
        {
          cwd: repoRoot,
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
            OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(gitResponses),
            PATH: [gitBinDir, path.dirname(process.execPath)].join(path.delimiter),
          },
        },
      );

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    },
  );

  it("accepts advertised providers from wrapped Crabbox help", () => {
    const result = runWrapper(
      [
        "provider: hetzner, aws, local-container, blacksmith-testbox,",
        "  docker, or cloudflare (default: aws)",
        "",
      ].join("\n"),
      ["run", "--provider", "docker", "--", "echo ok"],
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("docker");
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,docker,cloudflare",
    );
  });

  if (process.platform === "win32") {
    it("preserves shell metacharacters through Windows Crabbox command shims", () => {
      const remoteCommand = "pnpm build && pnpm test | more < in.txt > out.txt %PATH%";
      const result = runWrapper("provider: aws\n", [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        remoteCommand,
      ]);

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toEqual([
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        remoteCommand,
      ]);
    });
  }

  if (process.platform !== "win32") {
    it("keeps POSIX PATH lookup semantics for non-executable entries", () => {
      const staleBinDir = mkdtempSync(path.join(tmpdir(), "openclaw-stale-crabbox-"));
      tempDirs.push(staleBinDir);
      writeFileSync(path.join(staleBinDir, "crabbox"), "not executable\n", "utf8");
      const result = runWrapper("provider: aws\n", ["run", "--provider", "aws", "--", "echo ok"], {
        extraPathEntries: [staleBinDir],
      });

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    });
  }

  it("falls back to normal sync decisions when git is missing from PATH", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_COMMON_DIR_KEY]: { status: 1 },
          [GIT_CONFIG_SPARSE_KEY]: { status: 1 },
          [GIT_SPARSE_LIST_KEY]: { status: 1 },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("aws");
  });

  it.each(advertisedProviderAliases)(
    "canonicalizes Crabbox provider alias %s to %s",
    (alias, canonical) => {
      const advertisedProviders = parseProvidersFromHelp(advertisedProviderAliasHelp);

      expect(canonicalProviderName(alias)).toBe(canonical);
      expect(isProviderAdvertised(alias, advertisedProviders)).toBe(true);
    },
  );

  it("accepts Crabbox provider aliases when upstream help omits Tensorlake", () => {
    const helpText = [
      "provider: hetzner, aws, gcp, local-container, blacksmith-testbox,",
      "  namespace-devbox, runpod, semaphore, cloudflare, railway, exe-dev, or ssh",
      "",
    ].join("\n");

    const advertisedProviders = parseProvidersFromHelp(helpText);
    for (const provider of ["tensorlake", "tl", "tensorlake-sbx"]) {
      expect(isProviderAdvertised(provider, advertisedProviders), provider).toBe(true);
    }
  });

  it("keeps unsupported provider selections rejected", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "bogus", "--", "echo ok"],
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary does not advertise provider bogus");
  });

  it("times out hung sanity probes before rejecting the selected binary", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    const result = runWrapper(helpText, ["--version"], {
      env: { OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS: "100" },
      extraPathEntries: [makeSlowVersionCrabbox(helpText)],
      nodePreload: testTimingPreload({ spawnTimeoutMs: 25 }),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("version=unknown");
    expect(result.stderr).toContain("selected binary failed basic --version/--help sanity checks");
  });

  it("retries a cold Crabbox whose run --help is slower than the default probe timeout", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    // First probe is SIGKILLed at 150ms; the retry gets the full generous timeout
    // and reads the (600ms) stderr help, so the wrapper must not hard-fail.
    const result = runWrapper(helpText, ["--version"], {
      env: { OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS: "150" },
      extraPathEntries: [makeSlowHelpCrabbox(helpText, 600)],
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("could not parse provider list");
    expect(result.stderr).not.toContain(
      "selected binary failed basic --version/--help sanity checks",
    );
    expect(result.stderr).toContain(
      "providers=hetzner,aws,local-container,blacksmith-testbox,cloudflare",
    );
  });

  it("parses provider choices from the --provider flag help format", () => {
    const helpText =
      "Usage: crabbox run [options]\n  --provider hetzner|aws|local-container|blacksmith-testbox|cloudflare\n";

    expect(parseProvidersFromHelp(helpText)).toEqual([
      "hetzner",
      "aws",
      "local-container",
      "blacksmith-testbox",
      "cloudflare",
    ]);
  });

  it("uses a temporary full checkout for clean sparse Blacksmith syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout for clean sparse AWS syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from origin/main");
    expect(parseFakeCrabboxOutput(result).args.join(" ")).toContain(
      'openclaw_changed_gate_remote_base="$(git rev-parse --verify refs/remotes/origin/main 2>/dev/null || true)"',
    );
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse AWS syncs reuse a lease", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "windows",
        "--id",
        "cbx_existing",
        "--",
        "corepack",
        "pnpm",
        "build",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("bootstraps Git metadata for sparse changed gates on remote raw syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expectChangedGateGitBootstrap(remoteCommand);
    expect(remoteCommand).toContain("git reset --mixed --quiet refs/remotes/origin/main");
    expect(remoteCommand).toContain("git add -A");
    expect(remoteCommand).toContain("git diff --cached --quiet");
    expect(remoteCommand).toContain("commit -q --no-gpg-sign -m remote-changed-gate-tree");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("bootstraps Git metadata for non-sparse changed gates on remote raw syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from abc123");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("bootstraps Git metadata for env-prefixed sparse changed gates", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--",
        "env",
        "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
        "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
        "CI=1",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("preserves macOS JS bootstrapping for sparse changed gates on remote raw syncs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} pnpm check:changed`,
    );
  });

  it("preserves macOS JS and Git bootstraps for sparse shell changed gates with setup", () => {
    const shellScript = ["set -euo pipefail", "pnpm check:changed"].join("\n");
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves macOS JS and Git bootstraps for shell-wrapped sparse changed gates", () => {
    const shellScript = "bash -lc 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("does not mistake quoted remote-child markers for shell changed-gate environment", () => {
    const shellScript = 'echo "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1"; pnpm check:changed';
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for assignment-prefix command substitutions", () => {
    const shellScript = "TOOL_ROOT=$(pwd) pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for command-prefixed shell commands", () => {
    const shellScript = "command pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for bash -lc shell commands", () => {
    const shellScript =
      "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 bash -lc 'set -euo pipefail; pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toContain(`&& export ${remoteChangedGateEnvPrefix}; ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for shell option values before -c", () => {
    const shellScript = "bash -o pipefail -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for attached shell option values before -c", () => {
    const shellScript = "bash --rcfile=./ci.bashrc -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for grouped shell options before -c", () => {
    const shellScript = "bash -eo pipefail -c 'pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for absolute time-prefixed shell commands", () => {
    const shellScript = "/usr/bin/time -l pnpm check:changed";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for timeout-wrapped shell commands", () => {
    const shellScript =
      "/usr/bin/time -v timeout 1200s node --max-old-space-size=4096 scripts/check-changed.mjs --base origin/main --head HEAD";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped node commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--",
        "timeout",
        "1200s",
        "node",
        "scripts/check-changed.mjs",
        "--base",
        "origin/main",
        "--head",
        "HEAD",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s node scripts\/check-changed\.mjs --base origin\/main --head HEAD$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped shell commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "timeout", "1200s", "bash", "-lc", "pnpm check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s bash -lc 'pnpm check:changed'$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct env -i commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "env", "-i", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& env -i OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 pnpm check:changed$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct absolute env -i commands", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "/usr/bin/env", "-i", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& \/usr\/bin\/env -i OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 pnpm check:changed$/u,
    );
  });

  it("does not mark custom env executables outside the sanitized env", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "./tools/env", "-i", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args.join("\0")).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(output.args.join("\0")).not.toContain("git init -q");
  });

  it("does not mark assignment-prefixed env -i changed gates outside the sanitized env", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "FOO=1", "env", "-i", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args.join("\0")).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(output.args.join("\0")).not.toContain("git init -q");
  });

  it("does not mark timeout-prefixed env -i changed gates outside the sanitized env", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--",
        "timeout",
        "1200s",
        "env",
        "-i",
        "CI=1",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args.join("\0")).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(output.args.join("\0")).not.toContain("git init -q");
  });

  it("does not mark nested env -i changed gates outside the sanitized env", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--", "env", "env", "-i", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args.join("\0")).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(output.args.join("\0")).not.toContain("git init -q");
  });

  it("does not mark shell env -i changed gates outside the sanitized env", () => {
    const shellScript = "bash -lc 'env -i CI=1 pnpm check:changed'";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", shellScript],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("does not treat quoted sparse shell text as a changed gate", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        'cat <<EOF\npnpm check:changed\nEOF\necho "docs; pnpm check:changed"',
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("does not treat escaped heredoc bodies as changed gates", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        "cat <<\\EOF\npnpm check:changed\nEOF\necho done",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("does not treat nested heredoc bodies in substitutions as changed gates", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        'echo "$(cat <<EOF\npnpm check:changed\nEOF\n)"',
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("git init -q");
  });

  it("detects JavaScript commands after hyphenated heredoc delimiters", () => {
    const shellScript = "cat <<EOF-JSON\nnode is literal\nEOF-JSON\npnpm --version";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts for unquoted heredoc command substitutions", () => {
    const shellScript = "cat <<EOF\n$(pnpm --version)\nEOF";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("keeps quoted heredoc command substitutions literal", () => {
    const shellScript = "cat <<'EOF'\n$(pnpm --version)\nEOF";
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("preserves existing shell changed-gate commands after remote Git bootstrap", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--shell", "--", "env CI=1 pnpm check:changed"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
    expect(result.status).toBe(0);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /&& export OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1; env CI=1 pnpm check:changed$/u,
    );
  });

  it("does not inject the POSIX changed-gate bootstrap for Windows targets", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "windows",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.args).not.toContain("--shell");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "windows",
      "--",
      "corepack",
      "pnpm",
      "check:changed",
    ]);
  });

  it("uses a temporary full checkout when local-container syncs clean sparse worktrees", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "local-container", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("creates sparse-sync temporary full checkouts under the durable cache root", () => {
    const syncRoot = path.join(repoRoot, ".crabbox-test-sync-root");
    rmSync(syncRoot, { recursive: true, force: true });
    try {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: { OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      const output = parseFakeCrabboxOutput(result);
      expect(result.status).toBe(0);
      expect(output.cwd).toContain(`${syncRoot}${path.sep}openclaw-crabbox-sync-`);
      expect(readdirSync(syncRoot)).toEqual([]);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
    }
  });

  it("fails sparse-sync full checkout early when the sync root is too low on disk", () => {
    const syncRoot = path.join(repoRoot, ".crabbox-test-low-disk-sync-root");
    rmSync(syncRoot, { recursive: true, force: true });
    try {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "999999999999999",
            OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "insufficient free disk for Crabbox sparse-sync full checkout",
      );
      expect(result.stderr).toContain("OPENCLAW_CRABBOX_SYNC_TMPDIR");
      expect(result.stderr).toContain("OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES");
      expect(readdirSync(syncRoot)).toEqual([]);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed sparse-sync minimum free byte limits", () => {
    const syncRoot = path.join(repoRoot, ".crabbox-test-invalid-disk-sync-root");
    rmSync(syncRoot, { recursive: true, force: true });
    try {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "1024mb",
            OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a non-negative integer byte count, got "1024mb"',
      );
      expect(readdirSync(syncRoot)).toEqual([]);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
    }
  });

  it("rejects unsafe sparse-sync minimum free byte limits", () => {
    const syncRoot = path.join(repoRoot, ".crabbox-test-unsafe-disk-sync-root");
    rmSync(syncRoot, { recursive: true, force: true });
    try {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER + 1),
            OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a safe non-negative integer byte count",
      );
      expect(readdirSync(syncRoot)).toEqual([]);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
    }
  });

  it("rejects malformed sparse-sync keepalive intervals", () => {
    const syncRoot = path.join(repoRoot, ".crabbox-test-invalid-keepalive-sync-root");
    rmSync(syncRoot, { recursive: true, force: true });
    try {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "10ms",
            OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS must be a non-negative integer millisecond interval, got "10ms"',
      );
      expect(readdirSync(syncRoot)).toEqual([]);
    } finally {
      rmSync(syncRoot, { recursive: true, force: true });
    }
  });

  (process.platform === "win32" ? it.skip : it)(
    "terminates Crabbox descendants before parent signal exit",
    async () => {
      await runSignalCleanupProof(async (runnerPid) => {
        process.kill(runnerPid, "SIGTERM");
      });
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "keeps cleanup active after repeated parent signals",
    async () => {
      await runSignalCleanupProof(async (runnerPid) => {
        process.kill(runnerPid, "SIGTERM");
        await delay(50);
        process.kill(runnerPid, "SIGTERM");
      });
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "terminates when sparse-sync temporary full checkouts disappear while Crabbox is running",
    () => {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "10",
            OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE: "1",
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "temporary full checkout disappeared while Crabbox was running",
      );
      expect(result.stderr).toContain("child cwd cannot be repaired");
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "fails successful sparse-sync children when their temporary full checkout vanishes before exit",
    () => {
      const result = runWrapper(
        "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
        ["run", "--provider", "aws", "--", "echo ok"],
        {
          env: {
            OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "60000",
            OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT: "1",
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          },
        },
      );

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "temporary full checkout vanished before Crabbox finished syncing",
      );
    },
  );

  it("uses a temporary full checkout when existing AWS leases sync clean sparse worktrees", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "aws", "--id", "cbx_existing", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).args).toContain("--reclaim");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse branches differ from the Blacksmith ref", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });

  it("keeps sparse dirty worktrees on the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: " M scripts/crabbox-wrapper.mjs\n" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toBe(repoRoot);
  });

  it("keeps local artifact paths rooted at the original checkout", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "main",
        "--capture-stdout=.artifacts/stdout.log",
        "--capture-stderr",
        ".artifacts/stderr.log",
        "--download",
        "/tmp/proof=.artifacts/proof",
        "--",
        "echo ok",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(output.args).toContain(
      `--capture-stdout=${path.join(repoRoot, ".artifacts/stdout.log")}`,
    );
    expect(output.args).toContain(path.join(repoRoot, ".artifacts/stderr.log"));
    expect(output.args).toContain(`/tmp/proof=${path.join(repoRoot, ".artifacts/proof")}`);
  });

  it("preserves artifact-glob downloads from temporary sparse-sync checkouts", () => {
    const preservedDir = path.join(repoRoot, ".crabbox", "runs", "run_fake");
    rmSync(preservedDir, { recursive: true, force: true });

    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "main",
        "--artifact-glob",
        ".artifacts/proof/**",
        "--",
        "echo ok",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    const output = parseFakeCrabboxOutput(result);
    expect(result.status).toBe(0);
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("preserved");
    expect(statSync(path.join(preservedDir, "fake-artifacts.tgz")).isFile()).toBe(true);
    rmSync(preservedDir, { recursive: true, force: true });
  });

  it("uses the temporary full checkout for sparse sync-only runs", () => {
    const result = runWrapper(
      "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n",
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--sync-only",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(parseFakeCrabboxOutput(result).cwd).toContain("openclaw-crabbox-sync-");
  });
});
