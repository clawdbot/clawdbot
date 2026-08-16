// Crabbox Wrapper tests cover crabbox wrapper script behavior.
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  isProviderAdvertised,
  parseProvidersFromHelp,
} from "../../scripts/crabbox-wrapper-providers.mts";
import { makeTempDir } from "../helpers/temp-dir.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const invocationLogTempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const bundledWrapperPath = path.join(repoRoot, ".tmp", `crabbox-wrapper-test-${process.pid}.mjs`);
const fakeCrabboxBinDirs = new Map<string, string>();
const fakeGitBinDirs = new Map<string, string>();
const timingPreloads = new Map<string, string>();
const GIT_COMMON_DIR_KEY = "rev-parse\u0000--git-common-dir";
const GIT_CONFIG_SPARSE_KEY = "config\u0000--bool\u0000core.sparseCheckout";
const GIT_SPARSE_LIST_KEY = "sparse-checkout\u0000list";
const GIT_STATUS_PORCELAIN_KEY = "status\u0000--porcelain=v1";
const GIT_MERGE_BASE_MAIN_HEAD_KEY = "merge-base\u0000origin/main\u0000HEAD";
const GIT_MERGE_BASE_RELEASE_HEAD_KEY = "merge-base\u0000origin/release/2026.7.2\u0000HEAD";
const GIT_CHECK_RELEASE_REF_KEY = "check-ref-format\u0000refs/remotes/origin/release/2026.7.2";
const defaultProviderHelp =
  "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
const brokerProviderHelp = "provider: aws, azure, blacksmith-testbox, or daytona\n";
const azureProviderHelp =
  "provider: hetzner, aws, azure, local-container, blacksmith-testbox, or cloudflare\n";
const fakeRunValueOptionHelp = [
  "artifact-glob value",
  "blacksmith-ref string",
  "capture-stderr string",
  "capture-stdout string",
  "download value",
  "id string",
  "idle-timeout duration",
  "label string",
  "market string",
  "provider string",
  "script string",
  "target string",
  "ttl duration",
  "windows-mode string",
]
  .map((option) => `  -${option}\n`)
  .join("");
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
  const stampClaimScript = [
    "const claimPaths = [process.env.OPENCLAW_FAKE_CRABBOX_CLAIM_PATH, process.env.OPENCLAW_FAKE_CRABBOX_EXTRA_CLAIM_PATH].filter(Boolean);",
    "for (const claimPath of claimPaths) { const claim = fs.existsSync(claimPath) ? JSON.parse(fs.readFileSync(claimPath, 'utf8')) : { leaseID: process.env.OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID }; claim.repoRoot = process.env.OPENCLAW_FAKE_CRABBOX_CLAIM_REPO_ROOT || process.cwd(); fs.mkdirSync(path.dirname(claimPath), { recursive: true }); fs.writeFileSync(claimPath, JSON.stringify(claim) + '\\n', 'utf8'); }",
    "if (process.env.OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID) process.stderr.write(JSON.stringify({ provider: 'blacksmith-testbox', leaseId: process.env.OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID, exitCode: 0 }) + '\\n');",
  ].join("");
  // Keep the descendant in the fake's process group, and publish readiness only
  // after its signal handlers exist so the wrapper's group cleanup is deterministic.
  const signalIgnoringDescendantScript =
    "import fs from 'node:fs'; process.on('SIGHUP', () => {}); process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); const pidPath = process.env.OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH; const tmpPath = pidPath + '.tmp.' + process.pid; fs.writeFileSync(tmpPath, String(process.pid)); fs.renameSync(tmpPath, pidPath); setInterval(() => {}, 1000);";
  // The two cwd-loss modes distinguish active-child monitoring from the post-exit
  // guard; both must chdir away before deleting the temporary checkout.
  const script = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const { spawn } = require("node:child_process");
const args = process.argv.slice(2); const helpText = ${JSON.stringify(`${helpText}${fakeRunValueOptionHelp}`)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const optionValue = (name) => {
  const index = args.findIndex((arg) => arg === "--" + name || arg === "-" + name); const assigned = args.find((arg) => arg.startsWith("--" + name + "=") || arg.startsWith("-" + name + "="));
  return index >= 0 ? args[index + 1] || "" : assigned?.slice(assigned.indexOf("=") + 1) || "";
};
async function main() {
  if (process.env.OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG) fs.appendFileSync(process.env.OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG, JSON.stringify(args) + "\n");
  if (args[0] === "--version") { console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || "crabbox 0.22.1"); return; }
  if (args[0] === "run" && args[1] === "--help") { process.stdout.write(helpText); return; }
  if (args[0] === "doctor") {
    const provider = optionValue("provider"); const target = optionValue("target"); const windowsMode = optionValue("windows-mode");
    await wait(Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_DOCTOR_DELAY_MS || "0", 10));
    if (process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_TARGET && target !== process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_TARGET) { process.stderr.write("doctor target mismatch: got=" + target + "\n"); process.exit(64); }
    if (process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_WINDOWS_MODE && windowsMode !== process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_WINDOWS_MODE) { process.stderr.write("doctor windows mode mismatch: got=" + windowsMode + "\n"); process.exit(64); }
    const malformed = new Set((process.env.OPENCLAW_FAKE_CRABBOX_MALFORMED_DOCTOR_PROVIDERS || "").split(",").filter(Boolean));
    if (malformed.has(provider)) { process.stdout.write("{not-json\n"); process.exit(1); }
    const invalid = new Set((process.env.OPENCLAW_FAKE_CRABBOX_INVALID_DOCTOR_PROVIDERS || "").split(",").filter(Boolean));
    if (invalid.has(provider)) { process.stdout.write(JSON.stringify({ ok: true, provider, checks: [{ status: "ok" }] }) + "\n"); return; }
    const mismatched = new Set((process.env.OPENCLAW_FAKE_CRABBOX_MISMATCHED_DOCTOR_PROVIDERS || "").split(",").filter(Boolean));
    if (mismatched.has(provider)) { process.stdout.write(JSON.stringify({ ok: true, provider: "wrong-provider", checks: [{ status: "ok", check: "broker" }] }) + "\n"); return; }
    const inconsistent = new Set((process.env.OPENCLAW_FAKE_CRABBOX_INCONSISTENT_DOCTOR_PROVIDERS || "").split(",").filter(Boolean));
    if (inconsistent.has(provider)) { process.stdout.write(JSON.stringify({ ok: true, provider, checks: [{ status: "ok", check: "broker" }] }) + "\n"); process.exit(1); }
    const managed = new Set(["aws", "azure", "daytona"]).has(provider);
    const missingBroker = new Set((process.env.OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS || "").split(",").filter(Boolean));
    const providerUnauthorized = new Set((process.env.OPENCLAW_FAKE_CRABBOX_PROVIDER_UNAUTHORIZED_PROVIDERS || "").split(",").filter(Boolean));
    if (providerUnauthorized.has(provider)) { process.stdout.write(JSON.stringify({ ok: false, provider, checks: [{ status: "ok", check: "broker" }, { status: "failed", check: "provider", message: "class=broker_auth hint=crabbox_login unauthorized", details: { class: "broker_auth", hint: "crabbox_login" } }] }) + "\n"); process.exit(1); }
    const legacyUnauthorized = new Set((process.env.OPENCLAW_FAKE_CRABBOX_LEGACY_UNAUTHORIZED_PROVIDERS || "").split(",").filter(Boolean));
    if (legacyUnauthorized.has(provider)) { process.stdout.write(JSON.stringify({ ok: false, provider, checks: [{ status: "failed", check: "broker", message: "coordinator GET /v1/whoami: http 401: unauthorized" }] }) + "\n"); process.exit(1); }
    const unauthorized = new Set((process.env.OPENCLAW_FAKE_CRABBOX_UNAUTHORIZED_PROVIDERS || "").split(",").filter(Boolean));
    if (unauthorized.has(provider)) { process.stdout.write(JSON.stringify({ ok: false, provider, checks: [{ status: "failed", check: "broker", message: "class=broker_auth hint=crabbox_login unauthorized", details: { class: "broker_auth", hint: "crabbox_login" } }] }) + "\n"); process.exit(1); }
    const unready = new Set((process.env.OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS || "").split(",").filter(Boolean));
    const ready = !unready.has(provider) && (!managed || !missingBroker.has(provider)); const checks = [];
    if (managed && !missingBroker.has(provider)) checks.push({ status: "ok", check: "broker", details: { auth: "token" } });
    checks.push({ status: ready ? "ok" : "failed", check: "provider", details: { provider } });
    process.stdout.write(JSON.stringify({ ok: ready, provider, checks }) + "\n");
    process.exit(ready ? 0 : 1);
  }
  if (args[0] === "run" || args[0] === "warmup") { ${stampClaimScript} }
  const runStatus = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_RUN_STATUS || "0", 10); if (args[0] === "run" && runStatus !== 0) { process.stderr.write("fake run failure\n"); process.exit(runStatus); }
  if (args[0] === "config" && args[1] === "show" && args.includes("--json")) {
    const status = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS || "0", 10);
    if (status !== 0) { process.stderr.write("config unavailable\n"); process.exit(status); }
    process.stdout.write(Object.hasOwn(process.env, "OPENCLAW_FAKE_CRABBOX_CONFIG_JSON") ? process.env.OPENCLAW_FAKE_CRABBOX_CONFIG_JSON : '{"coordinator":"configured-broker","brokerMode":"managed","brokerAuth":"configured"}');
    return;
  }
  if (args[0] === "whoami") {
    await wait(Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_WHOAMI_DELAY_MS || "0", 10));
    const status = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS || "0", 10);
    if (status !== 0) { process.stderr.write('coordinator GET /v1/whoami: http 401: {"error":"unauthorized"}\n'); process.exit(status); }
    process.stdout.write("fake-crabbox-user\n"); return;
  }
  if (args.includes("--artifact-glob") || args.includes("-artifact-glob")) { fs.mkdirSync(".crabbox/runs/run_fake", { recursive: true }); fs.writeFileSync(".crabbox/runs/run_fake/fake-artifacts.tgz", "fake artifact\n"); }
  const scriptIndex = args.findIndex((arg) => arg === "--script" || arg === "-script"); const scriptPath = scriptIndex >= 0 ? args[scriptIndex + 1] : "";
  const scriptContent = scriptPath ? fs.readFileSync(scriptPath, "utf8") : "";
  if (process.env.OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT === "1") {
    await wait(100); const deletedCwd = process.cwd(); process.chdir(path.parse(deletedCwd).root || "/");
    fs.rmSync(deletedCwd, { recursive: true, force: true }); process.exit(0);
  }
  if (process.env.OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE === "1") {
    const deletedCwd = process.cwd(); process.chdir(path.parse(deletedCwd).root || "/");
    fs.rmSync(deletedCwd, { recursive: true, force: true }); let attempts = 1000;
    while (attempts-- > 0 && !fs.existsSync(deletedCwd)) await wait(10);
    if (!fs.existsSync(deletedCwd)) { process.stderr.write("cwd was not restored: " + deletedCwd + "\n"); process.exit(66); }
    process.chdir(deletedCwd);
  }
  if (process.env.OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH) {
    spawn(process.execPath, ["--input-type=module", "--eval", ${JSON.stringify(signalIgnoringDescendantScript)}], { stdio: "ignore" });
    setInterval(() => {}, 1000); return;
  }
  const bundlePath = ".openclaw-crabbox-changed-gate.bundle";
  if (Object.hasOwn(process.env, "OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE")) {
    const bundle = fs.existsSync(bundlePath) ? fs.readFileSync(bundlePath, "utf8") : null;
    if (bundle !== process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE) { process.stderr.write("changed-gate bundle mismatch\n"); process.exit(67); }
  }
  if (process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE_BYTES) {
    const bytes = fs.existsSync(bundlePath) ? fs.statSync(bundlePath).size : -1;
    if (bytes !== Number(process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE_BYTES)) { process.stderr.write("changed-gate bundle size mismatch\n"); process.exit(67); }
  }
  if (process.env.OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_FORCE_ADD === "1" && !fs.existsSync(process.env.OPENCLAW_FAKE_GIT_FORCE_ADD_MARKER || "")) { process.stderr.write("changed-gate bundle was not force-added\n"); process.exit(67); }
  process.stdout.write(JSON.stringify({ args, cwd: process.cwd(), scriptContent }) + "\n");
}
main().catch((error) => { process.stderr.write(String(error?.stack || error) + "\n"); process.exit(1); });`;
  if (process.platform === "win32") {
    writeNodeCommand(crabboxPath, script);
  } else {
    const nodePath = `${crabboxPath}-node`;
    const runHelpText = `${helpText}${fakeRunValueOptionHelp}`;
    writeNodeCommand(nodePath, script);
    writeShellCommand(
      crabboxPath,
      [
        'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then',
        `  printf '%s\\n' "\${OPENCLAW_FAKE_CRABBOX_VERSION:-crabbox 0.22.1}"`,
        "  exit 0",
        "fi",
        'if [ "$#" -eq 2 ] && [ "$1" = "run" ] && [ "$2" = "--help" ]; then',
        `  printf '%s' ${shellQuote(runHelpText)}`,
        "  exit 0",
        "fi",
        "fast_run=1",
        'for arg in "$@"; do',
        '  case "$arg" in --artifact-glob|-artifact-glob|--script|-script) fast_run=0 ;; esac',
        "done",
        'if { [ "$1" = "run" ] || [ "$1" = "warmup" ]; } && [ "$fast_run" -eq 1 ] &&',
        '  [ -z "${OPENCLAW_FAKE_CRABBOX_CLAIM_PATH:-}${OPENCLAW_FAKE_CRABBOX_EXTRA_CLAIM_PATH:-}${OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID:-}${OPENCLAW_FAKE_CRABBOX_RUN_STATUS:-}${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT:-}${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE:-}${OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH:-}${OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE+x}${OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE_BYTES:-}${OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_FORCE_ADD:-}" ]; then',
        `  printf '${fakeCrabboxProtocol}\\000%s\\000' "$#"`,
        "  printf '%s\\000' \"$@\"",
        "  printf '%s\\000\\000' \"$PWD\"",
        "  exit 0",
        "fi",
        `exec node ${shellQuote(nodePath)} "$@"`,
      ].join("\n"),
    );
  }
  return crabboxPath;
}

function makeSlowVersionCrabbox(helpText: string): string {
  return makeSlowCrabbox(helpText, "version", 1_000);
}

// Fake Crabbox whose `run --help` is slow on every call and, like real Crabbox
// 0.36, renders the provider help to stderr. Used to prove the wrapper retries a
// cold/slow metadata probe instead of hard-failing.
function makeSlowHelpCrabbox(helpText: string, delayMs: number): string {
  return makeSlowCrabbox(helpText, "help", delayMs);
}

function makeSlowCrabbox(helpText: string, mode: "help" | "version", delayMs: number): string {
  const binDir = mkdtempSync(path.join(tmpdir(), `openclaw-slow-${mode}-crabbox-`));
  tempDirs.push(binDir);
  const crabboxPath = path.join(binDir, "crabbox");
  const runHelpText = `${helpText}${fakeRunValueOptionHelp}`;
  const script = String.raw`
const args = process.argv.slice(2); const mode = ${JSON.stringify(mode)};
if (args[0] === "--version") {
  if (mode === "version") setTimeout(() => process.exit(0), ${delayMs});
  else console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || "crabbox 0.22.1");
} else if (args[0] === "run" && args[1] === "--help") {
  if (mode === "help") setTimeout(() => { process.stderr.write(${JSON.stringify(runHelpText)}); process.exit(0); }, ${delayMs});
  else process.stdout.write(${JSON.stringify(runHelpText)});
}`;
  writeNodeCommand(crabboxPath, script);
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

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function writeShellCommand(commandPath: string, script: string): void {
  writeFileSync(commandPath, `#!/bin/sh\n${script.trimStart()}\n`, "utf8");
  chmodSync(commandPath, 0o755);
}

function writeNodeCommand(commandPath: string, script: string): void {
  writeFileSync(commandPath, `#!/usr/bin/env node\n${script.trimStart()}\n`, "utf8");
  if (process.platform === "win32") {
    const shim = windowsNodeCmdShim(path.basename(commandPath));
    writeFileSync(`${commandPath}.cmd`, shim, "utf8");
  }
  chmodSync(commandPath, 0o755);
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
  const script = String.raw`
const fs = require("node:fs"); const path = require("node:path"); const args = process.argv.slice(2);
const touch = (name) => { if (process.env[name]) fs.writeFileSync(process.env[name], ""); };
if (args[0] === "worktree" && args[1] === "add") {
  fs.mkdirSync(args[3], { recursive: true });
  if (process.env.OPENCLAW_FAKE_GIT_CHANGED_GATE_BUNDLE_SYMLINK_TARGET) fs.symlinkSync(process.env.OPENCLAW_FAKE_GIT_CHANGED_GATE_BUNDLE_SYMLINK_TARGET, path.join(args[3], ".openclaw-crabbox-changed-gate.bundle")); process.exit(0);
}
if (args[0] === "-C" && args[2] === "sparse-checkout" && args[3] === "disable") process.exit(0);
if (args[0] === "-C" && args[2] === "rev-parse") {
  const value = args[3] === "HEAD" ? process.env.OPENCLAW_FAKE_GIT_HEAD_SHA || "def456" : args[3] === "HEAD^{tree}" ? process.env.OPENCLAW_FAKE_GIT_HEAD_TREE_SHA || "tree456" : process.env.OPENCLAW_FAKE_GIT_BASE_SHA || "abc123";
  process.stdout.write(value + "\n"); process.exit(0);
}
if (args[0] === "-C" && args[2] === "-c" && args[6] === "commit-tree") {
  if (process.env.OPENCLAW_FAKE_GIT_ROOT_COMMIT_MARKER && args.includes("-p")) process.exit(68);
  touch("OPENCLAW_FAKE_GIT_ROOT_COMMIT_MARKER"); touch("OPENCLAW_FAKE_GIT_SYNTHETIC_COMMIT_MARKER");
  process.stdout.write((process.env.OPENCLAW_FAKE_GIT_SYNTHETIC_COMMIT_SHA || "synthetic789") + "\n"); process.exit(0);
}
if (args[0] === "-C" && args[2] === "update-ref" && args[3] === "HEAD") { touch("OPENCLAW_FAKE_GIT_SYNTHETIC_HEAD_MARKER"); process.exit(0); }
if (args[0] === "-C" && args[2] === "bundle" && args[3] === "create") {
  if (process.env.OPENCLAW_FAKE_GIT_SELF_CONTAINED_BUNDLE_MARKER && (args.length !== 6 || args[5] !== "HEAD")) process.exit(68);
  touch("OPENCLAW_FAKE_GIT_SELF_CONTAINED_BUNDLE_MARKER"); const bytes = Number(process.env.OPENCLAW_FAKE_GIT_BUNDLE_BYTES || 0);
  fs.writeFileSync(args[4], bytes ? "x".repeat(bytes) : process.env.OPENCLAW_FAKE_GIT_BUNDLE || "fake-bundle"); process.exit(0);
}
if (args[0] === "-C" && args[2] === "add" && args[3] === "-f") { touch("OPENCLAW_FAKE_GIT_FORCE_ADD_MARKER"); process.exit(0); }
if (args[0] === "-C" && args[2] === "reset" && args[3] === "--mixed") process.exit(0);
if (args[0] === "worktree" && args[1] === "remove") { fs.rmSync(args[3], { recursive: true, force: true }); process.exit(0); }
const response = new Map(Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_GIT_RESPONSES || "{}"))).get(args.join("\u0000"));
if (!response) process.exit(1);
if (response.stdout) process.stdout.write(response.stdout); if (response.stderr) process.stderr.write(response.stderr);
process.exit(response.status ?? 0);`;
  if (process.platform === "win32") {
    writeNodeCommand(gitPath, script);
  } else {
    const nodePath = `${gitPath}-node`;
    const responseCases = Object.entries(responses).map(([command, response]) => {
      const args = command.split("\u0000");
      const condition = [
        `[ "$#" -eq ${args.length} ]`,
        ...args.map((arg, index) => `[ "$${index + 1}" = ${shellQuote(arg)} ]`),
      ].join(" && ");
      return [
        `if ${condition}; then`,
        ...(response.stdout ? [`  printf '%s' ${shellQuote(response.stdout)}`] : []),
        ...(response.stderr ? [`  printf '%s' ${shellQuote(response.stderr)} >&2`] : []),
        `  exit ${response.status ?? 0}`,
        "fi",
      ].join("\n");
    });
    writeNodeCommand(nodePath, script);
    writeShellCommand(
      gitPath,
      `${responseCases.join("\n")}\nexec node ${shellQuote(nodePath)} "$@"`,
    );
  }
  fakeGitBinDirs.set(key, binDir);
  return binDir;
}

function runWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  const nodeArgs = [
    ...(options.nodePreload ? ["--require", options.nodePreload] : []),
    bundledWrapperPath,
    ...args,
  ];
  return spawnSync(process.execPath, nodeArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    env: wrapperEnv(helpText, options),
    timeout: options.timeoutMs ?? 10_000,
  });
}

function runSourceWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  return spawnSync(process.execPath, ["scripts/crabbox-wrapper.mjs", ...args], {
    cwd: repoRoot,
    encoding: "utf8",
    input: options.input,
    env: wrapperEnv(helpText, options),
    timeout: options.timeoutMs ?? 10_000,
  });
}

function runDefaultWrapper(args: string[], options: WrapperOptions = {}) {
  return runWrapper(defaultProviderHelp, args, options);
}

type WrapperOptions = {
  configJson?: Record<string, unknown>;
  configStatus?: number;
  env?: Record<string, string>;
  extraPathEntries?: string[];
  gitResponses?: Record<string, { status?: number; stdout?: string; stderr?: string }>;
  input?: string;
  nodePreload?: string;
  timeoutMs?: number;
};

function spawnWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  const nodeArgs = [
    ...(options.nodePreload ? ["--require", options.nodePreload] : []),
    bundledWrapperPath,
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
    CRABBOX_TARGET: "",
    CRABBOX_TARGET_OS: "",
    CRABBOX_WINDOWS_MODE: "",
    OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "",
    OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "0",
    OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
    ...(options.configJson
      ? {
          OPENCLAW_FAKE_CRABBOX_CONFIG_JSON: JSON.stringify({
            brokerMode: "managed",
            ...options.configJson,
          }),
        }
      : {}),
    ...(options.configStatus
      ? { OPENCLAW_FAKE_CRABBOX_CONFIG_STATUS: String(options.configStatus) }
      : {}),
    ...options.env,
    OPENCLAW_FAKE_GIT_RESPONSES: JSON.stringify(gitResponses),
  };
}

type FakeCrabboxOutput = {
  args: string[];
  cwd: string;
  scriptContent?: string;
};

const fakeCrabboxProtocol = "OPENCLAW_FAKE_CRABBOX_V1";

function parseFakeCrabboxOutput(result: ReturnType<typeof runWrapper>): FakeCrabboxOutput {
  if (result.stdout.startsWith(`${fakeCrabboxProtocol}\0`)) {
    const fields = result.stdout.split("\0");
    const count = Number(fields[1]);
    return {
      args: fields.slice(2, 2 + count),
      cwd: fields[2 + count] ?? "",
      scriptContent: fields[3 + count] ?? "",
    };
  }
  return JSON.parse(result.stdout.trim()) as FakeCrabboxOutput;
}

function makeInvocationLog(): string {
  const dir = invocationLogTempDirs.make("openclaw-crabbox-invocations-");
  return path.join(dir, "invocations.jsonl");
}

function readInvocations(logPath: string): string[][] {
  return readFileSync(logPath, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as string[]);
}

type ParsedWrapperRun = {
  output: ReturnType<typeof parseFakeCrabboxOutput>;
  remoteCommand: string;
  result: ReturnType<typeof runWrapper>;
};

function expectSuccessfulWrapperRun(result: ReturnType<typeof runWrapper>): ParsedWrapperRun {
  expect(result.status).toBe(0);
  const output = parseFakeCrabboxOutput(result);
  const remoteCommand = normalizeShellLineEndings(output.args.at(-1) ?? "");
  return { output, remoteCommand, result };
}

function runSuccessfulDefaultWrapper(args: string[], options: WrapperOptions = {}) {
  return expectSuccessfulWrapperRun(runDefaultWrapper(args, options));
}

function runSuccessfulWrapper(helpText: string, args: string[], options: WrapperOptions = {}) {
  return expectSuccessfulWrapperRun(runWrapper(helpText, args, options));
}

function runBrokerWrapper(args: string[], options: WrapperOptions = {}) {
  return runWrapper(brokerProviderHelp, args, {
    ...options,
    env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.40.0", ...options.env },
  });
}

function runSuccessfulBrokerWrapper(args: string[], options: WrapperOptions = {}) {
  return expectSuccessfulWrapperRun(runBrokerWrapper(args, options));
}

function managedBrokerConfig(
  provider: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    provider,
    coordinator: "configured-broker",
    brokerMode: "managed",
    brokerAuth: "configured",
    ...overrides,
  };
}

function directBrokerConfig(provider: string): Record<string, unknown> {
  return { provider, coordinator: "", brokerMode: "", brokerAuth: "missing" };
}

function windowsHydrateArgs(...args: string[]): string[] {
  return ["actions", "hydrate", "--provider", "aws", "--target", "windows", ...args];
}

function runSuccessfulWindowsHydrate(...args: string[]): ParsedWrapperRun {
  return runSuccessfulWrapper(azureProviderHelp, windowsHydrateArgs(...args));
}

function runSuccessfulNativeWindows(
  provider: "aws" | "azure",
  command: string[],
  shell = false,
): ParsedWrapperRun {
  return runSuccessfulWrapper("provider: hetzner, aws, azure, local-container\n", [
    "run",
    "--provider",
    provider,
    "--target",
    "windows",
    "--windows-mode",
    "normal",
    "--id",
    "cbx_test",
    ...(shell ? ["--shell"] : []),
    "--",
    ...command,
  ]);
}

function expectHydratedWindowsShell(run: ParsedWrapperRun, command: string): void {
  expect(run.output.args).toContain("--shell");
  expect(run.remoteCommand).toContain(
    "$env:CRABBOX_PNPM_MODULES_DIR) { $env:CRABBOX_PNPM_MODULES_DIR } else { $env:PNPM_CONFIG_MODULES_DIR }",
  );
  expect(run.remoteCommand).toContain("hydrated pnpm modules directory does not exist");
  expect(run.remoteCommand).toContain('mklink /J "$openclawSelfModules" "$openclawModulesDir"');
  expect(run.remoteCommand).toContain(
    'mklink /J "$openclawWorkspaceModules" "$openclawModulesDir"',
  );
  expect(run.remoteCommand).toContain(command);
}

const remotePosixHydratedModulesBootstrap =
  'openclaw_modules_dir="${CRABBOX_PNPM_MODULES_DIR:-${PNPM_CONFIG_MODULES_DIR:-}}"; if [ -n "$openclaw_modules_dir" ] && [ -d "$openclaw_modules_dir" ] && [ ! -e node_modules ]; then ln -s "$openclaw_modules_dir" node_modules; fi;';

function expectHydratedPosixShell(
  run: Pick<ParsedWrapperRun, "output" | "remoteCommand">,
  command: string,
): void {
  expect(run.output.args).toContain("--shell");
  expect(run.remoteCommand).toContain(remotePosixHydratedModulesBootstrap);
  expect(run.remoteCommand).toContain(command);
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
    await delay(10);
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
    delay(timeoutMs, undefined, { ref: false }).then(() => {
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
    // The wrapper waits for the detached process group to disappear before exit.
    // A live PID here would expose the cleanup-ordering regression this proves.
    expect(isProcessAlive(descendantPid)).toBe(false);
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

function expectMacosJsBootstrap(remoteCommand: string, command: string): void {
  expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
  expectGroupedShellCommand(remoteCommand, command);
}

function expectMacosPackageCommand(
  { output, remoteCommand }: ParsedWrapperRun,
  command: string,
  beforeGrouped?: (remoteCommand: string) => void,
): void {
  expect(output.args).toContain("--shell");
  expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
  expect(remoteCommand).toContain("pnpm --version >&2");
  expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
  beforeGrouped?.(remoteCommand);
  expectGroupedShellCommand(remoteCommand, command);
}

function runSuccessfulMacosShell(shellScript: string, options: WrapperOptions = {}) {
  return runSuccessfulDefaultWrapper(
    ["run", "--provider", "aws", "--target", "macos", "--shell", "--", shellScript],
    options,
  );
}

function runSuccessfulMacosCommand(command: string[], options: WrapperOptions = {}) {
  return runSuccessfulDefaultWrapper(
    ["run", "--provider", "aws", "--target", "macos", "--", ...command],
    options,
  );
}

function runSuccessfulMacosScript(script: string, trailingArgs: string[] = []): ParsedWrapperRun {
  return runSuccessfulDefaultWrapper(
    ["run", "--provider", "aws", "--target", "macos", "--script-stdin", ...trailingArgs],
    { input: script },
  );
}

function runDelegatedBlacksmith(args: string[], env: Record<string, string>) {
  if (process.platform === "win32") {
    return runDefaultWrapper(args, { ...cleanSparseSyncOptions, env });
  }
  const physicalSyncRoot = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-sync-physical-"));
  const syncRootAlias = `${physicalSyncRoot}-alias`;
  symlinkSync(physicalSyncRoot, syncRootAlias, "dir");
  tempDirs.push(syncRootAlias, physicalSyncRoot);
  const result = runDefaultWrapper(args, {
    ...cleanSparseSyncOptions,
    env: { ...env, OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRootAlias },
  });
  if (result.stdout.trim()) {
    expect(
      parseFakeCrabboxOutput(result).cwd.startsWith(`${realpathSync(physicalSyncRoot)}${path.sep}`),
    ).toBe(true);
  }
  return result;
}

const remoteChangedGateEnvPrefix =
  "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1";
const remoteChangedGateExport = `export ${remoteChangedGateEnvPrefix};`;
const remoteChangedGateFetch =
  'git fetch -q --depth=2 origin "$openclaw_changed_gate_base:refs/remotes/origin/main"';
const sparseChangedGateOptions = {
  gitResponses: {
    [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
    [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
    [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
  },
} satisfies WrapperOptions;

const cleanSparseSyncOptions = {
  gitResponses: {
    [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
    [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
  },
} satisfies WrapperOptions;

function withSparseSyncRoot(
  name: string,
  env: Record<string, string>,
  check: (fixture: { result: ReturnType<typeof runWrapper>; syncRoot: string }) => void,
): void {
  const syncRoot = path.join(repoRoot, name);
  rmSync(syncRoot, { recursive: true, force: true });
  try {
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      ...cleanSparseSyncOptions,
      env: { ...env, OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot },
    });
    check({ result, syncRoot });
  } finally {
    rmSync(syncRoot, { recursive: true, force: true });
  }
}

function runSparseShell(shellScript: string) {
  return runSuccessfulDefaultWrapper(
    ["run", "--provider", "aws", "--shell", "--", shellScript],
    sparseChangedGateOptions,
  );
}

function expectChangedGateGitBootstrap(remoteCommand: string): void {
  expect(remoteCommand).toContain("command -v git");
  expect(remoteCommand).toContain("openclaw_changed_gate_base=abc123");
  expect(remoteCommand).toContain(
    "openclaw_changed_gate_bundle=.openclaw-crabbox-changed-gate.bundle",
  );
  expect(remoteCommand).toContain("mktemp /tmp/openclaw-changed-gate.XXXXXX");
  expect(remoteCommand).toContain('cp "$openclaw_changed_gate_bundle"');
  const cleanupIndex = remoteCommand.indexOf(
    'rm -rf -- "$openclaw_changed_gate_bundle" "$openclaw_changed_gate_bundle".* || exit 2',
  );
  expect(cleanupIndex).toBeGreaterThanOrEqual(0);
  expect(cleanupIndex).toBeLessThan(remoteCommand.indexOf("rm -rf .git || exit 2"));
  expect(remoteCommand).toContain("git init -q || exit 2");
  expect(remoteCommand).toContain(`${remoteChangedGateFetch} || exit 2`);
  expect(remoteCommand).toContain(
    'git fetch -q "$openclaw_changed_gate_bundle_tmp" HEAD:refs/heads/openclaw-changed-gate-tree',
  );
  expect(remoteCommand).toContain("git rev-parse refs/heads/openclaw-changed-gate-tree^{tree}");
  expect(remoteCommand).toContain(
    'commit-tree "$openclaw_changed_gate_tree" -p refs/remotes/origin/main',
  );
  expect(remoteCommand).toContain(
    'git update-ref refs/heads/openclaw-changed-gate-head "$openclaw_changed_gate_head"',
  );
  expect(remoteCommand).toContain(
    'git reset --hard --quiet "$openclaw_changed_gate_target" || exit 2',
  );
  expect(remoteCommand).toContain("git clean -fd -q || exit 2");
  expect(remoteCommand).toContain("changed-gate bundle disappeared before import");
  expect(remoteCommand).not.toContain("git apply");
  expect(remoteCommand).not.toContain("; &&");
}

afterAll(() => {
  rmSync(bundledWrapperPath, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/crabbox-wrapper", () => {
  beforeAll(() => {
    mkdirSync(path.dirname(bundledWrapperPath), { recursive: true });
    buildSync({
      bundle: true,
      entryPoints: [path.join(repoRoot, "scripts/crabbox-wrapper.mts")],
      format: "esm",
      logLevel: "silent",
      outfile: bundledWrapperPath,
      platform: "node",
      target: "node22",
    });
    runSourceWrapper("provider: aws\n", ["--version"]);
  });

  it("routes CI workloads through the first ready provider", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "ci-fast", "--", "echo ok"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "blacksmith-testbox",
        },
      },
    );
    expect(output.args).toContain("daytona");
    expect(result.stderr).toContain(
      "route workload=ci-fast selected=daytona chain=blacksmith-testbox,daytona,azure,aws",
    );
  });

  it("uses brokered cloud providers as the final CI fallback", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload=ci-fast", "--", "echo ok"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "blacksmith-testbox,daytona,azure",
        },
      },
    );
    expect(output.args).toContain("aws");
    expect(result.stderr).toContain("selected=aws");
  });

  it("keeps the configured provider when no workload is requested", () => {
    const { output, result } = runSuccessfulBrokerWrapper(["run", "--", "echo ok"], {
      configJson: managedBrokerConfig("aws", { target: "linux", windowsMode: "normal" }),
    });
    expect(output.args).not.toContain("--provider");
    expect(result.stderr).not.toContain("route workload=");
  });

  it("derives run option arity from the probed Crabbox help", () => {
    const helpText = `${defaultProviderHelp}${[
      "sandbox-session-timeout duration",
      "sandbox-memory float",
      "sandbox-retries int",
      "sandbox-setting string",
      "sandbox-attachment value",
    ]
      .map((option) => `  -${option}\n`)
      .join("")}`;
    const { output } = runSuccessfulWrapper(helpText, [
      "run",
      "--sandbox-session-timeout",
      "30s",
      "--sandbox-memory",
      "1.5",
      "--sandbox-retries",
      "2",
      "--sandbox-setting",
      "safe",
      "--sandbox-attachment",
      "name=proof",
      "--provider",
      "local-container",
      "--",
      "echo",
      "ok",
    ]);

    expect(output.args).toEqual([
      "run",
      "--sandbox-session-timeout",
      "30s",
      "--sandbox-memory",
      "1.5",
      "--sandbox-retries",
      "2",
      "--sandbox-setting",
      "safe",
      "--sandbox-attachment",
      "name=proof",
      "--provider",
      "local-container",
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} echo ok`,
    ]);
  });

  it("routes the provider-neutral changed gate without consuming its run option values", () => {
    const { output, remoteCommand, result } = runSuccessfulBrokerWrapper(
      [
        "run",
        "--workload",
        "ci-fast",
        "--idle-timeout",
        "90m",
        "--ttl",
        "240m",
        "--timing-json",
        "--",
        "env",
        "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1",
        "OPENCLAW_CHANGED_LANES_RAW_SYNC=1",
        "CI=1",
        "PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN=false",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      { env: { OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "blacksmith-testbox" } },
    );

    expect(output.args).toContain("daytona");
    expect(output.args).not.toContain("blacksmith-testbox");
    expect(output.args).toContain("90m");
    expect(output.args).toContain("240m");
    expectHydratedPosixShell({ output, remoteCommand }, "corepack pnpm check:changed");
    expect(result.stderr).toContain("route workload=ci-fast selected=daytona");
  });

  it("requires the originating provider when reusing a workload-routed lease", () => {
    const result = runBrokerWrapper(
      ["run", "--workload", "interactive", "--id", "cbx_existing", "--", "echo ok"],
      {},
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "reusing a workload-routed lease with --id requires --provider",
    );
  });

  it.each([
    {
      name: "explicit provider",
      args: [
        "run",
        "--workload",
        "untrusted",
        "--provider",
        "aws",
        "--id",
        "cbx_trusted",
        "--",
        "echo ok",
      ],
      env: {},
    },
    {
      name: "environment provider",
      args: ["run", "--workload", "untrusted", "--id", "cbx_trusted", "--", "echo ok"],
      env: { CRABBOX_PROVIDER: "aws" },
    },
  ])("rejects untrusted lease reuse through an $name", ({ args, env }) => {
    const result = runBrokerWrapper(args, {
      env: {
        ...(env as Record<string, string>),
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "workload=untrusted requires a fresh lease; --id reuse is forbidden",
    );
  });

  it("reuses a workload-routed lease through its explicit provider", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      [
        "run",
        "--provider",
        "daytona",
        "--workload",
        "interactive",
        "--id",
        "cbx_existing",
        "--",
        "echo ok",
      ],
      {},
    );
    expect(output.args).toContain("daytona");
    expect(result.stderr).not.toContain("route workload=");
  });

  it("routes configured macOS targets through AWS", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "ci-proof", "--", "echo ok"],
      {
        configJson: managedBrokerConfig("blacksmith-testbox", {
          target: "macos",
          windowsMode: "normal",
        }),
        env: {
          OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_TARGET: "macos",
        },
      },
    );
    expect(output.args).toContain("aws");
    expect(result.stderr).toContain("chain=aws");
  });

  it("uses one provider-scoped doctor per candidate and never calls standalone whoami", () => {
    const invocationLog = makeInvocationLog();
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "desktop", "--", "echo ok"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
          OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "azure",
          OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS: "1",
        },
      },
    );

    expect(output.args).toContain("aws");
    expect(result.stderr).toContain("selected=aws chain=azure,aws");
    const invocations = readInvocations(invocationLog);
    expect(invocations.filter(([command]) => command === "doctor").map((args) => args[2])).toEqual([
      "azure",
      "aws",
    ]);
    expect(invocations.filter(([command]) => command === "whoami")).toEqual([]);
  });

  it("falls through a doctor-reported auth failure to the next provider", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "desktop", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_UNAUTHORIZED_PROVIDERS: "azure" } },
    );

    expect(output.args).toContain("aws");
    expect(result.stderr).toContain("selected=aws chain=azure,aws");
    expect(result.stderr).toContain("azure:doctor exited 1");
  });

  it("fails closed when provider readiness reports broker auth failure", () => {
    const result = runBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_PROVIDER_UNAUTHORIZED_PROVIDERS: "aws" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "provider=aws requires managed Crabbox broker authentication for OpenClaw proof",
    );
    expect(result.stderr).toContain("login --url https://crabbox.openclaw.ai");
  });

  it("fails closed without auth guidance on a legacy non-auth doctor failure", () => {
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: {
        OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.1",
        OPENCLAW_FAKE_CRABBOX_LEGACY_UNAUTHORIZED_PROVIDERS: "aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws failed readiness for OpenClaw proof");
    expect(result.stderr).not.toContain("login --url");
  });

  it.each([
    { help: defaultProviderHelp, provider: "aws" },
    { help: azureProviderHelp, provider: "azure" },
  ])("trusts healthy legacy doctor readiness for $provider", ({ help, provider }) => {
    const invocationLog = makeInvocationLog();
    const result = runWrapper(help, ["run", "--provider", provider, "--", "echo ok"], {
      configStatus: 1,
      env: {
        OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
        OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.1",
        OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS: "1",
      },
    });

    expect(result.status).toBe(0);
    expect(readInvocations(invocationLog).filter(([command]) => command === "whoami")).toEqual([]);
  });

  it("keeps Blacksmith independent from broker auth probes", () => {
    const invocationLog = makeInvocationLog();
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: {
        OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
        OPENCLAW_FAKE_CRABBOX_WHOAMI_STATUS: "1",
      },
    });

    expect(result.status).toBe(0);
    const invocations = readInvocations(invocationLog);
    expect(invocations.filter(([command]) => command === "doctor")).toEqual([]);
    expect(invocations.filter(([command]) => command === "whoami")).toEqual([]);
  });

  it("allows explicit provider runs when broker is ready but another doctor check fails", () => {
    const { output } = runSuccessfulBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "aws" },
    });

    expect(output.args).toContain("aws");
  });

  it.each([
    ["malformed JSON", "OPENCLAW_FAKE_CRABBOX_MALFORMED_DOCTOR_PROVIDERS"],
    ["malformed schema", "OPENCLAW_FAKE_CRABBOX_INVALID_DOCTOR_PROVIDERS"],
    ["provider mismatch", "OPENCLAW_FAKE_CRABBOX_MISMATCHED_DOCTOR_PROVIDERS"],
    ["missing broker check", "OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS"],
    ["inconsistent exit status", "OPENCLAW_FAKE_CRABBOX_INCONSISTENT_DOCTOR_PROVIDERS"],
  ])("fails closed on %s", (_name, envName) => {
    const result = runBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: { [envName]: "aws" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws failed readiness for OpenClaw proof");
  });

  it("accepts managed broker token-command auth when doctor is healthy", () => {
    const { output } = runSuccessfulBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      configJson: managedBrokerConfig("aws", { brokerAuth: "command" }),
    });

    expect(output.args).toContain("aws");
  });

  it("allows a provider-scoped doctor to use its full dependency timeout", () => {
    const { output } = runSuccessfulBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_DOCTOR_DELAY_MS: "5500" },
      timeoutMs: 20_000,
    });

    expect(output.args).toContain("aws");
  }, 20_000);

  it("probes native Windows readiness with the requested target context", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      [
        "run",
        "--workload",
        "ci-proof",
        "--target",
        "windows",
        "--windows-mode",
        "normal",
        "--",
        "echo ok",
      ],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_TARGET: "windows",
          OPENCLAW_FAKE_CRABBOX_EXPECT_DOCTOR_WINDOWS_MODE: "normal",
        },
      },
    );
    expect(output.args).toContain("azure");
    expect(result.stderr).toContain("chain=azure,aws");
  });

  it("rejects the Windows workload without a Windows target", () => {
    const result = runBrokerWrapper(["run", "--workload", "windows", "--", "echo ok"], {});

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("workload=windows requires target=windows");
    expect(result.stdout).toBe("");
  });

  it("preserves following options when workload has no value", () => {
    const result = runBrokerWrapper(
      ["run", "--workload", "--target", "windows", "--", "echo ok"],
      {},
    );

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--workload requires a value");
    expect(result.stderr).not.toContain('unsupported Crabbox workload "--target"');
    expect(result.stdout).toBe("");
  });

  it("trusts doctor readiness over stale local broker mode", () => {
    const { output } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "desktop", "--", "echo ok"],
      {
        configJson: managedBrokerConfig("azure", {
          target: "linux",
          windowsMode: "normal",
          brokerMode: "registered",
        }),
      },
    );

    expect(output.args).toContain("azure");
  });

  it("falls through Blacksmith when the Crabbox binary is too old", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "ci-fast", "--", "echo ok"],
      {
        env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" },
      },
    );
    expect(output.args).toContain("azure");
    expect(result.stderr).toContain(
      "blacksmith-testbox:requires Crabbox >= 0.22.0 for Blacksmith Testbox",
    );
  });

  it("ignores direct-cloud debugging during automatic readiness checks", () => {
    const result = runBrokerWrapper(["run", "--workload", "desktop", "--", "echo ok"], {
      configJson: { coordinator: "", brokerAuth: "missing" },
      env: {
        OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
        OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "azure,aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no ready provider for workload=desktop");
    expect(result.stderr).toContain("provider readiness azure:doctor exited 1");
  });

  it("does not treat an injected Azure Windows default as direct intent", () => {
    const result = runBrokerWrapper(["run", "--target", "windows", "--", "echo ok"], {
      configJson: directBrokerConfig("blacksmith-testbox"),
      env: {
        OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
        OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "azure",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=azure failed readiness for OpenClaw proof");
  });

  it("keeps workload configuration away from administrative commands", () => {
    const result = runDefaultWrapper(["--version"], {
      env: { OPENCLAW_CRABBOX_WORKLOAD: "ci-fast" },
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("crabbox 0.22.1");
    expect(result.stderr).not.toContain("route workload=");
  });

  it("does not validate workload flags on administrative commands", () => {
    const result = runDefaultWrapper(["--version", "--workload", "surprise"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("crabbox 0.22.1");
    expect(result.stderr).not.toContain("unsupported Crabbox workload");
  });

  it("keeps explicit provider choices outside automatic routing", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--provider", "azure", "--workload", "interactive", "--", "echo ok"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "azure",
        },
      },
    );
    expect(output.args).toContain("azure");
    expect(result.stderr).not.toContain("route workload=");
  });

  it.each([
    {
      name: "explicit",
      args: ["run", "--provider", "blacksmith-testbox", "--workload", "untrusted", "--", "echo ok"],
      env: {},
    },
    {
      name: "environment",
      args: ["run", "--workload", "untrusted", "--", "echo ok"],
      env: { CRABBOX_PROVIDER: "blacksmith-testbox" },
    },
  ])("rejects $name providers outside the workload eligibility policy", ({ args, env }) => {
    const result = runBrokerWrapper(args, {
      env: {
        ...(env as Record<string, string>),
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "provider=blacksmith-testbox is not eligible for workload=untrusted; allowed=azure,aws",
    );
  });

  it("requires broker auth for explicit providers inside workload routing", () => {
    const result = runBrokerWrapper(
      ["run", "--provider", "azure", "--workload", "desktop", "--", "echo ok"],
      {
        configJson: directBrokerConfig("azure"),
        env: { OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "azure" },
      },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=azure failed readiness for OpenClaw proof");
  });

  it.each(["aws", "azure", "daytona"])(
    "does not let direct overrides weaken implicit managed %s config",
    (provider) => {
      const result = runBrokerWrapper(["run", "--", "echo ok"], {
        configJson: managedBrokerConfig(provider, { brokerAuth: "missing" }),
        env: {
          OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
          OPENCLAW_FAKE_CRABBOX_UNAUTHORIZED_PROVIDERS: provider,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `provider=${provider} requires managed Crabbox broker authentication`,
      );
    },
  );

  it("still validates workloads when a provider is explicit", () => {
    const result = runWrapper(brokerProviderHelp, [
      "run",
      "--provider",
      "azure",
      "--workload",
      "surprise",
      "--",
      "echo ok",
    ]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unsupported Crabbox workload "surprise"');
  });

  it("requires a compatible Crabbox for configured brokered Daytona runs", () => {
    const result = runBrokerWrapper(["run", "--", "echo ok"], {
      configJson: managedBrokerConfig("daytona"),
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.39.9" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "provider=daytona requires Crabbox >= 0.40.0 for brokered execution",
    );
    expect(result.stderr).toContain(
      "direct Daytona debugging requires an original `--provider daytona`, no `--workload`",
    );
  });

  it.each(["azure", "daytona"])(
    "allows opted-in explicit direct %s commands outside workload routing",
    (provider) => {
      const { output } = runSuccessfulBrokerWrapper(
        ["run", "--provider", provider, "--", "echo ok"],
        {
          configJson: managedBrokerConfig(provider, { brokerAuth: "missing" }),
          env: {
            OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
          },
        },
      );

      expect(output.args).toContain(provider);
    },
  );

  it.each(["azure", "daytona"])(
    "requires direct-cloud opt-in for explicit %s commands",
    (provider) => {
      const result = runBrokerWrapper(["run", "--provider", provider, "--", "echo ok"], {
        configJson: directBrokerConfig(provider),
        env: { OPENCLAW_FAKE_CRABBOX_UNAUTHORIZED_PROVIDERS: provider },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(
        `provider=${provider} requires managed Crabbox broker authentication`,
      );
      expect(result.stderr).toContain(
        `direct ${provider} debugging requires an original \`--provider ${provider}\`, no \`--workload\``,
      );
    },
  );

  it.each(["azure", "daytona"])(
    "does not treat CRABBOX_PROVIDER=%s as explicit direct intent",
    (provider) => {
      const result = runBrokerWrapper(["run", "--", "echo ok"], {
        configJson: directBrokerConfig(provider),
        env: {
          CRABBOX_PROVIDER: provider,
          OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
          OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: provider,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`provider=${provider} failed readiness for OpenClaw proof`);
    },
  );

  it("keeps Blacksmith outside managed cloud broker auth", () => {
    const { output } = runSuccessfulBrokerWrapper(
      ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
      {
        configJson: directBrokerConfig("blacksmith-testbox"),
      },
    );
    expect(output.args).toContain("blacksmith-testbox");
  });

  it("allows intentional direct Daytona debugging on older Crabbox versions", () => {
    const { output } = runSuccessfulBrokerWrapper(
      ["run", "--provider", "daytona", "--", "echo ok"],
      {
        configJson: { coordinator: "", brokerAuth: "missing" },
        env: {
          OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.39.9",
          OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
        },
      },
    );
    expect(output.args).toContain("daytona");
  });

  it("does not allow direct cloud overrides inside workload routing", () => {
    const result = runBrokerWrapper(["run", "--workload", "interactive", "--", "echo ok"], {
      configJson: { coordinator: "", brokerAuth: "missing" },
      env: {
        OPENCLAW_CRABBOX_ALLOW_DIRECT_CLOUD: "1",
        OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "daytona,azure,aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no ready provider for workload=interactive");
    expect(result.stderr).toContain("provider readiness daytona:doctor exited 1");
  });

  it("fails closed when no policy provider is ready", () => {
    const result = runBrokerWrapper(["run", "--workload", "ci-fast", "--", "echo ok"], {
      env: {
        OPENCLAW_FAKE_CRABBOX_UNREADY_PROVIDERS: "blacksmith-testbox,daytona,azure,aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("no ready provider for workload=ci-fast");
    expect(result.stderr).toContain("provider readiness");
    expect(result.stderr).toContain('{"ok":false,"provider":"blacksmith-testbox","checks":');
    expect(result.stderr).toMatch(
      /recovery: run `\S+crabbox doctor --provider blacksmith-testbox --json`/u,
    );
  });

  it("rejects unknown workload policies before execution", () => {
    const result = runDefaultWrapper(["run", "--workload", "surprise", "--", "echo ok"]);

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain('unsupported Crabbox workload "surprise"');
  });

  it("accepts advertised canonical providers from Crabbox help", () => {
    const { output } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "local-container",
      "--",
      "echo ok",
    ]);
    expect(output.args).toContain("local-container");
  });

  it("hints at lease expiry when a reused-lease run fails fast", () => {
    const result = runDefaultWrapper(
      ["run", "--provider", "local-container", "--id", "tbx_expired_fixture", "--", "echo ok"],
      { env: { OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "1" } },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain(
      "run --id tbx_expired_fixture failed fast; reusable leases expire after their idle timeout",
    );
  });

  it("keeps failed runs without a reused lease free of the expiry hint", () => {
    const result = runDefaultWrapper(["run", "--provider", "local-container", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "1" },
    });

    expect(result.status).toBe(1);
    expect(result.stderr).not.toContain("failed fast; reusable leases expire");
  });

  it("requires a current Crabbox binary for Blacksmith Testbox runs", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.22.0");
    expect(result.stderr).toContain("selected binary reported version=crabbox 0.21.9");
  });

  it("applies the Blacksmith version gate to provider aliases", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.22.0");
  });

  it("rejects prerelease Crabbox builds at the Blacksmith minimum boundary", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.0-rc.1" },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary reported version=crabbox 0.22.0-rc.1");
  });

  it("rejects unsafe Crabbox version numbers at the Blacksmith minimum gate", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.9007199254740993.0" },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain(
      "selected binary reported version=crabbox 0.9007199254740993.0",
    );
  });

  it("accepts post-release Crabbox describe builds at the Blacksmith minimum boundary", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.22.0-3-gabc1234" },
    });

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("blacksmith-testbox");
  });

  it("tells operators how to read delegated Testbox proof status", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegated Testbox proof uses the wrapper exitCode");
    expect(result.stderr).toContain("Actions run can show cancelled during external lease cleanup");
  });

  it("rejects reused Blacksmith Testboxes that were not created by Crabbox", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);

    const result = runDefaultWrapper(
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

    const result = runDefaultWrapper(
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
      "--shell",
      "--",
      `export CI=true; ${remotePosixHydratedModulesBootstrap} 'echo ok'`,
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

    const result = runDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--", "echo ok"],
      { env: { ...testHomeEnv(home), XDG_STATE_HOME: stateRoot } },
    );

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(`lease ${id} is claimed by repo /tmp/other-repo`);
    expect(result.stderr).toContain(`use --reclaim to claim it for ${repoRoot}`);

    const reclaimed = runDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--reclaim", "--", "echo ok"],
      { env: { ...testHomeEnv(home), XDG_STATE_HOME: stateRoot } },
    );
    expect(reclaimed.status).toBe(0);
    expect(parseFakeCrabboxOutput(reclaimed).args).toContain("--reclaim");
  });

  it.each([
    { label: "successful", status: 0 },
    { label: "failed", status: 7 },
  ])("restores delegated Blacksmith claims after $label runs", ({ status }) => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const id = `tbx_restore_${status}`;
    const keyPath = path.join(testCrabboxConfigDir(home), "testboxes", id, "id_ed25519");
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "fake test key\n", "utf8");
    const stateRoot = path.join(home, ".local", "state");
    const claimPath = path.join(stateRoot, "crabbox", "claims", `${id}.json`);
    mkdirSync(path.dirname(claimPath), { recursive: true });
    const originalClaim = {
      leaseID: id,
      repoRoot,
      owner: "preserved-owner",
      metadata: { keep: true },
    };
    writeFileSync(claimPath, `${JSON.stringify(originalClaim)}\n`, "utf8");

    const result = runDelegatedBlacksmith(
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--", "echo ok"],
      {
        ...testHomeEnv(home),
        XDG_STATE_HOME: stateRoot,
        OPENCLAW_FAKE_CRABBOX_CLAIM_PATH: claimPath,
        ...(status > 0 ? { OPENCLAW_FAKE_CRABBOX_RUN_STATUS: String(status) } : {}),
      },
    );

    expect(result.status).toBe(status);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(originalClaim);
  });

  it("restores a created delegated Blacksmith claim by captured timing lease id", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const stateRoot = path.join(home, ".local", "state");
    const claimsDir = path.join(stateRoot, "crabbox", "claims");
    const id = "tbx_created_timing";
    const claimPath = path.join(claimsDir, `${id}.json`);
    const decoyPath = path.join(claimsDir, "tbx_created_decoy.json");
    const originalClaim = { leaseID: id, repoRoot, metadata: { keep: true } };
    const decoyClaim = { leaseID: "tbx_created_decoy", repoRoot };
    mkdirSync(claimsDir, { recursive: true });
    writeFileSync(claimPath, `${JSON.stringify(originalClaim)}\n`, "utf8");
    writeFileSync(decoyPath, `${JSON.stringify(decoyClaim)}\n`, "utf8");

    const result = runDelegatedBlacksmith(
      ["run", "--provider", "blacksmith-testbox", "--keep", "--timing-json", "--", "echo ok"],
      {
        ...testHomeEnv(home),
        XDG_STATE_HOME: stateRoot,
        OPENCLAW_FAKE_CRABBOX_CLAIM_PATH: claimPath,
        OPENCLAW_FAKE_CRABBOX_EXTRA_CLAIM_PATH: decoyPath,
        OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID: id,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(originalClaim);
    expect(JSON.parse(readFileSync(decoyPath, "utf8"))).toEqual({
      ...decoyClaim,
      repoRoot: parseFakeCrabboxOutput(result).cwd,
    });
  });

  it("restores created delegated Blacksmith claims from the temporary checkout fallback", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const stateRoot = path.join(home, ".local", "state");
    const claimsDir = path.join(stateRoot, "crabbox", "claims");
    const claimPath = path.join(claimsDir, "tbx_created_fallback.json");
    const siblingPath = path.join(claimsDir, "tbx_created_sibling.json");
    const foreignPath = path.join(claimsDir, "tbx_foreign_fallback.json");
    const createdClaim = { leaseID: "tbx_created_fallback", repoRoot, owner: "created" };
    const siblingClaim = { leaseID: "tbx_created_sibling", repoRoot, owner: "sibling" };
    const foreignClaim = {
      leaseID: "tbx_foreign_fallback",
      repoRoot: "/tmp/genuinely-foreign-repo",
    };
    mkdirSync(claimsDir, { recursive: true });
    writeFileSync(claimPath, `${JSON.stringify(createdClaim)}\n`, "utf8");
    writeFileSync(siblingPath, `${JSON.stringify(siblingClaim)}\n`, "utf8");
    writeFileSync(foreignPath, `${JSON.stringify(foreignClaim)}\n`, "utf8");

    const result = runDelegatedBlacksmith(
      ["run", "--provider", "blacksmith-testbox", "--keep", "--", "echo ok"],
      {
        ...testHomeEnv(home),
        XDG_STATE_HOME: stateRoot,
        OPENCLAW_FAKE_CRABBOX_CLAIM_PATH: claimPath,
        OPENCLAW_FAKE_CRABBOX_EXTRA_CLAIM_PATH: siblingPath,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(createdClaim);
    expect(JSON.parse(readFileSync(siblingPath, "utf8"))).toEqual(siblingClaim);
    expect(JSON.parse(readFileSync(foreignPath, "utf8"))).toEqual(foreignClaim);
  });

  it("restores a failed delegated Blacksmith claim kept on failure", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const stateRoot = path.join(home, ".local", "state");
    const claimPath = path.join(stateRoot, "crabbox", "claims", "tbx_created_failure.json");
    const originalClaim = {
      leaseID: "tbx_created_failure",
      repoRoot,
      metadata: { keepOnFailure: true },
    };
    mkdirSync(path.dirname(claimPath), { recursive: true });
    writeFileSync(claimPath, `${JSON.stringify(originalClaim)}\n`, "utf8");

    const result = runDelegatedBlacksmith(
      ["run", "--provider", "blacksmith-testbox", "--keep-on-failure", "--", "false"],
      {
        ...testHomeEnv(home),
        XDG_STATE_HOME: stateRoot,
        OPENCLAW_FAKE_CRABBOX_CLAIM_PATH: claimPath,
        OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "7",
      },
    );

    expect(result.status).toBe(7);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(originalClaim);
  });

  it("leaves genuinely foreign delegated Blacksmith claims untouched", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);
    const id = "tbx_foreign_claim";
    const keyPath = path.join(testCrabboxConfigDir(home), "testboxes", id, "id_ed25519");
    mkdirSync(path.dirname(keyPath), { recursive: true });
    writeFileSync(keyPath, "fake test key\n", "utf8");
    const stateRoot = path.join(home, ".local", "state");
    const claimPath = path.join(stateRoot, "crabbox", "claims", `${id}.json`);
    mkdirSync(path.dirname(claimPath), { recursive: true });
    const foreignClaim = {
      leaseID: id,
      repoRoot: "/tmp/genuinely-foreign-repo",
      owner: "foreign-owner",
    };
    writeFileSync(claimPath, `${JSON.stringify({ ...foreignClaim, repoRoot })}\n`, "utf8");

    const result = runDelegatedBlacksmith(
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--", "echo ok"],
      {
        ...testHomeEnv(home),
        XDG_STATE_HOME: stateRoot,
        OPENCLAW_FAKE_CRABBOX_CLAIM_PATH: claimPath,
        OPENCLAW_FAKE_CRABBOX_CLAIM_REPO_ROOT: foreignClaim.repoRoot,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(readFileSync(claimPath, "utf8"))).toEqual(foreignClaim);
  });

  it("lets Crabbox resolve reusable Testbox slugs", () => {
    const home = mkdtempSync(path.join(tmpdir(), "openclaw-crabbox-home-"));
    tempDirs.push(home);

    const result = runDefaultWrapper(
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
      "--shell",
      "--",
      `export CI=true; ${remotePosixHydratedModulesBootstrap} 'echo ok'`,
    ]);
  });

  it("exports CI for complete Blacksmith Testbox shell snippets", () => {
    const { output } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--shell",
      "--",
      "cd packages && pnpm install && pnpm build",
    ]);

    expect(output.args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--shell",
      "--",
      `export CI=true; ${remotePosixHydratedModulesBootstrap} cd packages && pnpm install && pnpm build`,
    ]);
  });

  it("only forces the short local-container Docker work root on Linux", () => {
    const { result } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "local-container",
      "--",
      "echo ok",
    ]);

    const expectedMessage =
      "[crabbox] provider=docker using short host-visible work root for OpenClaw Docker tests";
    if (process.platform === "linux") {
      expect(result.stderr).toContain(expectedMessage);
    } else {
      expect(result.stderr).not.toContain(expectedMessage);
    }
  });

  it("defaults AWS macOS runs to on-demand capacity", () => {
    const { output } = runSuccessfulMacosCommand(["echo ok"]);
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} 'echo ok'`,
    ]);
  });

  it("prefers Azure for unqualified Windows runs", () => {
    const { output, result } = runSuccessfulWrapper(azureProviderHelp, [
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

    const remoteCommand = normalizeShellLineEndings(output.scriptContent!);
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
    const { output } = runSuccessfulWrapper(azureProviderHelp, [
      "run",
      "--target",
      "windows",
      "--windows-mode",
      "wsl2",
      "--",
      "echo",
      "ok",
    ]);

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
    const { output, result } = runSuccessfulWrapper(
      azureProviderHelp,
      ["run", "--target", "windows", "--", "echo ok"],
      { env: { CRABBOX_PROVIDER: "aws" } },
    );

    expect(output.args).toEqual(["run", "--target", "windows", "--", "echo ok"]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps the AWS provider env for Windows runs when Azure is unavailable", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--target", "windows", "--", "echo ok"],
      {
        env: { CRABBOX_PROVIDER: "aws" },
      },
    );

    expect(output.args).toEqual(["run", "--target", "windows", "--", "echo ok"]);
    expect(result.stderr).toContain("provider=aws");
  });

  it("keeps existing Windows lease selections on the configured provider", () => {
    const { output, result } = runSuccessfulWrapper(
      azureProviderHelp,
      ["run", "--id", "cbx_existing", "--target", "windows", "--", "echo ok"],
      {
        env: { CRABBOX_PROVIDER: "aws" },
      },
    );

    expect(output.args).toEqual([
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
    const { output } = runSuccessfulWindowsHydrate("--id", "cbx_existing");

    expect(output.args).toEqual(
      windowsHydrateArgs("--id", "cbx_existing", "--job", "hydrate-windows-daemon"),
    );
  });

  it("repairs generic hydrate jobs for native Windows hydrate actions", () => {
    const { output } = runSuccessfulWindowsHydrate("--job", "hydrate", "--id", "cbx_existing");

    expect(output.args).toEqual(
      windowsHydrateArgs("--job", "hydrate-windows-daemon", "--id", "cbx_existing"),
    );
  });

  it("repairs generic hydrate job assignments for native Windows hydrate actions", () => {
    const { output } = runSuccessfulWindowsHydrate("--job=hydrate", "--id", "cbx_existing");

    expect(output.args).toEqual(
      windowsHydrateArgs("--job=hydrate-windows-daemon", "--id", "cbx_existing"),
    );
  });

  it("keeps post-delimiter hydrate payloads untouched for native Windows hydrate actions", () => {
    const { output } = runSuccessfulWindowsHydrate(
      "--id",
      "cbx_existing",
      "--",
      "--job",
      "hydrate",
    );

    expect(output.args).toEqual(
      windowsHydrateArgs(
        "--id",
        "cbx_existing",
        "--job",
        "hydrate-windows-daemon",
        "--",
        "--job",
        "hydrate",
      ),
    );
  });

  it("keeps explicit non-native hydrate jobs for Windows hydrate actions", () => {
    const args = ["--job", "hydrate-github", "--id", "cbx_existing"];
    const { output } = runSuccessfulWindowsHydrate(...args);

    expect(output.args).toEqual(windowsHydrateArgs(...args));
  });

  it("keeps WSL2 hydrate actions on the requested job", () => {
    const args = ["--windows-mode", "wsl2", "--job", "hydrate", "--id", "cbx_existing"];
    const { output } = runSuccessfulWindowsHydrate(...args);

    expect(output.args).toEqual(windowsHydrateArgs(...args));
  });

  it("prefers Azure for unqualified Windows warmups", () => {
    const { output } = runSuccessfulWrapper(azureProviderHelp, ["warmup", "--target", "windows"]);

    expect(output.args).toEqual(["warmup", "--target", "windows", "--provider", "azure"]);
  });

  it("rejects Blacksmith Testbox for Windows-shaped proof", () => {
    for (const args of [
      ["run", "--provider", "blacksmith-testbox", "--target", "windows", "--", "echo ok"],
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--target",
        "windows",
        "--windows-mode",
        "wsl2",
        "--",
        "echo ok",
      ],
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
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      configJson: { coordinator: "", brokerAuth: "missing" },
      env: { OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "aws" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws failed readiness for OpenClaw proof");
    expect(result.stderr).toMatch(/recovery: run `\S+crabbox doctor --provider aws --json`/u);
  });

  it("fails closed for AWS proof when broker auth is stale", () => {
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      configJson: { coordinator: "https://crabbox.openclaw.ai", brokerAuth: "configured" },
      env: {
        OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.40.0",
        OPENCLAW_FAKE_CRABBOX_UNAUTHORIZED_PROVIDERS: "aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "provider=aws requires managed Crabbox broker authentication for OpenClaw proof",
    );
    expect(result.stderr).toContain("login --url https://crabbox.openclaw.ai");
  });

  it("ignores the legacy direct AWS override", () => {
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      configJson: { coordinator: "", brokerAuth: "missing" },
      env: {
        OPENCLAW_CRABBOX_ALLOW_DIRECT_AWS: "1",
        OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "aws",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws failed readiness for OpenClaw proof");
  });

  it("defaults AWS macOS warmups to on-demand capacity", () => {
    const result = runDefaultWrapper(["warmup", "--provider", "aws", "--target", "macos"]);

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
    const explicitMarket = runDefaultWrapper([
      "run",
      "--provider",
      "aws",
      "--target=macos",
      "--market",
      "spot",
      "--",
      "echo ok",
    ]);
    const existingLease = runDefaultWrapper([
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
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} 'echo ok'`,
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
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} 'echo ok'`,
    ]);
  });

  it("bootstraps only Node for raw AWS macOS node commands", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand(["node", "--version"]);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("node-v${node_version}-darwin-${node_arch}.tar.gz");
    expect(remoteCommand).toContain("node --version >&2 || return 1");
    expect(remoteCommand).not.toContain("corepack enable");
    expect(remoteCommand).not.toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "node --version");
  });

  it("preflights Swift 6.2 for raw AWS macOS Swift app builds", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "swift",
      "build",
      "--package-path",
      "apps/macos",
      "--product",
      "OpenClaw",
    ]);
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
    expectMacosPackageCommand(
      runSuccessfulMacosCommand(["pnpm", "mac:package"]),
      "pnpm mac:package",
      (remoteCommand) => {
        expect(remoteCommand).toContain("OpenClaw macOS app proof requires Swift tools 6.2+");
        expect(remoteCommand).toContain("OpenClaw macOS app proof requires Xcode 26.x");
      },
    );
  });

  it("preserves sanitized env pnpm package commands when Swift preflight is needed", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "env",
      "-i",
      "pnpm",
      "mac:package",
    ]);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -i pnpm mac:package");
  });

  it("preserves sanitized env package script commands when JS tooling is needed", () => {
    expectMacosPackageCommand(
      runSuccessfulMacosCommand(["env", "-i", "bash", "scripts/package-mac-app.sh"]),
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    );
  });

  it("does not bootstrap JS tooling for env package scripts behind command", () => {
    const { remoteCommand } = runSuccessfulMacosCommand([
      "command",
      "env",
      "-i",
      "PATH=/usr/bin:/bin",
      "bash",
      "scripts/package-mac-app.sh",
    ]);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("does not bootstrap JS tooling for nested env package scripts that cannot be shimmed", () => {
    for (const args of [
      ["--", "bash", "-lc", "env -i PATH=/usr/bin:/bin bash scripts/package-mac-app.sh"],
      ["--shell", "--", "bash -lc 'env -i PATH=/usr/bin:/bin bash scripts/package-mac-app.sh'"],
    ]) {
      const { remoteCommand } = runSuccessfulDefaultWrapper([
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        ...args,
      ]);
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    }
  });

  it("does not bootstrap Corepack for nested env pnpm commands that cannot be shimmed", () => {
    const { remoteCommand } = runSuccessfulMacosShell(
      "bash -lc 'env -i PATH=/usr/bin:/bin pnpm --version'",
    );
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toBe(
      `${remotePosixHydratedModulesBootstrap} bash -lc 'env -i PATH=/usr/bin:/bin pnpm --version'`,
    );
  });

  it("preserves sanitized env shell package scripts when JS tooling is needed", () => {
    expectMacosPackageCommand(
      runSuccessfulMacosShell("env -i bash scripts/package-mac-app.sh"),
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
    ] as const) {
      expectMacosPackageCommand(
        runSuccessfulMacosShell(shellCommand),
        expectedCommand,
        (remoteCommand) => expect(remoteCommand).not.toContain("'>'"),
      );
    }
  });

  it("preserves trailing shell segments when sanitizing env package scripts", () => {
    expectMacosPackageCommand(
      runSuccessfulMacosShell("env -i bash scripts/package-mac-app.sh && echo done"),
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
    ] as const) {
      expectMacosPackageCommand(runSuccessfulMacosShell(shellCommand), expectedCommand);
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
    ] as const) {
      expectMacosPackageCommand(runSuccessfulMacosShell(shellCommand), expectedCommand);
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
    const run = runSuccessfulMacosShell(shellCommand);
    expectMacosPackageCommand(run, expectedCommand);
    expect(run.remoteCommand).not.toContain("cat <<EOF\nopenclaw_crabbox_env");
  });

  it("preserves control-flow shell segments when sanitizing env package scripts", () => {
    expectMacosPackageCommand(
      runSuccessfulMacosShell("if true; then env -i bash scripts/package-mac-app.sh; fi"),
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
    ] as const) {
      expectMacosPackageCommand(
        runSuccessfulMacosShell(shellCommand),
        expectedCommand,
        (remoteCommand) =>
          expect(remoteCommand).toContain('export OPENCLAW_CRABBOX_BOOTSTRAP_PATH="$PATH";'),
      );
    }
  });

  it.each([
    {
      name: "preflights Swift and JS tooling for raw AWS macOS shell-launched package scripts",
      script: "scripts/package-mac-app.sh",
    },
    {
      js: false,
      name: "keeps raw AWS macOS build-and-run scripts Swift-only",
      script: "scripts/build-and-run-mac.sh",
    },
  ])("$name", ({ js = true, script }) => {
    const { output, remoteCommand } = runSuccessfulMacosCommand(["bash", script]);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_62");
    if (js) {
      expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
      expect(remoteCommand).toContain("pnpm --version >&2");
    } else {
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    }
    expectGroupedShellCommand(remoteCommand, `bash ${script}`);
  });

  it("does not preflight Swift for raw AWS macOS commands that only mention package scripts", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "echo",
      "scripts/package-mac-app.sh",
    ]);
    expect(remoteCommand).not.toContain("openclaw_crabbox_require_macos_swift_62");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "macos",
      "--market",
      "on-demand",
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} echo scripts/package-mac-app.sh`,
    ]);
  });

  it("normalizes inherited Linux UTF-8 locale names for raw AWS macOS bootstrap", () => {
    const { remoteCommand } = runSuccessfulMacosCommand(["node", "--version"], {
      env: {
        LANG: "C.UTF-8",
        LC_ALL: "C.UTF-8",
        LC_CTYPE: "C.UTF-8",
      },
    });
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
    const { output, remoteCommand, result } = runSuccessfulMacosCommand(["bun", "--version"]);
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
    const { remoteCommand } = runSuccessfulMacosCommand(["env", "-i", "bun", "--version"]);
    expect(remoteCommand).toContain("bun --version >&2 || return 1");
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -i bun --version");
  });

  it.each([
    {
      command: ["/usr/bin/env", "pnpm", "--version"],
      expectShell: true,
      expectedCommand: "openclaw_crabbox_env pnpm --version",
      includes: ['corepack enable --install-directory "$PNPM_HOME"'],
      name: "bootstraps Corepack for raw AWS macOS env-prefixed pnpm commands",
    },
    {
      command: ["env", "-i", "PATH=/usr/bin:/bin", "pnpm", "--version"],
      excludes: ["export -f env openclaw_crabbox_env", 'env() { openclaw_crabbox_env "$@"; };'],
      expectedCommand: "openclaw_crabbox_env -i PATH=/usr/bin:/bin pnpm --version",
      includes: [
        "openclaw_crabbox_env",
        "PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}:${1#PATH=}",
      ],
      name: "bootstraps Corepack for raw AWS macOS env option pnpm commands",
    },
    {
      command: ["env", "-u", "FOO", "-i", "PATH=/usr/bin:/bin", "pnpm", "--version"],
      expectedCommand: "openclaw_crabbox_env -u FOO -i PATH=/usr/bin:/bin pnpm --version",
      includes: ["-u|--unset|-C|--chdir)", "-i|--ignore-environment)"],
      name: "bootstraps Corepack for raw AWS macOS env options before ignore-environment",
    },
    {
      command: ["/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "pnpm", "--version"],
      expectShell: true,
      expectedCommand: "openclaw_crabbox_env -i PATH=/usr/bin:/bin pnpm --version",
      name: "bootstraps Corepack for raw AWS macOS absolute env ignore-environment commands",
    },
    {
      command: ["/usr/bin/env", "-i", "pnpm", "--version"],
      expectedCommand: "openclaw_crabbox_env -i pnpm --version",
      includes: [
        'if [ "$openclaw_env_ignore" = "1" ] && [ "$openclaw_env_path_seen" = "0" ]; then openclaw_env_args+=("PATH=${OPENCLAW_CRABBOX_BOOTSTRAP_PATH:-$PATH}"); fi;',
      ],
      name: "injects the bootstrapped PATH for raw AWS macOS absolute env -i commands",
    },
  ])("$name", ({ command, excludes = [], expectShell, expectedCommand, includes = [] }) => {
    const { output, remoteCommand } = runSuccessfulMacosCommand(command);
    if (expectShell) {
      expect(output.args).toContain("--shell");
    }
    for (const snippet of [
      "openclaw_crabbox_bootstrap_macos_js",
      "pnpm --version >&2",
      ...includes,
    ]) {
      expect(remoteCommand).toContain(snippet);
    }
    for (const snippet of excludes) {
      expect(remoteCommand).not.toContain(snippet);
    }
    expectGroupedShellCommand(remoteCommand, expectedCommand);
  });

  it("does not rewrite custom env executables for raw AWS macOS ignore-environment commands", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "./tools/env",
      "-i",
      "pnpm",
      "--version",
    ]);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expectHydratedPosixShell({ output, remoteCommand }, "./tools/env -i pnpm --version");
  });

  it("does not bootstrap env ignore-environment commands that bypass shell functions", () => {
    for (const prefix of ["command", "exec"]) {
      const { output, remoteCommand } = runSuccessfulMacosCommand([
        prefix,
        "env",
        "-i",
        "PATH=/usr/bin:/bin",
        "pnpm",
        "--version",
      ]);
      expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
      expectHydratedPosixShell(
        { output, remoteCommand },
        `${prefix} env -i PATH=/usr/bin:/bin pnpm --version`,
      );
    }
  });

  it("bootstraps env commands behind command when they keep the inherited PATH", () => {
    const { remoteCommand } = runSuccessfulMacosCommand([
      "command",
      "env",
      "CI=1",
      "pnpm",
      "--version",
    ]);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, "command env CI=1 pnpm --version");
  });

  it("does not shadow unrelated env calls in AWS macOS shell commands", () => {
    const shellScript = "node --version; env -i PATH=/usr/bin:/bin printenv PATH";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("openclaw_crabbox_env");
    expect(remoteCommand).not.toContain('env() { openclaw_crabbox_env "$@"; };');
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("does not bootstrap env split-string commands after ignore-environment", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "env",
      "-i",
      "-S",
      "pnpm --version",
    ]);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expectHydratedPosixShell({ output, remoteCommand }, "env -i -S 'pnpm --version'");
  });

  it("bootstraps Corepack for raw AWS macOS env split-string pnpm commands", () => {
    const { remoteCommand } = runSuccessfulMacosCommand(["/usr/bin/env", "-S", "pnpm --version"]);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand.indexOf("-S|--split-string|-S*|--split-string=*)")).toBeLessThan(
      remoteCommand.indexOf("-[!-]*i*)"),
    );
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -S 'pnpm --version'");
  });

  it("bootstraps Corepack for AWS macOS node changed-gate commands", () => {
    const { remoteCommand } = runSuccessfulMacosCommand(["node", "scripts/check-changed.mjs"]);
    expect(remoteCommand).toContain("node --version >&2");
    expect(remoteCommand).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} node scripts/check-changed.mjs`,
    );
  });

  it("bootstraps Corepack for AWS macOS node option changed-gate commands", () => {
    const { remoteCommand } = runSuccessfulMacosCommand([
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
    ]);
    expectMacosJsBootstrap(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} node --max-old-space-size 4096 --env-file-if-exists .env --unhandled-rejections strict --trace-warnings --import=tsx scripts/check-changed.mjs`,
    );
  });

  it("does not treat node script arguments as changed-gate commands", () => {
    const { remoteCommand } = runSuccessfulMacosCommand([
      "node",
      "--trace-warnings",
      "scripts/other.mjs",
      "scripts/check-changed.mjs",
    ]);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expectGroupedShellCommand(
      remoteCommand,
      "node --trace-warnings scripts/other.mjs scripts/check-changed.mjs",
    );
  });

  it("preserves shell commands when bootstrapping raw AWS macOS JavaScript commands", () => {
    const { output, remoteCommand } = runSuccessfulMacosShell("pnpm check:changed");
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expectMacosJsBootstrap(remoteCommand, `${remoteChangedGateExport} pnpm check:changed`);
  });

  it("bootstraps raw AWS macOS shell scripts that set up before JavaScript commands", () => {
    const shellScript = [
      "set -euo pipefail",
      'repo_tmp=$(node -e "console.log(require(\\"node:os\\").tmpdir())")',
      "pnpm --version",
    ].join("\n");
    const { output, remoteCommand } = runSuccessfulMacosShell(shellScript);
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expectMacosJsBootstrap(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript commands", () => {
    const shellScript = "/usr/bin/env CI=1 pnpm --version";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expectGroupedShellCommand(remoteCommand, shellScript);
  });

  it("bootstraps AWS macOS script-stdin runs before the uploaded script body", () => {
    const script = ["set -euo pipefail", "node -v", "pnpm --version"].join("\n");
    const { output, result } = runSuccessfulMacosScript(script);
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
    const { output } = runSuccessfulMacosScript(script, ["--", "arg1"]);
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
    const { output } = runSuccessfulMacosScript(script);
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
    const { output } = runSuccessfulMacosScript(script);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62 || exit $?");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Swift tools 6.2+");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Xcode 26.x");
    expect(output.scriptContent).toContain(`\n${script}`);
  });

  it("preflights Swift and JS for AWS macOS script-stdin package scripts", () => {
    const script = ["#!/usr/bin/env bash", "set -euo pipefail", "pnpm mac:package"].join("\n");
    const { output } = runSuccessfulMacosScript(script);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_62 || exit $?");
    expect(output.scriptContent).toContain(`\n${script}\n`);
  });

  it("bootstraps Corepack for AWS macOS script-stdin env shebangs with option values", () => {
    const script = ["#!/usr/bin/env -C /tmp -u OPENCLAW_FAKE_VAR pnpm", "--version"].join("\n");
    const { output } = runSuccessfulMacosScript(script);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js || exit $?");
    expect(output.scriptContent).toContain('corepack enable --install-directory "$PNPM_HOME"');
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain(`\n${script}\n`);
  });

  it("bootstraps Bun for AWS macOS script-stdin bun shebangs", () => {
    const script = ["#!/usr/bin/env bun", "console.log(Bun.version);"].join("\n");
    const { output } = runSuccessfulMacosScript(script);
    expect(output.scriptContent).toContain("bun_version=1.3.14");
    expect(output.scriptContent).toContain(
      'npm install --global --prefix "$bun_root" --fetch-timeout=120000 --fetch-retries=2 --fetch-retry-mintimeout=2000 --fetch-retry-maxtimeout=15000 "bun@${bun_version}"',
    );
    expect(output.scriptContent).toContain("bun --version >&2 || return 1");
    expect(output.scriptContent).not.toContain("corepack enable");
  });

  it("does not treat run option values as AWS macOS script-stdin flags", () => {
    const result = runDefaultWrapper(
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

  it.each([
    {
      name: "bootstraps raw AWS macOS shell scripts with setup inside command substitutions",
      shellScript: "version=$(cd repo && pnpm --version)",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with assignment-prefix command substitutions",
      shellScript: "TOOL_ROOT=$(pwd) pnpm --version",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with case branches inside command substitutions",
      shellScript: 'version=$(case "$pm" in pnpm) pnpm --version ;; esac)',
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with grouped setup inside command substitutions",
      shellScript: 'echo "$( (echo setup); pnpm --version )"',
    },
    {
      name: "bootstraps raw AWS macOS shell scripts after comments and setup commands",
      shellScript: ["# setup", "cd repo && pnpm --version"].join("\n"),
    },
    {
      name: "bootstraps raw AWS macOS shell scripts after escaped newlines",
      shellScript: "cd repo && \\\npnpm --version",
    },
    {
      expectedCommand: `${remoteChangedGateExport} set -e; exec pnpm check:changed`,
      name: "bootstraps raw AWS macOS shell scripts with exec-prefixed JavaScript commands",
      shellScript: "set -e; exec pnpm check:changed",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with time-prefixed JavaScript commands",
      shellScript: "time -p node -e 'process.exit(0)'",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with JavaScript control conditions",
      shellScript: "if node -e 'process.exit(0)'; then echo ok; fi",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript control conditions",
      shellScript: "if CI=1 pnpm --version; then echo ok; fi",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with JavaScript pipeline stages",
      shellScript: "echo '{}' | node -e 'process.stdin.resume()'",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts after background setup commands",
      shellScript: "setup_task & pnpm --version",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with JavaScript else branches",
      shellScript: "if test -d node_modules; then echo cached; else pnpm --version; fi",
    },
    {
      name: "bootstraps raw AWS macOS shell scripts with JavaScript case branches",
      shellScript: 'case "$(uname -m)" in arm64|x64) pnpm --version ;; esac',
    },
  ])("$name", ({ expectedCommand, shellScript }) => {
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expectMacosJsBootstrap(remoteCommand, expectedCommand ?? shellScript);
  });

  it.each([
    {
      name: "does not bootstrap raw AWS macOS shell scripts for JavaScript-named case labels",
      shellScript: 'case "$packageManager" in pnpm) echo "$packageManager" ;; esac',
    },
    {
      expectSingleShell: true,
      name: "does not bootstrap raw AWS macOS shell scripts that only mention JavaScript tools",
      shellScript: 'echo "node and pnpm are documented here"',
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for quoted JavaScript tool mentions",
      shellScript: 'echo "docs; pnpm --version"',
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for inline comment mentions",
      shellScript: "echo ok # $(pnpm --version)",
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for reserved words in arguments",
      shellScript: "echo then pnpm --version && echo use-case",
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for arithmetic expansion names",
      shellScript: "node=1; echo $((node + 1))",
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for quoted assignment mentions",
      shellScript: 'MSG="use pnpm here" printf "%s\\n" "$MSG"',
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for command lookup checks",
      shellScript: "command -v pnpm",
    },
    {
      name: "does not bootstrap raw AWS macOS shell scripts for timed command lookup checks",
      shellScript: "/usr/bin/time -l command -v pnpm",
    },
  ])("$name", ({ expectSingleShell, shellScript }) => {
    const { output, remoteCommand } = runSuccessfulMacosShell(shellScript);
    if (expectSingleShell) {
      expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    }
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("groups shell commands so fallbacks cannot mask AWS macOS bootstrap failures", () => {
    const { remoteCommand } = runSuccessfulMacosShell("pnpm check:changed || true");
    expectMacosJsBootstrap(remoteCommand, `${remoteChangedGateExport} pnpm check:changed || true`);
  });

  it("does not bootstrap non-macOS AWS JavaScript commands", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "aws",
      "--target",
      "linux",
      "--",
      "pnpm",
      "--version",
    ]);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      "--target",
      "linux",
      "--shell",
      "--",
      `${remotePosixHydratedModulesBootstrap} pnpm --version`,
    ]);
  });

  it("restores hydrated node_modules before AWS native Windows shell commands", () => {
    const run = runSuccessfulNativeWindows("aws", ["corepack pnpm check:changed"], true);
    expectHydratedWindowsShell(run, "corepack pnpm check:changed");
    expect(run.remoteCommand).not.toContain('ln -s "$PNPM_CONFIG_MODULES_DIR" node_modules');
  });

  it("restores hydrated node_modules before Azure native Windows shell commands", () => {
    expectHydratedWindowsShell(
      runSuccessfulNativeWindows("azure", ["corepack pnpm check:changed"], true),
      "corepack pnpm check:changed",
    );
  });

  it("restores hydrated node_modules before AWS native Windows direct commands", () => {
    const { output, remoteCommand } = runSuccessfulNativeWindows("aws", [
      "pnpm",
      "--filter",
      "@openclaw/discord",
      "test",
    ]);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("$env:CRABBOX_PNPM_MODULES_DIR");
    expect(remoteCommand).toContain("pnpm --filter '@openclaw/discord' test");
  });

  it("restores hydrated node_modules before POSIX run commands", () => {
    expectHydratedPosixShell(
      runSuccessfulDefaultWrapper(["run", "--provider", "aws", "--", "echo", "ok"]),
      "echo ok",
    );
  });

  it("does not add POSIX shell bootstraps for env-selected native Windows", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "echo", "ok"],
      { env: { CRABBOX_TARGET: "windows" } },
    );

    expect(output.args).not.toContain("--shell");
    expect(remoteCommand).not.toContain(remotePosixHydratedModulesBootstrap);
  });

  it("keeps env-selected WSL2 runs on the POSIX bootstrap path", () => {
    const { output } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        env: {
          CRABBOX_TARGET: "windows",
          CRABBOX_WINDOWS_MODE: "wsl2",
        },
      },
    );

    expect(output.args).toContain("--script");
    expect(output.args).not.toContain("--shell");
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_wsl2_js");
  });

  it("does not add POSIX shell bootstraps for config-selected native Windows", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(["run", "--", "echo", "ok"], {
      configJson: managedBrokerConfig("aws", {
        target: "windows",
        windowsMode: "normal",
      }),
    });

    expect(output.args).not.toContain("--shell");
    expect(remoteCommand).not.toContain(remotePosixHydratedModulesBootstrap);
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
    const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      gitResponses: {
        [GIT_COMMON_DIR_KEY]: { status: 1 },
        [GIT_CONFIG_SPARSE_KEY]: { status: 1 },
        [GIT_SPARSE_LIST_KEY]: { status: 1 },
      },
    });

    expect(result.status).toBe(0);
    expect(parseFakeCrabboxOutput(result).args).toContain("aws");
  });

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
    const result = runDefaultWrapper(["run", "--provider", "bogus", "--", "echo ok"]);

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

  it("rejects a broken binary before workload provider discovery", () => {
    const helpText =
      "provider: hetzner, aws, local-container, blacksmith-testbox, daytona, azure, or cloudflare\n";
    const result = runWrapper(helpText, ["run", "--workload", "ci-fast", "--", "echo ok"], {
      env: { OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS: "100" },
      extraPathEntries: [makeSlowVersionCrabbox(helpText)],
      nodePreload: testTimingPreload({ spawnTimeoutMs: 25 }),
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary failed basic --version/--help sanity checks");
    expect(result.stderr).not.toContain("no ready provider");
    expect(result.stderr).not.toContain("provider readiness");
  });

  it("retries a cold Crabbox whose run --help is slower than the default probe timeout", () => {
    const helpText = "provider: hetzner, aws, local-container, blacksmith-testbox, or cloudflare\n";
    // First probe is SIGKILLed at 25ms; the retry gets the full generous timeout
    // and reads the (80ms) stderr help, so the wrapper must not hard-fail.
    const result = runWrapper(helpText, ["--version"], {
      env: { OPENCLAW_TEST_CRABBOX_METADATA_PROBE_TIMEOUT_MS: "25" },
      extraPathEntries: [makeSlowHelpCrabbox(helpText, 80)],
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
    const { output, result } = runSuccessfulDefaultWrapper(
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
      cleanSparseSyncOptions,
    );
    expect(output.args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout for clean sparse AWS syncs", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      cleanSparseSyncOptions,
    );
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from abc123");
    expect(output.args.join(" ")).toContain(
      "openclaw_changed_gate_bundle=.openclaw-crabbox-changed-gate.bundle",
    );
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse AWS syncs reuse a lease", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
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
      cleanSparseSyncOptions,
    );
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("bootstraps Git metadata for sparse changed gates on remote raw syncs", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      sparseChangedGateOptions,
    );
    expect(output.args).toContain("--shell");
    expectChangedGateGitBootstrap(remoteCommand);
    expectHydratedPosixShell({ output, remoteCommand }, "corepack pnpm check:changed");
    expect(remoteCommand).toContain("refs/heads/openclaw-changed-gate-head");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("uses an explicit release base for changed-gate sync and remote Git metadata", () => {
    const { remoteCommand, result } = runSuccessfulDefaultWrapper(
      [
        "run",
        "--provider",
        "aws",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
        "--base",
        "origin/release/2026.7.2",
        "--head",
        "HEAD",
      ],
      {
        env: { OPENCLAW_FAKE_GIT_BASE_SHA: "release123" },
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_CHECK_RELEASE_REF_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_RELEASE_HEAD_KEY]: { stdout: "release123\n" },
        },
      },
    );
    expect(result.stderr).toContain("overlaying local HEAD as worktree changes from release123");
    expect(remoteCommand).toContain("openclaw_changed_gate_base=release123");
    expect(remoteCommand).toContain(
      "openclaw_changed_gate_alias=refs/remotes/origin/release/2026.7.2",
    );
    expect(remoteCommand).toContain(
      'git update-ref "$openclaw_changed_gate_alias" refs/remotes/origin/main',
    );
    expect(remoteCommand).toContain(
      "corepack pnpm check:changed --base origin/release/2026.7.2 --head HEAD",
    );
  });

  it("rejects changed-gate revision expressions that cannot be recreated remotely", () => {
    const result = runDefaultWrapper(
      [
        "run",
        "--provider",
        "aws",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
        "--base",
        "origin/main~1",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "remote changed-gate sync requires an exact origin/<branch> base; received: origin/main~1",
    );
  });

  it("rejects compound changed gates with incompatible bases", () => {
    const result = runDefaultWrapper(
      [
        "run",
        "--provider",
        "aws",
        "--shell",
        "--",
        "pnpm check:changed --base origin/release/2026.7.2 && pnpm check:changed --base origin/hotfix",
      ],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "remote changed-gate sync requires one base; received: origin/release/2026.7.2, origin/hotfix",
    );
  });

  it("materializes the changed-gate bundle in the temporary sync checkout", () => {
    const bundle = "synthetic-bundle";
    const markerDir = makeTempDir(tempDirs, "openclaw-changed-gate-force-add-");
    const forceAddMarker = path.join(markerDir, "force-added");
    const syntheticCommitMarker = path.join(markerDir, "synthetic-commit");
    const syntheticHeadMarker = path.join(markerDir, "synthetic-head");
    const rootCommitMarker = path.join(markerDir, "root-commit");
    const selfContainedBundleMarker = path.join(markerDir, "self-contained-bundle");
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE: bundle,
          OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_FORCE_ADD: "1",
          OPENCLAW_FAKE_GIT_BUNDLE: bundle,
          OPENCLAW_FAKE_GIT_FORCE_ADD_MARKER: forceAddMarker,
          OPENCLAW_FAKE_GIT_SYNTHETIC_COMMIT_MARKER: syntheticCommitMarker,
          OPENCLAW_FAKE_GIT_SYNTHETIC_HEAD_MARKER: syntheticHeadMarker,
          OPENCLAW_FAKE_GIT_ROOT_COMMIT_MARKER: rootCommitMarker,
          OPENCLAW_FAKE_GIT_SELF_CONTAINED_BUNDLE_MARKER: selfContainedBundleMarker,
        },
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("changed-gate bundle mismatch");
    expect(existsSync(forceAddMarker)).toBe(true);
    expect(existsSync(syntheticCommitMarker)).toBe(true);
    expect(existsSync(syntheticHeadMarker)).toBe(true);
    expect(existsSync(rootCommitMarker)).toBe(true);
    expect(existsSync(selfContainedBundleMarker)).toBe(true);
  });

  it("transports changed-gate bundles larger than the child-process buffer", () => {
    const bundleBytes = 2 * 1024 * 1024;
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE_BYTES: String(bundleBytes),
          OPENCLAW_FAKE_GIT_BUNDLE_BYTES: String(bundleBytes),
        },
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("changed-gate bundle size mismatch");
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a checkout-controlled changed-gate bundle symlink",
    () => {
      const fixtureDir = makeTempDir(tempDirs, "openclaw-changed-gate-symlink-");
      const victimPath = path.join(fixtureDir, "victim");
      const victimContents = "preserve-me\n";
      const bundle = "synthetic-bundle";
      writeFileSync(victimPath, victimContents, "utf8");

      const result = runDefaultWrapper(
        ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
        {
          env: {
            OPENCLAW_FAKE_CRABBOX_EXPECT_CHANGED_GATE_BUNDLE: bundle,
            OPENCLAW_FAKE_GIT_BUNDLE: bundle,
            OPENCLAW_FAKE_GIT_CHANGED_GATE_BUNDLE_SYMLINK_TARGET: victimPath,
          },
          gitResponses: {
            [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
            [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
            [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
          },
        },
      );

      expect(result.status).toBe(0);
      expect(readFileSync(victimPath, "utf8")).toBe(victimContents);
    },
  );

  it("bootstraps Git metadata for non-sparse changed gates on remote raw syncs", () => {
    const { output, remoteCommand, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      {
        gitResponses: {
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );
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
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
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
      sparseChangedGateOptions,
    );

    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("preserves macOS JS bootstrapping for sparse changed gates on remote raw syncs", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand(
      ["pnpm", "check:changed"],
      sparseChangedGateOptions,
    );
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expectMacosJsBootstrap(
      remoteCommand,
      `openclaw_crabbox_env ${remoteChangedGateEnvPrefix} pnpm check:changed`,
    );
  });

  it("preserves macOS JS and Git bootstraps for sparse shell changed gates with setup", () => {
    const shellScript = ["set -euo pipefail", "pnpm check:changed"].join("\n");
    const { output, remoteCommand } = runSuccessfulMacosShell(
      shellScript,
      sparseChangedGateOptions,
    );
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain("git init -q");
    expectMacosJsBootstrap(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves macOS JS and Git bootstraps for shell-wrapped sparse changed gates", () => {
    const shellScript = "bash -lc 'pnpm check:changed'";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript, sparseChangedGateOptions);
    expect(remoteCommand).toContain("git init -q");
    expectMacosJsBootstrap(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("does not mistake quoted remote-child markers for shell changed-gate environment", () => {
    const shellScript = 'echo "OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1"; pnpm check:changed';
    const { remoteCommand } = runSuccessfulMacosShell(shellScript, sparseChangedGateOptions);

    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expectGroupedShellCommand(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it.each([
    {
      name: "preserves sparse changed-gate Git bootstrap for assignment-prefix command substitutions",
      shellScript: "TOOL_ROOT=$(pwd) pnpm check:changed",
    },
    {
      name: "preserves sparse changed-gate Git bootstrap for command-prefixed shell commands",
      shellScript: "command pnpm check:changed",
    },
    {
      expectFetch: true,
      name: "preserves sparse changed-gate Git bootstrap for bash -lc shell commands",
      shellScript:
        "env CI=1 NODE_OPTIONS=--max-old-space-size=4096 bash -lc 'set -euo pipefail; pnpm check:changed'",
    },
    {
      name: "preserves sparse changed-gate Git bootstrap for shell option values before -c",
      shellScript: "bash -o pipefail -c 'pnpm check:changed'",
    },
    {
      name: "preserves sparse changed-gate Git bootstrap for grouped shell options before -c",
      shellScript: "bash -eo pipefail -c 'pnpm check:changed'",
    },
    {
      name: "preserves sparse changed-gate Git bootstrap for absolute time-prefixed shell commands",
      shellScript: "/usr/bin/time -l pnpm check:changed",
    },
  ])("$name", ({ expectFetch, shellScript }) => {
    const { remoteCommand } = runSparseShell(shellScript);

    expect(remoteCommand).toContain("git init -q");
    if (expectFetch) {
      expect(remoteCommand).toContain(remoteChangedGateFetch);
    }
    expect(remoteCommand).toContain(`&& ${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped node commands", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
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
      sparseChangedGateOptions,
    );
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s node scripts\/check-changed\.mjs --base origin\/main --head HEAD$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct timeout-wrapped shell commands", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "timeout", "1200s", "bash", "-lc", "pnpm check:changed"],
      sparseChangedGateOptions,
    );
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("git init -q");
    expect(remoteCommand).toMatch(
      /&& env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s bash -lc 'pnpm check:changed'$/u,
    );
  });

  it("preserves sparse changed-gate Git bootstrap for direct env -i commands", () => {
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", "--", "env", "-i", "pnpm", "check:changed"],
      sparseChangedGateOptions,
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
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", "--", "/usr/bin/env", "-i", "pnpm", "check:changed"],
      sparseChangedGateOptions,
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

  it.each([
    {
      command: ["./tools/env", "-i", "pnpm", "check:changed"],
      name: "does not mark custom env executables outside the sanitized env",
    },
    {
      command: ["FOO=1", "env", "-i", "pnpm", "check:changed"],
      name: "does not mark assignment-prefixed env -i changed gates outside the sanitized env",
    },
    {
      command: ["timeout", "1200s", "env", "-i", "CI=1", "pnpm", "check:changed"],
      name: "does not mark timeout-prefixed env -i changed gates outside the sanitized env",
    },
    {
      command: ["env", "env", "-i", "pnpm", "check:changed"],
      name: "does not mark nested env -i changed gates outside the sanitized env",
    },
    {
      command: ["--shell", "--", "bash -lc 'env -i CI=1 pnpm check:changed'"],
      name: "does not mark shell env -i changed gates outside the sanitized env",
      shell: true,
    },
  ])("$name", ({ command, shell }) => {
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", ...(shell ? command : ["--", ...command])],
      sparseChangedGateOptions,
    );
    const output = parseFakeCrabboxOutput(result);
    const renderedCommand = shell
      ? normalizeShellLineEndings(output.args.at(-1) ?? "")
      : output.args.join("\0");

    expect(result.status).toBe(0);
    expect(renderedCommand).not.toContain("OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1");
    expect(renderedCommand).not.toContain("git init -q");
  });

  it.each([
    {
      name: "does not treat quoted sparse shell text as a changed gate",
      shellScript: 'cat <<EOF\npnpm check:changed\nEOF\necho "docs; pnpm check:changed"',
    },
    {
      name: "does not treat escaped heredoc bodies as changed gates",
      shellScript: "cat <<\\EOF\npnpm check:changed\nEOF\necho done",
    },
    {
      name: "does not treat nested heredoc bodies in substitutions as changed gates",
      shellScript: 'echo "$(cat <<EOF\npnpm check:changed\nEOF\n)"',
    },
  ])("$name", ({ shellScript }) => {
    const { remoteCommand } = runSparseShell(shellScript);

    expect(remoteCommand).not.toContain("git init -q");
  });

  it("detects JavaScript commands after hyphenated heredoc delimiters", () => {
    const shellScript = "cat <<EOF-JSON\nnode is literal\nEOF-JSON\npnpm --version";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expectMacosJsBootstrap(remoteCommand, shellScript);
  });

  it("bootstraps raw AWS macOS shell scripts for unquoted heredoc command substitutions", () => {
    const shellScript = "cat <<EOF\n$(pnpm --version)\nEOF";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expectMacosJsBootstrap(remoteCommand, shellScript);
  });

  it("keeps quoted heredoc command substitutions literal", () => {
    const shellScript = "cat <<'EOF'\n$(pnpm --version)\nEOF";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expect(remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
  });

  it("preserves existing shell changed-gate commands after remote Git bootstrap", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--shell", "--", "env CI=1 pnpm check:changed"],
      sparseChangedGateOptions,
    );

    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /&& export OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1; env CI=1 pnpm check:changed$/u,
    );
  });

  it("does not inject the POSIX changed-gate bootstrap for Windows targets", () => {
    const { output } = runSuccessfulDefaultWrapper(
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
      sparseChangedGateOptions,
    );
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
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "local-container", "--", "echo ok"],
      cleanSparseSyncOptions,
    );
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("creates sparse-sync temporary full checkouts under the durable cache root", () => {
    withSparseSyncRoot(".crabbox-test-sync-root", {}, ({ result, syncRoot }) => {
      const { output } = expectSuccessfulWrapperRun(result);
      expect(output.cwd).toContain(`${syncRoot}${path.sep}openclaw-crabbox-sync-`);
      expect(readdirSync(syncRoot)).toEqual([]);
    });
  });

  it("fails sparse-sync full checkout early when the sync root is too low on disk", () => {
    withSparseSyncRoot(
      ".crabbox-test-low-disk-sync-root",
      { OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "999999999999999" },
      ({ result, syncRoot }) => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "insufficient free disk for Crabbox sparse-sync full checkout",
        );
        expect(result.stderr).toContain("OPENCLAW_CRABBOX_SYNC_TMPDIR");
        expect(result.stderr).toContain("OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES");
        expect(readdirSync(syncRoot)).toEqual([]);
      },
    );
  });

  it("rejects malformed sparse-sync minimum free byte limits", () => {
    withSparseSyncRoot(
      ".crabbox-test-invalid-disk-sync-root",
      { OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "1024mb" },
      ({ result, syncRoot }) => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a non-negative integer byte count, got "1024mb"',
        );
        expect(readdirSync(syncRoot)).toEqual([]);
      },
    );
  });

  it("rejects unsafe sparse-sync minimum free byte limits", () => {
    withSparseSyncRoot(
      ".crabbox-test-unsafe-disk-sync-root",
      { OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: String(Number.MAX_SAFE_INTEGER + 1) },
      ({ result, syncRoot }) => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a safe non-negative integer byte count",
        );
        expect(readdirSync(syncRoot)).toEqual([]);
      },
    );
  });

  it("rejects malformed sparse-sync keepalive intervals", () => {
    withSparseSyncRoot(
      ".crabbox-test-invalid-keepalive-sync-root",
      { OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "10ms" },
      ({ result, syncRoot }) => {
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(
          'OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS must be a non-negative integer millisecond interval, got "10ms"',
        );
        expect(readdirSync(syncRoot)).toEqual([]);
      },
    );
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
        await delay(20);
        process.kill(runnerPid, "SIGTERM");
      });
    },
  );

  (process.platform === "win32" ? it.skip : it)(
    "terminates when sparse-sync temporary full checkouts disappear while Crabbox is running",
    () => {
      const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
        env: {
          OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "10",
          OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE: "1",
        },
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      });

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
      const result = runDefaultWrapper(["run", "--provider", "aws", "--", "echo ok"], {
        env: {
          OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS: "60000",
          OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT: "1",
        },
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: "" },
        },
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "temporary full checkout vanished before Crabbox finished syncing",
      );
    },
  );

  it("uses a temporary full checkout when existing AWS leases sync clean sparse worktrees", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--id", "cbx_existing", "--", "echo ok"],
      cleanSparseSyncOptions,
    );

    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.args).toContain("--reclaim");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("uses a temporary full checkout when clean sparse branches differ from the Blacksmith ref", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      cleanSparseSyncOptions,
    );

    expect(output.args).not.toContain("--no-sync");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });

  it("keeps sparse dirty worktrees on the original checkout", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: " M scripts/crabbox-wrapper.mjs\n" },
        },
      },
    );

    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(output.cwd).toBe(repoRoot);
  });

  it("keeps local artifact paths rooted at the original checkout", () => {
    const { output } = runSuccessfulDefaultWrapper(
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
      cleanSparseSyncOptions,
    );

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

    const { output, result } = runSuccessfulDefaultWrapper(
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
      cleanSparseSyncOptions,
    );

    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(result.stderr).toContain("preserved");
    expect(statSync(path.join(preservedDir, "fake-artifacts.tgz")).isFile()).toBe(true);
    rmSync(preservedDir, { recursive: true, force: true });
  });

  it("uses the temporary full checkout for sparse sync-only runs", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--blacksmith-ref",
        "feature-branch",
        "--sync-only",
      ],
      cleanSparseSyncOptions,
    );

    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
  });
});
