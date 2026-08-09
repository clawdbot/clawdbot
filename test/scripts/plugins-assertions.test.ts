// Plugins Assertions tests cover plugins assertions script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer, request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const ASSERTIONS_SCRIPT = "scripts/e2e/lib/plugins/assertions.mjs";
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'\\''`)}'`;
}

function writeJson(filePath: string, value: unknown) {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function runAssertionAsync(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ status: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, [ASSERTIONS_SCRIPT, ...args], {
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const stdout = createBoundedChildOutput();
      const stderr = createBoundedChildOutput();
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`assertion helper did not exit: ${args.join(" ")}`));
      }, 2_000);
      timeout.unref();

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => {
        stdout.append(chunk);
      });
      child.stderr.on("data", (chunk) => {
        stderr.append(chunk);
      });
      child.on("error", (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      child.on("close", (status) => {
        clearTimeout(timeout);
        resolve({ status, stdout: stdout.text(), stderr: stderr.text() });
      });
    },
  );
}

function writeFixtureServerShims(binDir: string, pidPath: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$$" >"$OPENCLAW_TEST_FIXTURE_SERVER_PID"',
      "trap 'exit 0' TERM",
      "while true; do /bin/sleep 1; done",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(path.join(binDir, "node"), 0o755);
  chmodSync(path.join(binDir, "sleep"), 0o755);
  writeFileSync(pidPath, "");
}

function writeStubbornFixtureServerShims(binDir: string, pidPath: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/bash",
      'printf "%s\\n" "$$" >"$OPENCLAW_TEST_FIXTURE_SERVER_PID"',
      "trap ':' TERM",
      "while true; do /bin/sleep 1; done",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(path.join(binDir, "node"), 0o755);
  chmodSync(path.join(binDir, "sleep"), 0o755);
  writeFileSync(pidPath, "");
}

function writeCrashingFixtureServerShim(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  writeFileSync(
    path.join(binDir, "node"),
    [
      "#!/bin/bash",
      'printf "DO_NOT_DUMP_PLUGIN_FIXTURE_PREFIX\\n"',
      'printf "%2048s" "" | tr " " x',
      'printf "\\nPLUGIN_FIXTURE_TAIL_MARKER\\n"',
      "exit 1",
      "",
    ].join("\n"),
  );
  writeFileSync(path.join(binDir, "sleep"), "#!/bin/bash\nexit 0\n");
  chmodSync(path.join(binDir, "node"), 0o755);
  chmodSync(path.join(binDir, "sleep"), 0o755);
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function waitForDead(pid: number, timeoutMs = 2_000): void {
  const startedAt = Date.now();
  while (isProcessAlive(pid)) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error(`pid ${pid} is still alive`);
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function runPluginsSweepShell(script: string, env: NodeJS.ProcessEnv = {}) {
  return spawnSync("/bin/bash", ["-c", script], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function waitForPortFile(portFile: string): Promise<number> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(portFile)) {
      const port = Number(readFileSync(portFile, "utf8"));
      if (Number.isInteger(port) && port > 0) {
        return port;
      }
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 5);
    });
  }
  throw new Error(`timed out waiting for ${portFile}`);
}

function requestFixtureRegistry(
  port: number,
  requestPath: string,
  headers: Record<string, string> = {},
): Promise<{ body: string; contentLength: string | undefined; statusCode: number | undefined }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      { headers, host: "127.0.0.1", method: "GET", path: requestPath, port },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk: string) => {
          body += chunk;
        });
        response.on("end", () => {
          resolve({
            body,
            contentLength: response.headers["content-length"],
            statusCode: response.statusCode,
          });
        });
      },
    );
    request.setTimeout(2_000, () => {
      request.destroy(new Error(`timed out requesting ${requestPath}`));
    });
    request.on("error", reject);
    request.end();
  });
}

describe("plugins Docker assertions", () => {
  it("rejects loose ClawHub preflight limits instead of parsing prefixes", () => {
    const timeoutResult = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "clawhub-preflight"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "1e3",
      },
    });
    expect(timeoutResult.status).not.toBe(0);
    expect(timeoutResult.stderr).toContain(
      "invalid OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: 1e3",
    );

    const bodyLimitResult = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "clawhub-preflight"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES: "1000bytes",
      },
    });
    expect(bodyLimitResult.status).not.toBe(0);
    expect(bodyLimitResult.stderr).toContain(
      "invalid OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES: 1000bytes",
    );
  });

  it("passes ClawHub preflight body timeouts into the bounded reader", () => {
    const script = readFileSync(ASSERTIONS_SCRIPT, "utf8");

    expect(script).toContain("run(controller.signal, timeoutPromise)");
    expect(
      script.match(
        /readBoundedResponseText\([\s\S]*?limits\.bodyMaxBytes,\n\s+\{ createTooLargeError: createBoundedResponseTooLargeError, timeoutPromise \},/gu,
      ),
    ).toHaveLength(2);
  });

  it("keeps sweep artifact paths aligned with the assertion scratch root", () => {
    const scripts = [
      "scripts/e2e/lib/plugins/sweep.sh",
      "scripts/e2e/lib/plugins/marketplace.sh",
      "scripts/e2e/lib/plugins/clawhub.sh",
    ];

    for (const scriptPath of scripts) {
      const script = readFileSync(scriptPath, "utf8");
      const scriptWithoutDefaultScratch = script.replace(
        'mktemp -d "/tmp/openclaw-plugins.XXXXXX"',
        "",
      );
      expect(script).toContain("OPENCLAW_PLUGINS_TMP_DIR");
      expect(scriptWithoutDefaultScratch).not.toMatch(
        /\/tmp\/(?:plugins|marketplace|demo-plugin|is-number|openclaw-plugin|openclaw-clawhub)/,
      );
    }
  });

  it("cleans the default plugin sweep scratch root", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-sweep-cleanup-"));
    const marker = path.join(root, "scratch-path.txt");
    try {
      const result = runPluginsSweepShell(
        `
set -euo pipefail
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
source scripts/e2e/lib/plugins/sweep.sh
printf '%s\\n' "$OPENCLAW_PLUGINS_TMP_DIR" > "$MARKER"
test -d "$OPENCLAW_PLUGINS_TMP_DIR"
cleanup_openclaw_plugins_sweep
test ! -e "$OPENCLAW_PLUGINS_TMP_DIR"
`,
        { MARKER: marker },
      );

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      const scratchRoot = readFileSync(marker, "utf8").trim();
      expect(scratchRoot).toContain("/tmp/openclaw-plugins.");
      expect(existsSync(scratchRoot)).toBe(false);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("preserves caller-provided plugin sweep scratch roots", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-sweep-caller-"));
    const scratchRoot = path.join(root, "scratch");
    try {
      const result = runPluginsSweepShell(
        `
set -euo pipefail
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_TMP_DIR="$SCRATCH_ROOT"
source scripts/e2e/lib/plugins/sweep.sh
test -d "$OPENCLAW_PLUGINS_TMP_DIR"
cleanup_openclaw_plugins_sweep
test -d "$OPENCLAW_PLUGINS_TMP_DIR"
`,
        { SCRATCH_ROOT: scratchRoot },
      );

      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
      expect(result.status).toBe(0);
      expect(existsSync(scratchRoot)).toBe(true);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each(
    (["capture", "logged"] as const).flatMap((mode) =>
      [0, 23, 124].flatMap((status) =>
        [false, true].map((traceEnabled) => ({ mode, status, traceEnabled })),
      ),
    ),
  )(
    "bounds $mode diagnostics with exit $status and lifecycle tracing $traceEnabled",
    (testCase) => {
      const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-sweep-diagnostics-"));
      const outputFile = path.join(root, "plugins-git-inspect.json");
      const capturedOutput = `DO_NOT_DUMP_CAPTURED_PLUGIN_OUTPUT\n${"x".repeat(32 * 1024)}\nCAPTURED_PLUGIN_OUTPUT_TAIL`;
      const fixtureApiKey = ["sk", "proj", "plugin", "fixture", "secret"].join("-");
      const punctuationApiKey = ["sess", "plugin", "punctuation", "secret"].join("-");
      const startOfLineApiKey = ["rk", "plugin", "start", "secret"].join("-");
      const boundarySecretSuffix = "PLUGIN_BOUNDARY_SECRET_SUFFIX_MUST_NOT_LEAK";
      const boundaryApiKey = ["sk", "proj", "z".repeat(256), boundarySecretSuffix].join("-");
      const capturedError = `DO_NOT_DUMP_PLUGIN_STDERR_PREFIX\n${"y".repeat(32 * 1024)}\n${startOfLineApiKey}\nPLUGIN_STDERR_TAIL_MARKER task-runner risk-score disk-space Authorization: Bearer plugin-fixture-bearer OPENAI_API_KEY=${fixtureApiKey} [${punctuationApiKey}]\n${boundaryApiKey}`;
      const command =
        testCase.mode === "capture"
          ? 'run_plugins_openclaw_capture "$OUTPUT_FILE" plugins inspect demo-plugin --runtime --json'
          : 'run_plugins_openclaw_logged install-git plugins install "git:file:///tmp/fixture@revision" --force';

      try {
        const unredactedTail = Buffer.from(`${capturedError}\n`, "utf8")
          .subarray(-192)
          .toString("utf8");
        expect(unredactedTail).toContain(boundarySecretSuffix);
        expect(unredactedTail).not.toContain(["sk", "proj"].join("-"));

        const result = runPluginsSweepShell(
          `
set -euo pipefail
export OPENCLAW_PLUGINS_SWEEP_SOURCE_ONLY=1
export OPENCLAW_PLUGINS_TMP_DIR="$SCRATCH_ROOT"
export OPENCLAW_PLUGINS_CLI_TIMEOUT=1s
export OPENCLAW_ENTRY=fixture-entry
source scripts/e2e/lib/plugins/sweep.sh
umask 000
openclaw_e2e_maybe_timeout() {
  local raw_stderr_file
  local raw_stderr_mode
  for raw_stderr_file in "$SCRATCH_ROOT"/openclaw-plugin-stderr.*; do
    [[ -f "$raw_stderr_file" ]] || return 86
    if raw_stderr_mode="$(stat -f '%Lp' "$raw_stderr_file" 2>/dev/null)"; then
      :
    elif raw_stderr_mode="$(stat -c '%a' "$raw_stderr_file" 2>/dev/null)"; then
      :
    else
      return 87
    fi
    [[ "$raw_stderr_mode" == "600" ]] || return 88
  done
  printf '%s\\n' "$CAPTURED_OUTPUT"
  printf '%s\\n' "$CAPTURED_STDERR" >&2
  if [[ "\${OPENCLAW_PLUGIN_LIFECYCLE_TRACE:-}" == "1" ]]; then
    printf '%s\\n' '[plugins:lifecycle] shim' >&2
  fi
  return "$CAPTURE_STATUS"
}
${command}
`,
          {
            CAPTURED_OUTPUT: capturedOutput,
            CAPTURED_STDERR: capturedError,
            CAPTURE_STATUS: String(testCase.status),
            OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "192",
            OPENCLAW_PLUGIN_LIFECYCLE_TRACE: testCase.traceEnabled ? "1" : "0",
            OUTPUT_FILE: outputFile,
            SCRATCH_ROOT: root,
          },
        );

        expect(result.status).toBe(testCase.status);
        expect(result.stdout).toBe("");
        if (testCase.mode === "capture") {
          expect(readFileSync(outputFile, "utf8")).toBe(`${capturedOutput}\n`);
        }
        expect(result.stderr.length).toBeLessThan(1_024);
        expect(result.stderr).not.toContain("DO_NOT_DUMP_CAPTURED_PLUGIN_OUTPUT");
        expect(result.stderr).not.toContain("CAPTURED_PLUGIN_OUTPUT_TAIL");
        expect(result.stderr).not.toContain("DO_NOT_DUMP_PLUGIN_STDERR_PREFIX");
        expect(result.stderr).not.toContain("plugin-fixture-bearer");
        expect(result.stderr).not.toContain(fixtureApiKey);
        expect(result.stderr).not.toContain(punctuationApiKey);
        expect(result.stderr).not.toContain(startOfLineApiKey);
        expect(result.stderr).not.toContain(boundarySecretSuffix);
        expect(result.stderr).not.toContain(boundaryApiKey);
        expect(
          readdirSync(root).filter(
            (name) => name.startsWith("openclaw-plugin-") || name.endsWith(".stderr.log"),
          ),
        ).toEqual([]);

        const printsDiagnostics =
          testCase.mode === "capture" || testCase.status !== 0 || testCase.traceEnabled;
        if (printsDiagnostics) {
          expect(result.stderr).toContain("truncated: showing last 192");
          expect(result.stderr).toContain("PLUGIN_STDERR_TAIL_MARKER");
          expect(result.stderr).toContain("task-runner");
          expect(result.stderr).toContain("risk-score");
          expect(result.stderr).toContain("disk-space");
          expect(result.stderr).toContain("Authorization: Bearer [REDACTED]");
          expect(result.stderr).toContain("OPENAI_API_KEY=[REDACTED]");
          expect(result.stderr).toContain("[[REDACTED]]");
          expect(result.stderr).toContain("[REDACTED]");
        } else {
          expect(result.stderr).toBe("");
        }
        if (testCase.traceEnabled) {
          expect(result.stderr).toContain("[plugins:lifecycle]");
        } else {
          expect(result.stderr).not.toContain("[plugins:lifecycle]");
        }
        if (testCase.status !== 0) {
          const label = testCase.mode === "capture" ? "plugins-git-inspect.json" : "install-git";
          const noun = testCase.mode === "capture" ? "capture" : "command";
          const detail =
            testCase.status === 124
              ? `timed out after 1s: ${label}`
              : `failed with status ${testCase.status}: ${label}`;
          expect(result.stderr).toContain(`Plugin sweep ${noun} ${detail}`);
        }
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("scans plugin assertion logs without echoing whole files on failure", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-update-log-"));
    try {
      const passRoot = path.join(root, "pass");
      mkdirSync(passRoot, { recursive: true });
      writeFileSync(
        path.join(passRoot, "plugins-dir-update.log"),
        `Skipping "demo-plugin-dir" (source: path).\n${"x".repeat(256 * 1024)}`,
        "utf8",
      );
      const pass = await runAssertionAsync(["plugin-dir-update-skipped"], {
        OPENCLAW_PLUGINS_TMP_DIR: passRoot,
      });
      expect(pass.status).toBe(0);

      const failRoot = path.join(root, "fail");
      mkdirSync(failRoot, { recursive: true });
      writeFileSync(
        path.join(failRoot, "plugins-dir-update.log"),
        `${"x".repeat(256 * 1024)}\nmissing marker tail`,
        "utf8",
      );
      const fail = await runAssertionAsync(["plugin-dir-update-skipped"], {
        OPENCLAW_PLUGINS_TMP_DIR: failRoot,
      });
      expect(fail.status).toBe(1);
      expect(fail.stderr).toContain("Output tail:");
      expect(fail.stderr).toContain("missing marker tail");
      expect(fail.stderr.length).toBeLessThan(20 * 1024);

      const invalidRoot = path.join(root, "invalid");
      const invalidHome = path.join(root, "home");
      mkdirSync(invalidRoot, { recursive: true });
      mkdirSync(invalidHome, { recursive: true });
      writeFileSync(
        path.join(invalidRoot, "plugins-invalid-openclaw-extensions.log"),
        `openclaw.extensions[1]\n${"x".repeat(256 * 1024)}\nmissing validation tail`,
        "utf8",
      );
      writeJson(path.join(invalidRoot, "plugins-invalid-openclaw-extensions-list.json"), {
        plugins: [],
      });
      const invalid = await runAssertionAsync(["invalid-openclaw-extensions"], {
        HOME: invalidHome,
        OPENCLAW_PLUGINS_TMP_DIR: invalidRoot,
      });
      expect(invalid.status).toBe(1);
      expect(invalid.stderr).toContain("malformed metadata install output");
      expect(invalid.stderr).toContain("missing validation tail");
      expect(invalid.stderr.length).toBeLessThan(20 * 1024);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("cleans npm fixture registry children when readiness times out", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-npm-fixture-cleanup-"));
    try {
      const binDir = path.join(root, "bin");
      const fixtureDir = path.join(root, "fixture");
      const cleanupPath = path.join(root, "caller-cleanup");
      const pidPath = path.join(root, "server.pid");
      mkdirSync(fixtureDir);
      writeFixtureServerShims(binDir, pidPath);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "set +e",
            `( set -e; trap 'printf caller-cleanup > ${shellQuote(cleanupPath)}' EXIT; start_npm_fixture_registry fixture-pkg 1.0.0 ${shellQuote(path.join(root, "fixture.tgz"))} ${shellQuote(fixtureDir)} )`,
            'status="$?"',
            "set -e",
            '[ "$status" != "0" ]',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_TEST_FIXTURE_SERVER_PID: pidPath,
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      waitForDead(pid);
      expect(readFileSync(cleanupPath, "utf8")).toBe("caller-cleanup");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("force-kills stubborn npm fixture registry children during cleanup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-npm-fixture-kill-"));
    try {
      const binDir = path.join(root, "bin");
      const fixtureDir = path.join(root, "fixture");
      const pidPath = path.join(root, "server.pid");
      mkdirSync(fixtureDir);
      writeStubbornFixtureServerShims(binDir, pidPath);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "set +e",
            `( start_npm_fixture_registry fixture-pkg 1.0.0 ${shellQuote(path.join(root, "fixture.tgz"))} ${shellQuote(fixtureDir)} )`,
            'status="$?"',
            "set -e",
            '[ "$status" != "0" ]',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_PLUGINS_FIXTURE_STOP_ATTEMPTS: "2",
            OPENCLAW_PLUGINS_FIXTURE_STOP_INTERVAL_SECONDS: "0.05",
            OPENCLAW_TEST_FIXTURE_SERVER_PID: pidPath,
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      waitForDead(pid);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid fixture stop attempts before cleanup polling", () => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/e2e/lib/plugins/fixtures.sh",
          "openclaw_plugins_signal_fixture_process() { echo signal; }",
          "openclaw_plugins_fixture_process_alive() { echo probe; return 1; }",
          "set +e",
          "openclaw_plugins_stop_fixture_process 12345",
          'status="$?"',
          "set -e",
          'exit "$status"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_PLUGINS_FIXTURE_STOP_ATTEMPTS: "2x",
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_PLUGINS_FIXTURE_STOP_ATTEMPTS: 2x");
    expect(result.stdout).not.toContain("signal");
    expect(result.stdout).not.toContain("probe");
  });

  it("rejects invalid fixture stop intervals before cleanup polling", () => {
    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        [
          "set -euo pipefail",
          "source scripts/e2e/lib/plugins/fixtures.sh",
          "openclaw_plugins_signal_fixture_process() { echo signal; }",
          "openclaw_plugins_fixture_process_alive() { echo probe; return 1; }",
          "set +e",
          "openclaw_plugins_stop_fixture_process 12345",
          'status="$?"',
          "set -e",
          'exit "$status"',
        ].join("\n"),
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_PLUGINS_FIXTURE_STOP_ATTEMPTS: "2",
          OPENCLAW_PLUGINS_FIXTURE_STOP_INTERVAL_SECONDS: "soon",
        },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("invalid OPENCLAW_PLUGINS_FIXTURE_STOP_INTERVAL_SECONDS: soon");
    expect(result.stdout).not.toContain("signal");
    expect(result.stdout).not.toContain("probe");
  });

  it("bounds npm fixture registry logs when readiness fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-npm-fixture-log-"));
    try {
      const binDir = path.join(root, "bin");
      const fixtureDir = path.join(root, "fixture");
      mkdirSync(fixtureDir);
      writeCrashingFixtureServerShim(binDir);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "set +e",
            `start_npm_fixture_registry fixture-pkg 1.0.0 ${shellQuote(path.join(root, "fixture.tgz"))} ${shellQuote(fixtureDir)}`,
            'status="$?"',
            "set -e",
            'printf "status=%s\\n" "$status"',
            '[ "$status" != "0" ]',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "80",
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("truncated: showing last 80");
      expect(result.stdout).toContain("PLUGIN_FIXTURE_TAIL_MARKER");
      expect(result.stdout).not.toContain("DO_NOT_DUMP_PLUGIN_FIXTURE_PREFIX");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("keeps npm fixture registry alive after malformed package paths", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-request-");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr = createBoundedChildOutput();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });

    try {
      const port = await waitForPortFile(portFile);
      const malformed = await requestFixtureRegistry(port, "/%");

      expect(malformed.statusCode).toBe(404);
      expect(malformed.body).toContain("not found");
      expect(child.exitCode, stderr.text()).toBeNull();

      const valid = await requestFixtureRegistry(port, "/@openclaw%2Fdemo-plugin-npm");

      expect(valid.statusCode, stderr.text()).toBe(200);
      expect(JSON.parse(valid.body)).toMatchObject({
        name: "@openclaw/demo-plugin-npm",
        "dist-tags": { latest: "1.0.0" },
      });
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
    }
  });

  it("serves tarball dependencies using the request-visible registry origin", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-package-");
    const packageDir = path.join(root, "package");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "openclaw.tgz");
    mkdirSync(packageDir);
    writeJson(path.join(packageDir, "package.json"), {
      name: "openclaw",
      version: "2026.7.1-beta.3",
      dependencies: {
        "@openclaw/ai": "2026.7.1-beta.3",
        zod: "4.3.6",
      },
      optionalDependencies: {
        "sqlite-vec": "0.1.7-alpha.2",
      },
    });
    const packed = spawnSync("tar", ["-czf", tarballPath, "-C", root, "package"], {
      encoding: "utf8",
    });
    expect(packed.status, packed.stderr).toBe(0);

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "openclaw",
        "2026.7.1-beta.3",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_DIST_TAGS: "latest=0.0.0,beta=2026.7.1-beta.3",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const port = await waitForPortFile(portFile);
      const response = await requestFixtureRegistry(port, "/openclaw", {
        host: `192.0.2.2:${port}`,
      });
      const metadata = JSON.parse(response.body);

      expect(response.statusCode).toBe(200);
      expect(metadata["dist-tags"]).toEqual({
        latest: "0.0.0",
        beta: "2026.7.1-beta.3",
      });
      expect(metadata.versions["2026.7.1-beta.3"].dependencies).toEqual({
        "@openclaw/ai": "2026.7.1-beta.3",
        zod: "4.3.6",
      });
      expect(metadata.versions["2026.7.1-beta.3"].optionalDependencies).toEqual({
        "sqlite-vec": "0.1.7-alpha.2",
      });
      expect(metadata.versions["2026.7.1-beta.3"].dist.tarball).toBe(
        `http://192.0.2.2:${port}/openclaw/-/openclaw.tgz`,
      );
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
    }
  });

  it("recomputes proxied content length after fetch decodes the response", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-proxy-");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    const upstreamBody = JSON.stringify({ payload: "x".repeat(1_000) });
    const compressedBody = gzipSync(upstreamBody);
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const upstream = createServer((_request, response) => {
      response.writeHead(200, {
        "content-encoding": "gzip",
        "content-length": String(compressedBody.length),
        "content-type": "application/json",
      });
      response.end(compressedBody);
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream registry address");
    }

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const port = await waitForPortFile(portFile);
      const response = await requestFixtureRegistry(port, "/upstream-package");

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(upstreamBody);
      expect(response.contentLength).toBe(String(Buffer.byteLength(upstreamBody)));
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });

  it("streams proxied npm tarballs without buffering a content length", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-tarball-proxy-");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    const upstreamBody = "x".repeat(1024 * 1024);
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const upstream = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(upstreamBody.slice(0, upstreamBody.length / 2));
      response.end(upstreamBody.slice(upstreamBody.length / 2));
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream registry address");
    }

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const port = await waitForPortFile(portFile);
      const response = await requestFixtureRegistry(
        port,
        "/@openai/codex/-/codex-0.145.0-linux-arm64.tgz",
      );

      expect(response.statusCode).toBe(200);
      expect(response.contentLength).toBeUndefined();
      expect(response.body).toBe(upstreamBody);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });

  it("rejects oversized upstream bodies without stopping the fixture registry", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-proxy-limit-");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const upstream = createServer((_request, response) => {
      response.writeHead(200, {
        "content-length": String(64 * 1024 * 1024 + 1),
        "content-type": "application/octet-stream",
      });
      response.end("oversized");
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream registry address");
    }

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr = createBoundedChildOutput();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });

    try {
      const port = await waitForPortFile(portFile);
      const oversized = await requestFixtureRegistry(port, "/oversized-package");

      expect(oversized.statusCode, stderr.text()).toBe(502);
      expect(oversized.body).toContain(
        "npm registry upstream response body exceeded 67108864 bytes",
      );

      const local = await requestFixtureRegistry(port, "/@openclaw%2Fdemo-plugin-npm");

      expect(local.statusCode, stderr.text()).toBe(200);
      expect(child.exitCode, stderr.text()).toBeNull();
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });

  it("times out stalled upstream response bodies without stopping the fixture registry", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-proxy-timeout-");
    const portFile = path.join(root, "port");
    const preloadPath = path.join(root, "shorten-abort-timeout.mjs");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    let upstreamHits = 0;
    writeFileSync(
      preloadPath,
      [
        "const nativeFetch = globalThis.fetch;",
        "let timeoutController;",
        "let timeoutWatchdog;",
        "AbortSignal.timeout = () => {",
        "  timeoutController = new AbortController();",
        "  timeoutWatchdog = setTimeout(() => process.exit(86), 5_000);",
        "  timeoutWatchdog.unref();",
        "  return timeoutController.signal;",
        "};",
        "globalThis.fetch = async (...args) => {",
        "  const response = await nativeFetch(...args);",
        "  let firstChunk = true;",
        "  const body = response.body.pipeThrough(",
        "    new TransformStream({",
        "      transform(chunk, controller) {",
        "        controller.enqueue(chunk);",
        "        if (firstChunk) {",
        "          firstChunk = false;",
        "          clearTimeout(timeoutWatchdog);",
        '          queueMicrotask(() => timeoutController.abort(new DOMException("timeout", "TimeoutError")));',
        "        }",
        "      },",
        "    }),",
        "  );",
        "  return new Response(body, response);",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const upstream = createServer((_request, response) => {
      upstreamHits += 1;
      response.writeHead(200, {
        "content-length": "1024",
        "content-type": "application/json",
      });
      response.write('{"partial":');
    });
    await new Promise<void>((resolve) => {
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === "string") {
      throw new Error("expected upstream registry address");
    }

    const child = spawn(
      process.execPath,
      [
        "--import",
        pathToFileURL(preloadPath).href,
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${upstreamAddress.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stderr = createBoundedChildOutput();
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });

    try {
      const port = await waitForPortFile(portFile);
      const stalled = await requestFixtureRegistry(port, "/stalled-package");

      expect(stalled.statusCode, stderr.text()).toBe(502);
      expect(stalled.body).toContain("upstream registry request failed");
      expect(upstreamHits).toBe(1);

      const local = await requestFixtureRegistry(port, "/@openclaw%2Fdemo-plugin-npm");

      expect(local.statusCode, stderr.text()).toBe(200);
      expect(child.exitCode, stderr.text()).toBeNull();
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => {
        upstream.close(() => resolve());
      });
    }
  });

  it("does not let absolute-form request targets escape the configured upstream", async () => {
    const root = autoCleanupTempDirs.make("openclaw-plugin-npm-fixture-proxy-origin-");
    const portFile = path.join(root, "port");
    const tarballPath = path.join(root, "demo-plugin.tgz");
    let configuredUpstreamHits = 0;
    let escapeServerHits = 0;
    let configuredUpstreamTarget: string | undefined;
    writeFileSync(tarballPath, "fixture package archive", "utf8");

    const configuredUpstream = createServer((request, response) => {
      configuredUpstreamHits += 1;
      configuredUpstreamTarget = request.url;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("configured upstream");
    });
    const escapeServer = createServer((_request, response) => {
      escapeServerHits += 1;
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("escaped upstream");
    });
    await Promise.all([
      new Promise<void>((resolve) => {
        configuredUpstream.listen(0, "127.0.0.1", resolve);
      }),
      new Promise<void>((resolve) => {
        escapeServer.listen(0, "127.0.0.1", resolve);
      }),
    ]);
    const configuredAddress = configuredUpstream.address();
    const escapeAddress = escapeServer.address();
    if (
      !configuredAddress ||
      typeof configuredAddress === "string" ||
      !escapeAddress ||
      typeof escapeAddress === "string"
    ) {
      throw new Error("expected upstream registry addresses");
    }

    const child = spawn(
      process.execPath,
      [
        "scripts/e2e/lib/plugins/npm-registry-server.mjs",
        portFile,
        "@openclaw/demo-plugin-npm",
        "1.0.0",
        tarballPath,
      ],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          OPENCLAW_NPM_REGISTRY_UPSTREAM: `http://127.0.0.1:${configuredAddress.port}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    try {
      const port = await waitForPortFile(portFile);
      const escaped = await requestFixtureRegistry(
        port,
        `http://registry.invalid//127.0.0.1:${escapeAddress.port}/probe`,
      );

      expect(escaped.statusCode).toBe(502);
      expect(escaped.body).toContain("refusing non-origin registry request URL");
      expect(configuredUpstreamHits).toBe(0);
      expect(escapeServerHits).toBe(0);

      const valid = await requestFixtureRegistry(port, "/pkg?x=1");

      expect(valid.statusCode).toBe(200);
      expect(valid.body).toBe("configured upstream");
      expect(configuredUpstreamHits).toBe(1);
      expect(configuredUpstreamTarget).toBe("/pkg?x=1");
      expect(escapeServerHits).toBe(0);
    } finally {
      if (child.exitCode === null) {
        child.kill();
        await new Promise((resolve) => {
          child.once("close", resolve);
        });
      }
      await Promise.all([
        new Promise<void>((resolve) => {
          configuredUpstream.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          escapeServer.close(() => resolve());
        }),
      ]);
    }
  });

  it("rejects invalid plugin fixture log byte limits before npm fixture setup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-npm-fixture-log-invalid-"));
    try {
      const binDir = path.join(root, "bin");
      const fixtureDir = path.join(root, "fixture");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(fixtureDir);
      writeFileSync(
        path.join(binDir, "node"),
        "#!/bin/bash\necho node should not run >&2\nexit 1\n",
      );
      chmodSync(path.join(binDir, "node"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "set +e",
            `start_npm_fixture_registry fixture-pkg 1.0.0 ${shellQuote(path.join(root, "fixture.tgz"))} ${shellQuote(fixtureDir)}`,
            'status="$?"',
            "set -e",
            'exit "$status"',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64kb",
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: 64kb");
      expect(result.stderr).not.toContain("node should not run");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("cleans ClawHub fixture children when readiness times out", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-clawhub-fixture-cleanup-"));
    try {
      const binDir = path.join(root, "bin");
      const cleanupPath = path.join(root, "caller-cleanup");
      const tmpDir = path.join(root, "scratch");
      const pidPath = path.join(root, "server.pid");
      mkdirSync(tmpDir);
      writeFixtureServerShims(binDir, pidPath);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "source scripts/e2e/lib/plugins/clawhub.sh",
            "set +e",
            `( set -e; trap 'printf caller-cleanup > ${shellQuote(cleanupPath)}' EXIT; run_plugins_clawhub_scenario )`,
            'status="$?"',
            "set -e",
            '[ "$status" != "0" ]',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB: "0",
            OPENCLAW_PLUGINS_TMP_DIR: tmpDir,
            OPENCLAW_TEST_FIXTURE_SERVER_PID: pidPath,
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      const pid = Number(readFileSync(pidPath, "utf8"));
      expect(Number.isInteger(pid)).toBe(true);
      waitForDead(pid);
      expect(readFileSync(cleanupPath, "utf8")).toBe("caller-cleanup");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid plugin fixture log byte limits before ClawHub fixture setup", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-clawhub-fixture-log-invalid-"));
    try {
      const binDir = path.join(root, "bin");
      const tmpDir = path.join(root, "scratch");
      mkdirSync(binDir, { recursive: true });
      mkdirSync(tmpDir);
      writeFileSync(
        path.join(binDir, "node"),
        "#!/bin/bash\necho node should not run >&2\nexit 1\n",
      );
      chmodSync(path.join(binDir, "node"), 0o755);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "source scripts/e2e/lib/plugins/clawhub.sh",
            "set +e",
            "run_plugins_clawhub_scenario",
            'status="$?"',
            "set -e",
            'exit "$status"',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64kb",
            OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB: "0",
            OPENCLAW_PLUGINS_TMP_DIR: tmpDir,
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("invalid OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: 64kb");
      expect(result.stderr).not.toContain("node should not run");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("bounds ClawHub fixture server logs when readiness fails", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugin-clawhub-fixture-log-"));
    try {
      const binDir = path.join(root, "bin");
      const tmpDir = path.join(root, "scratch");
      mkdirSync(tmpDir);
      writeCrashingFixtureServerShim(binDir);

      const result = spawnSync(
        "/bin/bash",
        [
          "-c",
          [
            "set -euo pipefail",
            "source scripts/e2e/lib/plugins/fixtures.sh",
            "source scripts/e2e/lib/plugins/clawhub.sh",
            "set +e",
            "run_plugins_clawhub_scenario",
            'status="$?"',
            "set -e",
            'printf "status=%s\\n" "$status"',
            '[ "$status" != "0" ]',
          ].join("\n"),
        ],
        {
          cwd: process.cwd(),
          encoding: "utf8",
          env: {
            ...process.env,
            OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "80",
            OPENCLAW_PLUGINS_E2E_LIVE_CLAWHUB: "0",
            OPENCLAW_PLUGINS_TMP_DIR: tmpDir,
            PATH: `${binDir}${path.delimiter}/usr/bin${path.delimiter}/bin`,
          },
        },
      );

      expect(result.status, result.stderr || result.stdout).toBe(0);
      expect(result.stdout).toContain("truncated: showing last 80");
      expect(result.stdout).toContain("PLUGIN_FIXTURE_TAIL_MARKER");
      expect(result.stdout).not.toContain("DO_NOT_DUMP_PLUGIN_FIXTURE_PREFIX");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("uses the configured scratch root and resolves Windows home-relative install paths", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, "managed-plugin");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2.json"), {
        plugins: [{ id: "demo-plugin-tgz", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins2-inspect.json"), {
        gatewayMethods: ["demo.tgz"],
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          "demo-plugin-tgz": {
            source: "archive",
            installPath: String.raw`~\managed-plugin`,
          },
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "1e3",
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("compares local plugin source paths by canonical path", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const sourceParent = path.join(root, "source");
    const sourcePath = `${sourceParent}//plugin`;
    const normalizedSourcePath = path.join(sourceParent, "plugin");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-dir");
    mkdirSync(sourcePath, { recursive: true });
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins3.json"), {
        plugins: [{ id: "demo-plugin-dir", status: "loaded" }],
      });
      writeJson(path.join(scratchRoot, "plugins3-inspect.json"), {
        gatewayMethods: ["demo.dir"],
      });
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {
          "demo-plugin-dir": {
            source: "path",
            sourcePath: normalizedSourcePath,
            installPath,
          },
        },
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-dir", sourcePath], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).toBe(0);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("still requires archive managed install directories to be removed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const installPath = path.join(home, ".openclaw", "extensions", "demo-plugin-tgz");
    mkdirSync(installPath, { recursive: true });

    try {
      writeJson(path.join(scratchRoot, "plugins2-uninstalled.json"), { plugins: [] });
      writeFileSync(path.join(scratchRoot, "plugins2-install-path.txt"), installPath, "utf8");
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz-removed"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("managed install path still exists after uninstall");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects unreadable config during plugin uninstall proof", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-plugins-assertions-"));
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const removedInstallPath = path.join(home, ".openclaw", "extensions", "demo-plugin-tgz");

    try {
      writeJson(path.join(scratchRoot, "plugins2-uninstalled.json"), { plugins: [] });
      writeFileSync(
        path.join(scratchRoot, "plugins2-install-path.txt"),
        removedInstallPath,
        "utf8",
      );
      writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
        installRecords: {},
      });
      writeFileSync(path.join(home, ".openclaw", "openclaw.json"), "{ malformed\n", "utf8");

      const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "plugin-tgz-removed"], {
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
        },
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("failed to read OpenClaw config");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("rejects ClawHub install paths that resolve outside the managed extensions root", () => {
    const root = autoCleanupTempDirs.make("openclaw-plugins-clawhub-path-");
    const home = path.join(root, "home");
    const scratchRoot = path.join(root, "scratch");
    const extensionsRoot = path.join(home, ".openclaw", "extensions");
    const escapedInstallPath = `${extensionsRoot}${path.sep}..${path.sep}escaped-clawhub`;
    mkdirSync(extensionsRoot, { recursive: true });
    mkdirSync(escapedInstallPath, { recursive: true });

    writeJson(path.join(scratchRoot, "plugins-clawhub-installed.json"), {
      plugins: [{ id: "openclaw-kitchen-sink-fixture", status: "loaded" }],
    });
    writeJson(path.join(scratchRoot, "plugins-clawhub-inspect.json"), {
      plugin: { id: "openclaw-kitchen-sink-fixture" },
    });
    writeJson(path.join(home, ".openclaw", "plugins", "installs.json"), {
      installRecords: {
        "openclaw-kitchen-sink-fixture": {
          artifactFormat: "zip",
          artifactKind: "legacy-zip",
          clawhubFamily: "code-plugin",
          clawhubPackage: "@openclaw/kitchen-sink",
          installPath: escapedInstallPath,
          source: "clawhub",
          spec: "clawhub:@openclaw/kitchen-sink",
        },
      },
    });

    const result = spawnSync(process.execPath, [ASSERTIONS_SCRIPT, "clawhub-installed"], {
      encoding: "utf8",
      env: {
        ...process.env,
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        HOME: home,
        OPENCLAW_PLUGINS_TMP_DIR: scratchRoot,
      },
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ClawHub install path resolved outside");
  });

  it("times out stalled ClawHub package metadata requests", async () => {
    const server = createServer((_request, _response) => {});
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "25",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight for @openclaw/kitchen-sink timed out after 25ms",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("times out stalled ClawHub package metadata bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.flushHeaders();
      response.write("{");
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "75",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight response for @openclaw/kitchen-sink timed out after 75ms",
      );
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("bounds ClawHub package metadata response bodies", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "text/plain" });
      response.end("x".repeat(128));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });

    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("expected TCP server address");
      }
      const result = await runAssertionAsync(["clawhub-preflight"], {
        CLAWHUB_PLUGIN_ID: "openclaw-kitchen-sink-fixture",
        CLAWHUB_PLUGIN_SPEC: "clawhub:@openclaw/kitchen-sink",
        OPENCLAW_CLAWHUB_URL: `http://127.0.0.1:${address.port}`,
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_BODY_MAX_BYTES: "16",
        OPENCLAW_PLUGINS_E2E_CLAWHUB_PREFLIGHT_TIMEOUT_MS: "1000",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "ClawHub package preflight response for @openclaw/kitchen-sink response body exceeded 16 bytes",
      );
      expect(result.stderr).not.toContain("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
