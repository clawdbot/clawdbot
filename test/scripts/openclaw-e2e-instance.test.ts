import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const helperPath = path.resolve("scripts/lib/openclaw-e2e-instance.sh");
const hostPath = [
  path.dirname(process.execPath),
  "/usr/local/bin",
  "/opt/homebrew/bin",
  "/usr/bin",
  "/bin",
].join(path.delimiter);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function runHelper(payload: string) {
  return spawnSync(
    "bash",
    [
      "-lc",
      [
        "set -euo pipefail",
        `source ${shellQuote(helperPath)}`,
        `openclaw_e2e_eval_test_state_from_b64 ${shellQuote(payload)}`,
        'printf "value=%s" "${OPENCLAW_E2E_INSTANCE_TEST:-unset}"',
      ].join("; "),
    ],
    { encoding: "utf8" },
  );
}

function base64(script: string): string {
  return execFileSync("base64", { input: script, encoding: "utf8" }).replace(/\s+/gu, "");
}

function shellTestEnv(overrides: Record<string, string | undefined>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    HOME: process.env.HOME ?? os.tmpdir(),
    PATH: hostPath,
    SHELL: "/bin/bash",
    TMPDIR: process.env.TMPDIR ?? os.tmpdir(),
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

function expectShellSuccess(result: ReturnType<typeof spawnSync>) {
  expect(result.status, result.stderr || result.stdout || result.error?.message).toBe(0);
}

function writePackageFixture(packagePath: string): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-package-"));
  try {
    const packageDir = path.join(root, "package");
    fs.mkdirSync(packageDir);
    fs.writeFileSync(
      path.join(packageDir, "package.json"),
      JSON.stringify({ name: "openclaw-e2e-fixture", version: "0.0.0" }),
    );
    execFileSync("tar", ["-czf", packagePath, "-C", root, "package"]);
  } finally {
    fs.rmSync(root, { force: true, recursive: true });
  }
}

function writeNodeShim(binDir: string): void {
  const nodePath = path.join(binDir, "node");
  try {
    fs.symlinkSync(process.execPath, nodePath);
  } catch {
    fs.writeFileSync(nodePath, `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`);
    fs.chmodSync(nodePath, 0o755);
  }
}

function writeBashExecutable(filePath: string, lines: string[]): void {
  fs.writeFileSync(filePath, ["#!/bin/bash", "set -euo pipefail", ...lines, ""].join("\n"));
  fs.chmodSync(filePath, 0o755);
}

function writeFakeTimeout(filePath: string, supportsKillAfter: boolean): void {
  writeBashExecutable(filePath, [
    'if [ "${1:-}" = "--kill-after=1s" ]; then',
    `  exit ${supportsKillAfter ? 0 : 1}`,
    "fi",
    'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
    'while [ "$#" -gt 0 ]; do',
    '  case "$1" in',
    "    --)",
    "      shift",
    "      break",
    "      ;;",
    "    -k|--kill-after)",
    "      shift 2",
    "      ;;",
    "    --kill-after=*|-*)",
    "      shift",
    "      ;;",
    "    *)",
    "      shift",
    "      break",
    "      ;;",
    "  esac",
    "done",
    'exec "$@"',
  ]);
}

function writeFakeNpm(filePath: string): void {
  writeBashExecutable(filePath, ['printf "%s\\n" "$*" >"$OPENCLAW_TEST_NPM_ARGS"']);
}

function expectNpmInstallObserved(argsPath: string, expectedArgs: string, prefix: string): void {
  if (fs.existsSync(argsPath)) {
    expect(fs.readFileSync(argsPath, "utf8").trim()).toBe(expectedArgs);
    return;
  }
  expect(
    fs.existsSync(path.join(prefix, "lib/node_modules/openclaw-e2e-fixture/package.json")),
  ).toBe(true);
}

describe("scripts/lib/openclaw-e2e-instance.sh", () => {
  it("sources decoded test-state scripts", () => {
    const result = runHelper(base64('export OPENCLAW_E2E_INSTANCE_TEST="ok"\n'));

    expect(result.status).toBe(0);
    expect(result.stdout).toBe("value=ok");
  });

  it("fails when the test-state payload is not valid base64", () => {
    const result = runHelper("@@@");

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("Invalid OpenClaw test-state base64 payload");
  });

  it("fails when the test-state payload decodes to an empty script", () => {
    const result = runHelper(base64("\n"));

    expect(result.status).not.toBe(0);
    expect(result.stdout).not.toContain("value=");
    expect(result.stderr).toContain("decoded to an empty script");
  });

  it("wraps package installs with the configured timeout", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      const prefixPath = path.join(tempDir, "prefix");
      writePackageFixture(packagePath);
      writeFakeTimeout(path.join(tempDir, "timeout"), true);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")} ${shellQuote(prefixPath)}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: `${tempDir}${path.delimiter}${hostPath}`,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
            OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
          }),
        },
      );

      expectShellSuccess(result);
      expect(result.stdout).toContain("Installing fixture package...");
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 42s npm install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        npmArgsPath,
        `install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
        prefixPath,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("falls back to plain timeout when kill-after is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-plain-timeout-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      const prefixPath = path.join(tempDir, "prefix");
      writePackageFixture(packagePath);
      writeFakeTimeout(path.join(tempDir, "timeout"), false);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")} ${shellQuote(prefixPath)}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: `${tempDir}${path.delimiter}${hostPath}`,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
            OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
          }),
        },
      );

      expectShellSuccess(result);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `42s npm install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        npmArgsPath,
        `install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
        prefixPath,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses gtimeout when GNU timeout is not on PATH", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-gtimeout-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      const prefixPath = path.join(tempDir, "prefix");
      writePackageFixture(packagePath);
      writeFakeTimeout(path.join(tempDir, "gtimeout"), true);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")} ${shellQuote(prefixPath)}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: tempDir,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
            OPENCLAW_TEST_NPM_BIN: path.join(tempDir, "npm"),
          }),
        },
      );

      expectShellSuccess(result);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 42s npm install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
      );
      expectNpmInstallObserved(
        npmArgsPath,
        `install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
        prefixPath,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("uses the Node watchdog when timeout is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-no-timeout-"));
    try {
      const npmArgsPath = path.join(tempDir, "npm-args.txt");
      const logPath = path.join(tempDir, "install.log");
      const packagePath = path.join(tempDir, "openclaw.tgz");
      const prefixPath = path.join(tempDir, "prefix");
      writePackageFixture(packagePath);
      writeNodeShim(tempDir);
      writeFakeNpm(path.join(tempDir, "npm"));

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_install_package ${shellQuote(logPath)} ${shellQuote("fixture package")} ${shellQuote(prefixPath)}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: tempDir,
            OPENCLAW_CURRENT_PACKAGE_TGZ: packagePath,
            OPENCLAW_E2E_NPM_INSTALL_TIMEOUT: "42s",
            OPENCLAW_TEST_NPM_ARGS: npmArgsPath,
          }),
        },
      );

      expectShellSuccess(result);
      expect(fs.readFileSync(logPath, "utf8")).toContain("using Node watchdog");
      expectNpmInstallObserved(
        npmArgsPath,
        `install -g --prefix ${prefixPath} ${packagePath} --no-fund --no-audit`,
        prefixPath,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("bounds commands with the Node watchdog when timeout is unavailable", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-node-watchdog-"));
    try {
      writeNodeShim(tempDir);
      const startedAt = Date.now();
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_maybe_timeout 200ms ${shellQuote(process.execPath)} -e ${shellQuote("setInterval(() => {}, 1000)")}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: tempDir,
          }),
          timeout: 5_000,
        },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.status).toBe(124);
      expect(elapsedMs).toBeLessThan(4_000);
      expect(result.stderr).toContain("using Node watchdog");
      expect(result.stderr).toContain("OpenClaw E2E command timed out after 200ms");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("escalates Node watchdog children that ignore parent termination", () => {
    const tempDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "openclaw-e2e-instance-node-watchdog-signal-"),
    );
    try {
      writeNodeShim(tempDir);
      const childPath = path.join(tempDir, "ignore-term.cjs");
      const pidPath = path.join(tempDir, "child.pid");
      const watchdogPidPath = path.join(tempDir, "watchdog.pid");
      fs.writeFileSync(
        childPath,
        [
          "const fs = require('node:fs');",
          "fs.writeFileSync(process.argv[2], String(process.pid));",
          "fs.writeFileSync(process.argv[3], String(process.ppid));",
          "process.on('SIGTERM', () => {});",
          "setInterval(() => {}, 1000);",
          "",
        ].join("\n"),
      );

      const script = `
set -euo pipefail
source ${shellQuote(helperPath)}
export OPENCLAW_E2E_TIMEOUT_KILL_GRACE_MS=100
openclaw_e2e_maybe_timeout 30s node ${shellQuote(childPath)} ${shellQuote(pidPath)} ${shellQuote(watchdogPidPath)} &
wrapper_pid="$!"
for ((i = 0; i < 100; i += 1)); do
  [ -s ${shellQuote(pidPath)} ] && [ -s ${shellQuote(watchdogPidPath)} ] && break
  /bin/sleep 0.02
done
[ -s ${shellQuote(pidPath)} ]
[ -s ${shellQuote(watchdogPidPath)} ]
kill -TERM "$(/bin/cat ${shellQuote(watchdogPidPath)})"
set +e
wait "$wrapper_pid"
status="$?"
set -e
[ "$status" = "143" ]
child_pid="$(/bin/cat ${shellQuote(pidPath)})"
for ((i = 0; i < 100; i += 1)); do
  kill -0 "$child_pid" 2>/dev/null || exit 0
  /bin/sleep 0.02
done
echo "child still alive after watchdog termination" >&2
exit 1
`;

      const result = spawnSync("/bin/bash", ["-c", script], {
        encoding: "utf8",
        env: shellTestEnv({
          PATH: tempDir,
        }),
        timeout: 5_000,
      });

      expectShellSuccess(result);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("bounds HTTP readiness probes when a server accepts connections but never responds", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-http-probe-"));
    try {
      const portPath = path.join(tempDir, "port.txt");
      const serverPath = path.join(tempDir, "stalling-server.cjs");
      fs.writeFileSync(
        serverPath,
        [
          "const fs = require('node:fs');",
          "const net = require('node:net');",
          "const server = net.createServer((socket) => socket.on('data', () => {}));",
          "server.listen(0, '127.0.0.1', () => {",
          "  fs.writeFileSync(process.argv[2], String(server.address().port));",
          "});",
          "process.on('SIGTERM', () => server.close(() => process.exit(0)));",
          "",
        ].join("\n"),
      );

      const startedAt = Date.now();
      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `${shellQuote(process.execPath)} ${shellQuote(serverPath)} ${shellQuote(portPath)} & server_pid=$!`,
            'trap \'kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true\' EXIT',
            `for _ in $(seq 1 50); do [ -s ${shellQuote(portPath)} ] && break; sleep 0.02; done`,
            `port="$(cat ${shellQuote(portPath)})"`,
            `source ${shellQuote(helperPath)}`,
            'openclaw_e2e_probe_http_status "http://127.0.0.1:${port}/health" 200 100',
          ].join("; "),
        ],
        { encoding: "utf8", timeout: 3_000 },
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(elapsedMs).toBeLessThan(2_500);
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("wraps logged OpenClaw E2E commands with the configured timeout", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-run-logged-"));
    const logLabel = path.basename(tempDir);
    const logPath = `/tmp/openclaw-onboard-${logLabel}.log`;
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const commandArgsPath = path.join(tempDir, "command-args.txt");
      fs.writeFileSync(
        path.join(tempDir, "timeout"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
          'while [ "$#" -gt 0 ] && [ "$1" != "fixture-command" ]; do shift; done',
          '[ "$#" -gt 0 ] || exit 127',
          "shift",
          'exec "$OPENCLAW_TEST_COMMAND_BIN" "$@"',
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tempDir, "fixture-command"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_COMMAND_ARGS"',
          'printf "fixture output\\n"',
          "",
        ].join("\n"),
      );
      fs.chmodSync(path.join(tempDir, "timeout"), 0o755);
      fs.chmodSync(path.join(tempDir, "fixture-command"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_run_logged ${shellQuote(logLabel)} fixture-command one two`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: `${tempDir}:${hostPath}`,
            OPENCLAW_E2E_COMMAND_TIMEOUT: "17s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_COMMAND_ARGS: commandArgsPath,
            OPENCLAW_TEST_COMMAND_BIN: path.join(tempDir, "fixture-command"),
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        "--kill-after=30s 17s fixture-command one two",
      );
      expect(fs.readFileSync(commandArgsPath, "utf8").trim()).toBe("one two");
      expect(fs.readFileSync(logPath, "utf8")).toContain("fixture output");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
      fs.rmSync(logPath, { force: true });
    }
  });

  it("wraps package-installed OpenClaw CLI calls with the configured timeout", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-openclaw-cli-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const commandArgsPath = path.join(tempDir, "openclaw-args.txt");
      fs.writeFileSync(
        path.join(tempDir, "timeout"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
          `while [ "$#" -gt 0 ] && [ "$1" != ${shellQuote(path.join(tempDir, "openclaw"))} ]; do shift; done`,
          '[ "$#" -gt 0 ] || exit 127',
          "shift",
          'exec "$OPENCLAW_TEST_OPENCLAW_BIN" "$@"',
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tempDir, "openclaw"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_COMMAND_ARGS"',
          "",
        ].join("\n"),
      );
      fs.chmodSync(path.join(tempDir, "timeout"), 0o755);
      fs.chmodSync(path.join(tempDir, "openclaw"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            "openclaw_e2e_enable_openclaw_cli_timeout",
            "openclaw_e2e_enable_openclaw_cli_timeout",
            "openclaw plugins list --json",
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: `${tempDir}:${hostPath}`,
            OPENCLAW_E2E_COMMAND_TIMEOUT: "23s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_COMMAND_ARGS: commandArgsPath,
            OPENCLAW_TEST_OPENCLAW_BIN: path.join(tempDir, "openclaw"),
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 23s ${path.join(tempDir, "openclaw")} plugins list --json`,
      );
      expect(fs.readFileSync(commandArgsPath, "utf8").trim()).toBe("plugins list --json");
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("wraps interactive PTY scripts with the configured timeout", () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-e2e-instance-pty-timeout-"));
    try {
      const timeoutArgsPath = path.join(tempDir, "timeout-args.txt");
      const scriptArgsPath = path.join(tempDir, "script-args.txt");
      const logPath = path.join(tempDir, "pty.log");
      fs.writeFileSync(
        path.join(tempDir, "timeout"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "--kill-after=1s" ]; then exit 0; fi',
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_TIMEOUT_ARGS"',
          'while [ "$#" -gt 0 ] && [ "$1" != "script" ]; do shift; done',
          '[ "$#" -gt 0 ] || exit 127',
          "shift",
          'exec "$OPENCLAW_TEST_SCRIPT_BIN" "$@"',
          "",
        ].join("\n"),
      );
      fs.writeFileSync(
        path.join(tempDir, "script"),
        [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          'if [ "${1:-}" = "--version" ]; then exit 0; fi',
          'printf "%s\\n" "$*" >"$OPENCLAW_TEST_SCRIPT_ARGS"',
          "",
        ].join("\n"),
      );
      fs.chmodSync(path.join(tempDir, "timeout"), 0o755);
      fs.chmodSync(path.join(tempDir, "script"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            `source ${shellQuote(helperPath)}`,
            `openclaw_e2e_run_script_with_pty ${shellQuote("node /tmp/entry onboard")} ${shellQuote(logPath)}`,
          ].join("; "),
        ],
        {
          encoding: "utf8",
          env: shellTestEnv({
            PATH: `${tempDir}:${hostPath}`,
            OPENCLAW_E2E_COMMAND_TIMEOUT: "31s",
            OPENCLAW_TEST_TIMEOUT_ARGS: timeoutArgsPath,
            OPENCLAW_TEST_SCRIPT_ARGS: scriptArgsPath,
            OPENCLAW_TEST_SCRIPT_BIN: path.join(tempDir, "script"),
          }),
        },
      );

      expect(result.status).toBe(0);
      expect(fs.readFileSync(timeoutArgsPath, "utf8").trim()).toBe(
        `--kill-after=30s 31s script -q -f -c node /tmp/entry onboard ${logPath}`,
      );
      expect(fs.readFileSync(scriptArgsPath, "utf8").trim()).toBe(
        `-q -f -c node /tmp/entry onboard ${logPath}`,
      );
    } finally {
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });
});
