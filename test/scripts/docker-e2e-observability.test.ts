// Docker E2E Observability tests cover docker e2e observability script behavior.
import { spawnSync } from "node:child_process";
import { chmodSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const installDiagnosticsScript = path.resolve("scripts/lib/openclaw-e2e-install-diagnostics.mjs");
const tsxPreload = path.resolve("scripts/tsx.mjs");
const typedOnboardingScript = path.resolve("scripts/e2e/release-typed-onboarding-docker.sh");
const installDiagnosticsPrefix = "[release typed onboarding install] ";

function publishInstallDiagnostics(diagnosticsPath: string, extraArgs: string[] = []) {
  return spawnSync(
    process.execPath,
    [...extraArgs, "--import", tsxPreload, installDiagnosticsScript, "publish", diagnosticsPath],
    { encoding: "utf8" },
  );
}

function successTail(scriptPath: string): string {
  const script = readFileSync(scriptPath, "utf8");
  const index = script.lastIndexOf('if [ "$status" -ne 0 ]; then');
  if (index === -1) {
    throw new Error(`missing status tail in ${scriptPath}`);
  }
  return script.slice(index);
}

function runSuccessTail(scriptPath: string) {
  const tempDir = tempDirs.make("openclaw-docker-e2e-observability-");
  const clientLog = path.join(tempDir, "client.log");
  writeFileSync(clientLog, "client proof log\n", "utf8");
  const harness = [
    "set -euo pipefail",
    `CLIENT_LOG=${JSON.stringify(clientLog)}`,
    "status=0",
    "docker_e2e_print_log() {",
    '  printf \'LOG:%s\\n\' "$(cat "$1")"',
    "}",
    successTail(scriptPath),
  ].join("\n");

  return spawnSync("bash", ["-c", harness], { encoding: "utf8" });
}

describe("Docker E2E observability", () => {
  it("publishes one redacted, control-safe install diagnostic stream", () => {
    const tempDir = tempDirs.make("openclaw-install-diagnostics-publish-");
    const diagnosticsPath = path.join(tempDir, "install.log");
    writeFileSync(
      diagnosticsPath,
      "\u001B[31mOPENAI_API_KEY=sk-openclaw-install-secret-1234567890\u001B[0m\n::error::fixture failure\nplain\u0000text\n",
      { mode: 0o622 },
    );
    chmodSync(diagnosticsPath, 0o622);

    const result = publishInstallDiagnostics(diagnosticsPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).not.toContain("sk-openclaw-install-secret-1234567890");
    expect(result.stdout).not.toMatch(/^::/mu);
    expect(result.stdout).not.toContain("\u001B");
    expect(result.stdout).not.toContain("\u0000");
    expect(result.stdout.match(/fixture failure/g)).toHaveLength(1);
    for (const line of result.stdout.trimEnd().split("\n")) {
      expect(line.startsWith(installDiagnosticsPrefix)).toBe(true);
    }
  });

  it("keeps captured UTF-8 tails publishable within the byte limit", () => {
    const tempDir = tempDirs.make("openclaw-install-diagnostics-utf8-");
    const diagnosticsPath = path.join(tempDir, "install.log");
    writeFileSync(diagnosticsPath, "", { mode: 0o622 });
    chmodSync(diagnosticsPath, 0o622);
    const env = {
      ...process.env,
      OPENCLAW_E2E_INSTALL_DIAGNOSTICS_UID: String(process.getuid?.() ?? 0),
      OPENCLAW_E2E_LOG_TAIL_BYTES: "4",
    };

    const capture = spawnSync(
      process.execPath,
      [installDiagnosticsScript, "capture", diagnosticsPath],
      { encoding: "utf8", env, input: "éabc" },
    );
    const published = spawnSync(
      process.execPath,
      ["--import", tsxPreload, installDiagnosticsScript, "publish", diagnosticsPath],
      { encoding: "utf8", env },
    );

    expect(capture.status, capture.stderr).toBe(0);
    expect(readFileSync(diagnosticsPath)).toEqual(Buffer.from("abc"));
    expect(published.status, published.stderr).toBe(0);
    expect(published.stdout).toBe(`${installDiagnosticsPrefix}abc\n`);
  });

  it("uses only the fixed omission marker for unsafe input or redaction failure", () => {
    const tempDir = tempDirs.make("openclaw-install-diagnostics-omission-");
    const targetPath = path.join(tempDir, "target.log");
    const diagnosticsPath = path.join(tempDir, "install.log");
    const loaderPath = path.join(tempDir, "throwing-redactor-loader.mjs");
    writeFileSync(targetPath, "private fixture bytes\n", { mode: 0o622 });
    chmodSync(targetPath, 0o622);
    symlinkSync(targetPath, diagnosticsPath);
    writeFileSync(
      loaderPath,
      `
export async function load(url, context, nextLoad) {
  if (url.endsWith("/src/logging/redact.ts")) {
    return {
      format: "module",
      shortCircuit: true,
      source: "export function redactSensitiveText() { throw new Error(); }",
    };
  }
  return nextLoad(url, context);
}
`,
      "utf8",
    );

    const unsafeResult = publishInstallDiagnostics(diagnosticsPath);
    const redactionResult = publishInstallDiagnostics(targetPath, [
      "--experimental-loader",
      loaderPath,
    ]);
    expect(unsafeResult.status, unsafeResult.stderr).toBe(0);
    expect(redactionResult.status, redactionResult.stderr).toBe(0);
    expect(unsafeResult.stdout).toBe(`${installDiagnosticsPrefix}[diagnostics omitted]\n`);
    expect(redactionResult.stdout).toBe(`${installDiagnosticsPrefix}[diagnostics omitted]\n`);
    expect(`${unsafeResult.stdout}${redactionResult.stdout}`).not.toContain(
      "private fixture bytes",
    );
  });

  it.each([
    [1, ""],
    [143, "TERM"],
    [130, "INT"],
    [129, "HUP"],
  ] as const)("preserves typed onboarding cleanup status %i (%s)", (status, signal) => {
    const tempDir = tempDirs.make("openclaw-typed-onboarding-cleanup-");
    const script = readFileSync(typedOnboardingScript, "utf8");
    const start = script.indexOf("exec 5>&1");
    const end = script.indexOf("trap 'exit 129' HUP", start) + "trap 'exit 129' HUP".length;
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const cleanupSetup = script.slice(start, end);
    const harness = [
      "set -Eeuo pipefail",
      `ROOT_DIR=${JSON.stringify(process.cwd())}`,
      "PACKAGE_TGZ=",
      "AUTO_PREPUBLISH_PLUGIN_REGISTRY_ROOT=",
      "docker_e2e_cleanup_package_tgz() { :; }",
      cleanupSetup,
      `install_diagnostics_dir=${JSON.stringify(path.join(tempDir, "owned"))}`,
      'mkdir -m 700 "$install_diagnostics_dir"',
      'install_diagnostics_path="$install_diagnostics_dir/install.log"',
      'printf "OPENAI_API_KEY=sk-openclaw-cleanup-secret-1234567890\\n" >"$install_diagnostics_path"',
      'chmod 622 "$install_diagnostics_path"',
      signal ? `kill -${signal} "$$"` : `exit ${status}`,
    ].join("\n");

    const result = spawnSync("/bin/bash", ["-c", harness], {
      encoding: "utf8",
      timeout: 5_000,
    });

    expect(result.status, result.stderr).toBe(status);
    expect(readdirSync(tempDir)).toEqual([]);
    expect(result.stdout).not.toContain("sk-openclaw-cleanup-secret-1234567890");
    expect(result.stdout.match(/\[diagnostics omitted\]|OPENAI_API_KEY=/g)).toHaveLength(1);
  });

  it("mounts current diagnostics support outside frozen scenario cleanup", () => {
    const wrapper = readFileSync(typedOnboardingScript, "utf8");
    const scenario = readFileSync("scripts/e2e/lib/release-typed-onboarding/scenario.sh", "utf8");

    expect(wrapper).toContain(
      '-v "$install_diagnostics_path:/tmp/openclaw-install-diagnostics.log:rw"',
    );
    expect(wrapper).toContain(
      '-v "$ROOT_DIR/scripts/lib/openclaw-e2e-instance.sh:/app/scripts/lib/openclaw-e2e-instance.sh:ro"',
    );
    expect(wrapper).not.toContain('-v "$install_diagnostics_dir:/tmp/openclaw-install-diagnostics');
    expect(scenario).toContain('rm -rf "$scenario_tmp"');
    expect(scenario).not.toContain("openclaw-install-diagnostics.log");
  });

  it("resolves the wrapper sidecar owner inside the container namespace", () => {
    const tempDir = tempDirs.make("openclaw-typed-onboarding-owner-");
    const script = readFileSync(typedOnboardingScript, "utf8");
    const startMarker = '-i "$IMAGE_NAME" bash -c \'\n';
    const endMarker = "\n' bash bash scripts/e2e/lib/release-typed-onboarding/scenario.sh";
    const start = script.indexOf(startMarker);
    const end = script.indexOf(endMarker, start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const containerSetup = script.slice(start + startMarker.length, end);
    const diagnosticsPath = path.join(tempDir, "install.log");
    writeFileSync(diagnosticsPath, "", { mode: 0o622 });
    chmodSync(diagnosticsPath, 0o622);
    const statPath = path.join(tempDir, "stat");
    writeFileSync(
      statPath,
      [
        "#!/bin/sh",
        'if [ "${1:-}" = "-f" ]; then',
        '  printf "poisoned stat output\\n"',
        "  exit 1",
        "fi",
        'printf "%s\\n" "$OPENCLAW_TEST_UID"',
      ].join("\n"),
      "utf8",
    );
    chmodSync(statPath, 0o755);
    const uid = process.getuid?.() ?? 0;

    const result = spawnSync(
      "/bin/bash",
      [
        "-c",
        containerSetup,
        "bash",
        "/bin/bash",
        "-c",
        'printf "%s" "$OPENCLAW_E2E_INSTALL_DIAGNOSTICS_UID"',
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_E2E_INSTALL_DIAGNOSTICS: diagnosticsPath,
          OPENCLAW_E2E_INSTALL_DIAGNOSTICS_UID: String(uid + 1),
          PATH: `${tempDir}:${process.env.PATH}`,
        },
      },
    );

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(String(uid));
  });

  it("prints the bounded heartbeat log before signal cleanup", () => {
    const tempDir = tempDirs.make("openclaw-heartbeat-signal-log-");
    const result = spawnSync(
      "bash",
      [
        "-c",
        `
set -euo pipefail
source scripts/lib/docker-e2e-logs.sh
run_logged_print_heartbeat signal-proof 30 bash -c 'printf "old log head%0256drecent failure tail\\n" 0; kill -TERM "$PPID"'
`,
      ],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: { ...process.env, TMPDIR: tempDir, OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64" },
      },
    );
    expect(result.status, result.stderr).toBe(143);
    expect(result.stdout).not.toContain("old log head");
    expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
    expect(result.stdout).toContain("showing last 64");
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it.each([
    [0, "", true],
    [1, "", true],
    [143, "TERM", false],
    [143, "TERM", true],
    [130, "INT", false],
    [129, "HUP", false],
  ] as const)(
    "preserves redirected Codex run diagnostics on exit %i (%s, long=%s)",
    (status, signal, long) => {
      const tempDir = tempDirs.make("openclaw-codex-run-cleanup-");
      const script = readFileSync("scripts/e2e/codex-npm-plugin-live-docker.sh", "utf8");
      const cleanupSetup = script.slice(
        script.indexOf('run_log=""'),
        script.indexOf("trap cleanup EXIT") + "trap cleanup EXIT".length,
      );
      const result = spawnSync(
        "bash",
        [
          "-c",
          `
set -Eeuo pipefail
# Bound the pre-fix self-copy if EXIT cleanup still writes into its input log.
ulimit -f 8
source scripts/lib/docker-e2e-package.sh
proof_status="$1"
proof_signal="$2"
proof_long="$3"
docker_e2e_docker_cmd() {
  printf '%s\\n' "$*" >>"$TMPDIR/docker-cleanup"
}
docker_e2e_docker_run_cmd() {
  while [ "$#" -gt 0 ]; do
    if [ "$1" = --cidfile ]; then
      printf 'proof-container\\n' >"$2"
      break
    fi
    shift
  done
  cat >"$TMPDIR/container-stdin"
  if [ "$proof_long" = true ]; then
    printf 'old log head%0256d' 0
  fi
  printf 'recent failure tail\\n'
  if [ -n "$proof_signal" ]; then
    kill -"$proof_signal" "$$"
  else
    return "$proof_status"
  fi
}
${cleanupSetup}
run_log="$TMPDIR/run.log"
# Use the actual harness: its signal trap exits inside this function redirection.
if ! docker_e2e_run_with_harness image-name bash -s >"$run_log" 2>&1 <<'SH'; then
container stdin proof
SH
  exit 1
fi
`,
          "bash",
          String(status),
          signal,
          String(long),
        ],
        {
          encoding: "utf8",
          timeout: 5_000,
          killSignal: "SIGKILL",
          env: { ...process.env, TMPDIR: tempDir, OPENCLAW_DOCKER_E2E_LOG_PRINT_BYTES: "64" },
        },
      );
      expect(result.status, JSON.stringify({ stderr: result.stderr, signal: result.signal })).toBe(
        status,
      );
      expect(readFileSync(path.join(tempDir, "container-stdin"), "utf8")).toBe(
        "container stdin proof\n",
      );
      const dockerCommands = readFileSync(path.join(tempDir, "docker-cleanup"), "utf8");
      expect(dockerCommands.trimEnd().split("\n").at(-1)).toBe("rm -f proof-container");
      expect(readdirSync(tempDir).toSorted()).toEqual(["container-stdin", "docker-cleanup"]);
      expect(result.stdout).not.toContain("old log head");
      if (status === 0) {
        expect(result.stdout).toBe("");
      } else {
        expect(result.stdout.match(/recent failure tail/g)).toHaveLength(1);
        expect(result.stdout.includes("showing last 64")).toBe(long);
      }
    },
  );

  it("feeds the cron CLI Docker proof body through container stdin", () => {
    const script = readFileSync("scripts/e2e/cron-cli-docker.sh", "utf8");

    expect(script).toMatch(
      /docker_e2e_run_with_harness[\s\S]*\n {2}-i \\\n {2}"\$IMAGE_NAME" \\\n {2}bash -s >"\$CLIENT_LOG" 2>&1 <<'INNER'/u,
    );
  });

  it.each([
    "scripts/e2e/mcp-channels-docker.sh",
    "scripts/e2e/cron-cli-docker.sh",
    "scripts/e2e/cron-mcp-cleanup-docker.sh",
  ])("prints successful MCP client proof logs from %s", (scriptPath) => {
    const result = runSuccessTail(scriptPath);

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim().split("\n")).toEqual(["LOG:client proof log", "OK"]);
  });
});
