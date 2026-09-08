// Crabbox Wrapper tests cover crabbox wrapper script behavior.
import { spawn, spawnSync, type SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { build, buildSync } from "esbuild";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  isProviderAdvertised,
  parseProvidersFromHelp,
} from "../../scripts/crabbox-wrapper-providers.mts";
import { pnpmLockfileDocuments } from "../../scripts/lib/pnpm-lockfile-documents.mjs";
import { resolvePnpmRunner } from "../../scripts/pnpm-runner.mts";
import { isProcessAlive } from "../helpers/process-wait.js";
import { makeTempDir, useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const invocationLogTempDirs = useAutoCleanupTempDirTracker(afterEach);
const artifactTempDirs = useAutoCleanupTempDirTracker(afterEach);
const repoRoot = process.cwd();
const bundledWrapperPath = path.join(repoRoot, ".tmp", `crabbox-wrapper-test-${process.pid}.mjs`);
const realBundledWrapperPath = bundledWrapperPath.replace(".mjs", "-real.mjs");
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
  "require-artifact value",
  "script string",
  "target string",
  "ttl duration",
  "windows-mode string",
]
  .map((option) => `  -${option}\n`)
  .join("");
const fakeWarmupValueOptionHelp = `${fakeRunValueOptionHelp}  -lease-id string\n`;
const fakeHydrateValueOptionHelp = `${fakeRunValueOptionHelp}  -field value\n  -job string\n`;
const defaultGitResponses: Record<string, { status?: number; stdout?: string; stderr?: string }> = {
  [GIT_CONFIG_SPARSE_KEY]: { stdout: "false\n" },
  [GIT_SPARSE_LIST_KEY]: { status: 1 },
};
const remoteTestboxBootstrap = "export CI=true;";

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
const fs = require("node:fs"); const path = require("node:path"); const { spawn, execFileSync } = require("node:child_process");
const args = process.argv.slice(2); const helpText = ${JSON.stringify(`${helpText}${fakeRunValueOptionHelp}`)};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const optionValue = (name) => {
  const index = args.findIndex((arg) => arg === "--" + name || arg === "-" + name); const assigned = args.find((arg) => arg.startsWith("--" + name + "=") || arg.startsWith("-" + name + "="));
  return index >= 0 ? args[index + 1] || "" : assigned?.slice(assigned.indexOf("=") + 1) || "";
};
async function main() {
  if (process.env.OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG) fs.appendFileSync(process.env.OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG, JSON.stringify(args) + "\n");
  if (args[0] === "sync-plan") {
    const excluded = new Set(JSON.parse(process.env.OPENCLAW_FAKE_CRABBOX_PRIVACY_PATHS || "[]"));
    const candidates = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
    const topFiles = [...new Set(candidates)].filter((file) => !excluded.has(file) && fs.existsSync(path.dirname(file)) && (() => { try { return !fs.lstatSync(file).isDirectory(); } catch { return false; } })()).map((file) => ({ path: file }));
    if (process.env.OPENCLAW_FAKE_CRABBOX_SELECTION_UNKNOWN_PATH) topFiles.push({ path: "not-a-source-candidate.txt" });
    process.stdout.write(JSON.stringify({ candidate: { files: topFiles.length + Number(process.env.OPENCLAW_FAKE_CRABBOX_SELECTION_COUNT_DELTA || "0") }, topFiles })); return;
  }
  if (args[0] === "providers" && args[1] === "describe") {
    process.stdout.write(process.env.OPENCLAW_FAKE_CRABBOX_DESCRIPTION ?? JSON.stringify({ schemaVersion: 2, provider: { canonical: "blacksmith-testbox" }, capabilities: { features: ["prepared-artifact-workspace"] } }));
    process.exit(Number(process.env.OPENCLAW_FAKE_CRABBOX_DESCRIPTION_STATUS || "0"));
  }
  if (args[0] === "--version") { console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || "crabbox 0.48.1"); return; }
  if (args[0] === "run" && args[1] === "--help") { process.stdout.write(helpText); return; }
  if (args[0] === "warmup" && args[1] === "--help") { process.stdout.write(${JSON.stringify(`${helpText}${fakeWarmupValueOptionHelp}`)}); return; }
  if (args[0] === "actions" && args[1] === "hydrate" && args[2] === "--help") { process.stdout.write(${JSON.stringify(`${helpText}${fakeHydrateValueOptionHelp}`)}); return; }
  if (args[0] === "doctor") {
    const provider = optionValue("provider"); const target = optionValue("target"); const windowsMode = optionValue("windows-mode");
    if (process.env.OPENCLAW_FAKE_CRABBOX_DOCTOR_PROGRESS) process.stderr.write(process.env.OPENCLAW_FAKE_CRABBOX_DOCTOR_PROGRESS + "\n");
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
  if (args[0] === "run" && process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACT_LINKS) {
    for (const [file, target] of Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACT_LINKS))) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.symlinkSync(target, file); }
  }
  if (args[0] === "run" && process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACTS) {
    for (const [file, bytes] of Object.entries(JSON.parse(process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACTS))) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(bytes, "base64")); }
  }
  if (args[0] === "run" && process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACT_FIFO) execFileSync("mkfifo", [process.env.OPENCLAW_FAKE_CRABBOX_ARTIFACT_FIFO]);
  const runStatus = Number.parseInt(process.env.OPENCLAW_FAKE_CRABBOX_RUN_STATUS || "0", 10); if (args[0] === "run" && runStatus !== 0) { process.stdout.write(JSON.stringify({ args, cwd: process.cwd() }) + "\n"); process.stderr.write("fake run failure\n"); process.exit(runStatus); }
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
  if (process.env.OPENCLAW_FAKE_CRABBOX_COPY_CHANGED_GATE_BUNDLE_TO) fs.copyFileSync(bundlePath, process.env.OPENCLAW_FAKE_CRABBOX_COPY_CHANGED_GATE_BUNDLE_TO);
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
        `  printf '%s\\n' "\${OPENCLAW_FAKE_CRABBOX_VERSION:-crabbox 0.48.1}"`,
        "  exit 0",
        "fi",
        'if [ "$#" -eq 2 ] && [ "$1" = "run" ] && [ "$2" = "--help" ]; then',
        `  printf '%s' ${shellQuote(runHelpText)}`,
        "  exit 0",
        "fi",
        'if [ "$#" -eq 2 ] && [ "$1" = "warmup" ] && [ "$2" = "--help" ]; then',
        `  printf '%s' ${shellQuote(`${helpText}${fakeWarmupValueOptionHelp}`)}`,
        "  exit 0",
        "fi",
        'if [ "$#" -eq 3 ] && [ "$1" = "actions" ] && [ "$2" = "hydrate" ] && [ "$3" = "--help" ]; then',
        `  printf '%s' ${shellQuote(`${helpText}${fakeHydrateValueOptionHelp}`)}`,
        "  exit 0",
        "fi",
        "fast_run=1",
        'for arg in "$@"; do',
        '  case "$arg" in --artifact-glob|-artifact-glob|--script|-script) fast_run=0 ;; esac',
        "done",
        'if { [ "$1" = "run" ] || [ "$1" = "warmup" ]; } && [ "$fast_run" -eq 1 ] &&',
        '  [ -z "${OPENCLAW_FAKE_CRABBOX_CLAIM_PATH:-}${OPENCLAW_FAKE_CRABBOX_EXTRA_CLAIM_PATH:-}${OPENCLAW_FAKE_CRABBOX_TIMING_LEASE_ID:-}${OPENCLAW_FAKE_CRABBOX_RUN_STATUS:-}${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_AND_EXIT:-}${OPENCLAW_FAKE_CRABBOX_DELETE_CWD_ONCE:-}${OPENCLAW_FAKE_CRABBOX_DESCENDANT_PID_PATH:-}${OPENCLAW_FAKE_CRABBOX_COPY_CHANGED_GATE_BUNDLE_TO:-}" ]; then',
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
  else console.log(process.env.OPENCLAW_FAKE_CRABBOX_VERSION || "crabbox 0.48.1");
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
if (args[0] === "worktree" && args[1] === "add") {
  fs.mkdirSync(args[3], { recursive: true });
  process.exit(0);
}
if (args[0] === "-C" && args[2] === "sparse-checkout" && args[3] === "disable") process.exit(0);
if (args[0] === "-C" && args[2] === "rev-parse") {
  const value = args[3] === "HEAD" ? process.env.OPENCLAW_FAKE_GIT_HEAD_SHA || "def456" : args[3] === "HEAD^{tree}" ? process.env.OPENCLAW_FAKE_GIT_HEAD_TREE_SHA || "tree456" : args[3].endsWith("^{tree}") ? process.env.OPENCLAW_FAKE_GIT_BASE_TREE_SHA || "base-tree123" : process.env.OPENCLAW_FAKE_GIT_BASE_SHA || "abc123";
  process.stdout.write(value + "\n"); process.exit(0);
}
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
    // Check immediately after wrapper exit for executing descendants.
    // Linux zombies are already terminated even while their PIDs await reaping.
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
  expect(remoteCommand).toContain("&& { ");
  expect(remoteCommand).toContain(command);
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
  expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_63");
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
const remoteChangedGateFetch = "refs/remotes/origin/main";
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
  expect(remoteCommand).toContain("node -e");
  expect(remoteCommand).toContain(".openclaw-crabbox-changed-gate.bundle");
  expect(remoteCommand).toContain('"baseSha":"abc123"');
  expect(remoteCommand).not.toMatch(/git (?:reset|clean|restore|commit) /u);
  expect(remoteCommand).not.toContain("remote-testbox-sync");
  expect(remoteCommand).not.toContain("; &&");
}

afterAll(() => {
  rmSync(bundledWrapperPath, { force: true });
  rmSync(realBundledWrapperPath, { force: true });
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("scripts/crabbox-wrapper", () => {
  beforeAll(async () => {
    mkdirSync(path.dirname(bundledWrapperPath), { recursive: true });
    buildSync({
      bundle: true,
      entryPoints: [path.join(repoRoot, "scripts/crabbox-wrapper.mts")],
      format: "esm",
      logLevel: "silent",
      outfile: realBundledWrapperPath,
      platform: "node",
      target: "node22",
    });
    // Argument routing tests isolate source preparation; the real-Git fixture below
    // executes the unmocked producer and generated receiver together.
    const producerStub = path.join(
      makeTempDir(tempDirs, "openclaw-source-owner-stub-"),
      "producer.mjs",
    );
    writeFileSync(
      producerStub,
      String.raw`
      import fs from "node:fs";
      import path from "node:path";
      export function prepareCrabboxSourceCapsule({syncRoot, base}) {
        fs.mkdirSync(syncRoot, {recursive:true});
        const directory = fs.mkdtempSync(path.join(syncRoot,"openclaw-crabbox-sync-"));
        const bundlePath = ".openclaw-crabbox-changed-gate.bundle";
        fs.writeFileSync(path.join(directory,bundlePath), "fixture capsule");
        return {directory,bundlePath,sourceSha:"d".repeat(40),baseSha:base === "origin/main" ? process.env.OPENCLAW_FAKE_GIT_BASE_SHA || "abc123" : base,tree:"e".repeat(40),carrier:"f".repeat(40),digest:"a".repeat(64),cleanup(){fs.rmSync(directory,{recursive:true,force:true});}};
      }
    `,
    );
    await build({
      bundle: true,
      plugins: [
        {
          name: "source-capsule-fixture",
          setup(builder) {
            builder.onResolve({ filter: /crabbox-source-capsule\.mts$/ }, () => ({
              path: producerStub,
            }));
          },
        },
      ],
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

  it("lets doctor own its timeout and parses machine output from stdout", () => {
    const { output } = runSuccessfulBrokerWrapper(["run", "--provider", "aws", "--", "echo ok"], {
      env: {
        OPENCLAW_FAKE_CRABBOX_DOCTOR_DELAY_MS: "250",
        OPENCLAW_FAKE_CRABBOX_DOCTOR_PROGRESS: "checking provider readiness",
      },
      nodePreload: testTimingPreload({ spawnTimeoutMs: 100 }),
    });

    expect(output.args).toContain("aws");
  });

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

  it("falls through Blacksmith when the Crabbox binary predates ownership fencing", () => {
    const { output, result } = runSuccessfulBrokerWrapper(
      ["run", "--workload", "ci-fast", "--", "echo ok"],
      {
        env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.47.9" },
      },
    );
    expect(output.args).toContain("daytona");
    expect(result.stderr).toContain(
      "blacksmith-testbox:requires Crabbox >= 0.48.0 for Blacksmith Testbox",
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
    expect(result.stdout.trim()).toBe("crabbox 0.48.1");
    expect(result.stderr).not.toContain("route workload=");
  });

  it("does not validate workload flags on administrative commands", () => {
    const result = runDefaultWrapper(["--version", "--workload", "surprise"]);

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("crabbox 0.48.1");
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

  it("checks brokered Daytona before the generic source-capsule floor", () => {
    const result = runBrokerWrapper(["run", "--", "node", "scripts/check-changed.mjs"], {
      configJson: managedBrokerConfig("daytona"),
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.36.0" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain(
      "provider=daytona requires Crabbox >= 0.40.0 for brokered execution",
    );
    expect(result.stderr).toContain(
      "direct Daytona debugging requires an original `--provider daytona`, no `--workload`",
    );
    expect(result.stderr).not.toContain("source capsule requires Crabbox >= 0.37.0");
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
        env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.48.0" },
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
        OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.48.0",
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

  it.each([
    ["--no-sync"],
    ["-no-sync=true"],
    ["--no-sync=false"],
    ["--id", "tbx_unused", "--no-sync"],
  ])("rejects unsupported Testbox sync flags before delegation: %j", (...flags) => {
    const invocationLog = makeInvocationLog();
    const result = runDefaultWrapper(["run", ...flags, "--", "echo ok"], {
      configJson: { provider: "blacksmith-testbox" },
      env: {
        OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
        OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "99",
      },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=blacksmith-testbox does not support --no-sync");
    expect(readInvocations(invocationLog).filter(([command]) => command === "run")).toEqual([]);
  });

  it.each([
    { provider: "blacksmith-testbox", flags: ["--script", "missing-script.sh"] },
    { provider: "blacksmith-testbox", flags: ["--script=missing-script.sh"] },
    { provider: "blacksmith-testbox", flags: ["--script-stdin"] },
    { provider: "blacksmith", flags: ["--script-stdin=true"] },
    { provider: "blacksmith-testbox", flags: ["--id", "tbx_missing", "--script-stdin"] },
    { provider: "blacksmith-testbox", flags: ["--script-stdin=false", "--script-stdin=true"] },
    { provider: "blacksmith-testbox", flags: ["--script=missing-script.sh", "--script-stdin"] },
    { provider: "blacksmith-testbox", flags: ["--script-stdin", "--script=missing-script.sh"] },
  ])(
    "rejects uploaded Testbox scripts before source or lease work: $provider $flags",
    ({ provider, flags }) => {
      const invocationLog = makeInvocationLog();
      const result = runDefaultWrapper(["run", "--provider", provider, ...flags], {
        input: "echo uploaded-script-must-not-run\n",
        env: { OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog },
      });
      expect(result.status).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("does not support --script or --script-stdin");
      expect(result.stderr).toContain("synced script as trailing argv");
      expect(result.stderr).not.toContain("syncing from temporary full checkout");
      expect(
        readInvocations(invocationLog).filter(
          (args) =>
            ["sync-plan", "run", "warmup"].includes(args[0] ?? "") &&
            !(args.length === 2 && args[0] === "run" && args[1] === "--help"),
        ),
      ).toEqual([]);
    },
  );

  it.each([
    ["--script-stdin=false"],
    ["--script-stdin=0"],
    ["--script-stdin=F"],
    ["--script="],
    ["--script-stdin=true", "--script-stdin=false"],
    ["--label", "--script-stdin"],
  ])("keeps disabled or value-only script flags on Testbox command argv: %j", (...flags) => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", ...flags, "--", "echo", "--script-stdin"],
      { input: "must-not-be-read-as-script\n" },
    );
    expect(output.scriptContent).toBe("");
    expect(output.args).not.toContain("--script");
    expect(remoteCommand).toContain("echo --script-stdin");
    for (const flag of flags) {
      expect(output.args).toContain(flag);
    }
  });

  it.each([
    ["--script-stdin="],
    ["--script-stdin=invalid"],
    ["--script-stdin=invalid", "--script-stdin=true"],
    ["--script-stdin=true", "--script-stdin=invalid"],
    ["--script=missing-script.sh", "--script-stdin"],
    ["--script-stdin", "--script=missing-script.sh"],
  ])("preserves invalid or conflicting script flags for Crabbox rejection: %j", (...flags) => {
    const invocationLog = makeInvocationLog();
    // Record the delegated argv and refuse it before the fake transport reads files.
    const result = runDefaultWrapper(
      [
        "run",
        "--provider",
        "aws",
        "--target",
        "macos",
        ...flags,
        "--",
        "node",
        "scripts/check-changed.mjs",
      ],
      {
        input: "must-not-be-consumed-as-script\n",
        env: {
          OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
          OPENCLAW_FAKE_CRABBOX_RUN_STATUS: "2",
        },
      },
    );
    expect(result.status).toBe(2);
    const runs = readInvocations(invocationLog).filter(
      (args) => args[0] === "run" && !(args.length === 2 && args[1] === "--help"),
    );
    expect(runs).toHaveLength(1);
    // The delegated cwd changes; local file operands retain their original repo root.
    const expectedFlags = flags.map((flag) =>
      flag === "--script=missing-script.sh"
        ? `--script=${path.join(repoRoot, "missing-script.sh")}`
        : flag,
    );
    const args = runs[0]!;
    const first = args.indexOf(expectedFlags[0]!);
    expect(first).toBeGreaterThanOrEqual(0);
    expect(args.slice(first, first + expectedFlags.length)).toEqual(expectedFlags);
    expect(args.filter((arg) => /^--script(?:-stdin)?(?:=|$)/u.test(arg))).toEqual(
      expectedFlags.filter((arg) => /^--script(?:-stdin)?(?:=|$)/u.test(arg)),
    );
  });

  it.each([
    { provider: "aws", flags: ["--no-sync"], command: ["echo", "ok"] },
    { provider: "blacksmith-testbox", flags: [], command: ["echo", "--no-sync"] },
    { provider: "blacksmith-testbox", flags: ["--label", "--no-sync"], command: ["echo", "ok"] },
  ])(
    "preserves sync flags outside Testbox run options: $provider $flags $command",
    ({ provider, flags, command }) => {
      const { output } = runSuccessfulDefaultWrapper([
        "run",
        "--provider",
        provider,
        ...flags,
        "--",
        ...command,
      ]);

      if (flags.length > 0) {
        expect(output.args).toContain("--no-sync");
      } else {
        expect(output.args.at(-1)).toContain("echo --no-sync");
      }
    },
  );

  it.skipIf(process.platform === "win32").each(["missing", "overlapping"])(
    "rejects a %s Testbox workspace binding before running the payload",
    (binding) => {
      const { remoteCommand } = runSuccessfulDefaultWrapper([
        "run",
        "--provider",
        "blacksmith-testbox",
        "--",
        "echo",
        "payload-ran",
      ]);
      const cwd = realpathSync(invocationLogTempDirs.make("openclaw-unprepared-testbox-"));
      if (binding === "overlapping") {
        mkdirSync(path.join(cwd, ".git"));
        symlinkSync(cwd, path.join(cwd, ".git", "crabbox-artifact-root"), "dir");
      }
      const result = spawnSync("bash", ["-c", remoteCommand], { cwd, encoding: "utf8" });
      expect(result.status).toBe(2);
      expect(result.stderr).toContain(
        binding === "missing"
          ? "missing prepared Testbox execution workspace"
          : "workspaces overlap",
      );
      expect(result.stdout).not.toContain("payload-ran");
      expect(readdirSync(cwd)).toEqual(binding === "missing" ? [] : [".git"]);
    },
  );

  it.each([
    [
      "--artifact-glob",
      '{"schemaVersion":2,"provider":{"canonical":"blacksmith-testbox"},"capabilities":{"features":["run-artifacts"]}}',
      "0",
    ],
    [
      "--require-artifact",
      '{"schemaVersion":2,"provider":{"canonical":"blacksmith-testbox"},"capabilities":{"features":[]}}',
      "0",
    ],
    ["--artifact-glob", "not-json", "0"],
    [
      "--artifact-glob",
      '{"schemaVersion":2,"provider":{"canonical":"aws"},"capabilities":{"features":["prepared-artifact-workspace"]}}',
      "0",
    ],
    ["--artifact-glob", "{}", "7"],
  ])(
    "requires prepared artifact-workspace support before Testbox sync: %s %s",
    (flag, description, status) => {
      const log = makeInvocationLog();
      writeFileSync(log, "");
      const result = runDefaultWrapper(
        [
          "run",
          "--provider",
          "blacksmith-testbox",
          flag,
          "reports/result.json",
          "--",
          "echo",
          "ok",
        ],
        {
          env: {
            OPENCLAW_FAKE_CRABBOX_DESCRIPTION: description,
            OPENCLAW_FAKE_CRABBOX_DESCRIPTION_STATUS: status,
            OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: log,
          },
        },
      );
      expect(result.status, result.stderr).toBe(2);
      expect(result.stderr).toContain("prepared-artifact-workspace");
      expect(result.stderr).not.toContain("syncing from temporary full checkout");
      expect(readInvocations(log).some(([name]) => name === "run" || name === "sync-plan")).toBe(
        false,
      );
    },
  );

  it("accepts advertised prepared artifact-workspace support", () => {
    const log = makeInvocationLog();
    const result = runDefaultWrapper(
      [
        "run",
        "--provider",
        "blacksmith-testbox",
        "--require-artifact",
        "reports/result.json",
        "--",
        "echo",
        "ok",
      ],
      {
        env: { OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: log },
      },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(readInvocations(log)).toContainEqual([
      "providers",
      "describe",
      "blacksmith-testbox",
      "--json",
    ]);
  });

  it.each([
    ["run", "--provider", "blacksmith-testbox", "--", "echo", "--artifact-glob"],
    ["run", "--provider", "blacksmith-testbox", "--label", "--artifact-glob", "--", "echo", "ok"],
    ["run", "--provider", "aws", "--artifact-glob", "reports/result.json", "--", "echo", "ok"],
  ])(
    "does not require prepared artifact-workspace support outside Testbox artifact options: %j",
    (...args) => {
      const log = makeInvocationLog();
      writeFileSync(log, "");
      const result = runDefaultWrapper(args, {
        env: { OPENCLAW_FAKE_CRABBOX_DESCRIPTION: "{}", OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: log },
      });
      expect(result.status, result.stderr).toBe(0);
      expect(readInvocations(log).some(([name]) => name === "providers")).toBe(false);
    },
  );

  it("checks the Blacksmith ownership floor before the generic source-capsule floor", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.21.9" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.48.0");
    expect(result.stderr).toContain("selected binary reported version=crabbox 0.21.9");
    expect(result.stderr).not.toContain("source capsule requires Crabbox >= 0.37.0");
  });

  it("requires the sync-plan API before AWS changed-gate capsule side effects", () => {
    const log = makeInvocationLog();
    writeFileSync(log, "");
    const result = runDefaultWrapper(
      ["run", "--provider", "aws", "--", "node", "scripts/check-changed.mjs"],
      {
        env: {
          OPENCLAW_FAKE_CRABBOX_VERSION: "crabbox 0.36.0",
          OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: log,
        },
      },
    );
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("source capsule requires Crabbox >= 0.37.0");
    expect(result.stderr).toContain("update Crabbox");
    expect(result.stderr).not.toContain("syncing from temporary full checkout");
    expect(readInvocations(log).filter(([name]) => name === "sync-plan" || name === "run")).toEqual(
      [],
    );
  });

  it.each(["crabbox 0.37.0", "crabbox 0.37.0-3-gabc1234"])(
    "accepts source-capsule build %s at the sync-plan boundary",
    (version) => {
      const result = runDefaultWrapper(
        ["run", "--provider", "aws", "--", "node", "scripts/check-changed.mjs"],
        {
          env: { OPENCLAW_FAKE_CRABBOX_VERSION: version },
        },
      );

      expect(result.status, result.stderr).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("aws");
    },
  );

  it.each([
    ["run", "--provider", "blacksmith-testbox", "--help"],
    ["warmup", "--provider", "blacksmith-testbox"],
    ["status", "--provider", "blacksmith-testbox"],
    ["run", "--provider", "aws", "--", "echo", "ok"],
  ])("does not require the sync-plan API for %j", (...args) => {
    const version = args.includes("blacksmith-testbox") ? "crabbox 0.48.0" : "crabbox 0.36.0";
    const result = runDefaultWrapper(args, {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: version },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stderr).not.toContain("source capsule requires");
  });

  it.each([
    ["blacksmith-testbox", "crabbox 0.47.9"],
    ["blacksmith", "crabbox 0.47.9"],
    ["blacksmith-testbox", "crabbox 0.48.0-rc.1"],
  ])("rejects Blacksmith provider %s with ownership-incomplete build %s", (provider, version) => {
    const result = runDefaultWrapper(["run", "--provider", provider, "--", "echo ok"], {
      env: { OPENCLAW_FAKE_CRABBOX_VERSION: version },
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("provider=blacksmith-testbox requires Crabbox >= 0.48.0");
    expect(result.stderr).toContain(`selected binary reported version=${version}`);
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

  it.each(["crabbox 0.48.0", "crabbox 0.48.0-3-gabc1234"])(
    "accepts Blacksmith ownership-capable build %s",
    (version) => {
      const result = runDefaultWrapper(
        ["run", "--provider", "blacksmith-testbox", "--", "echo ok"],
        {
          env: { OPENCLAW_FAKE_CRABBOX_VERSION: version },
        },
      );

      expect(result.status).toBe(0);
      expect(parseFakeCrabboxOutput(result).args).toContain("blacksmith-testbox");
    },
  );

  it("tells operators how to read delegated Testbox proof status", () => {
    const result = runDefaultWrapper(["run", "--provider", "blacksmith-testbox", "--", "echo ok"]);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("delegated Testbox proof uses the wrapper exitCode");
    expect(result.stderr).toContain("Actions run can show cancelled during external lease cleanup");
  });

  it("rejects reused Blacksmith Testboxes that were not created by Crabbox", () => {
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());

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

  it.each([
    { id: "tbx_owned", createKey: true },
    { id: "blue-hermit", createKey: false },
  ])("delegates reusable Testbox identity $id to Crabbox", ({ id, createKey }) => {
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
    if (createKey) {
      const keyPath = path.join(testCrabboxConfigDir(home), "testboxes", id, "id_ed25519");
      mkdirSync(path.dirname(keyPath), { recursive: true });
      writeFileSync(keyPath, "fake test key\n", "utf8");
    }
    const { output } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--id", id, "--", "echo ok"],
      { env: testHomeEnv(home) },
    );
    expect(output.args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--id",
      id,
      "--reclaim",
      "--shell",
      "--",
      expect.stringContaining("'echo ok'"),
    ]);
  });

  it("fails before reuse when a Blacksmith Testbox is claimed by another repo", () => {
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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
    const home = makeTempDir(tempDirs, "openclaw-crabbox-home-", tmpdir());
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

  it.skipIf(process.platform === "win32").each([0, 43])(
    "executes the named Testbox job with frozen preparation (install exit %s)",
    (installExit) => {
      const root = invocationLogTempDirs.make("openclaw-testbox-job-");
      const events = path.join(root, "events");
      writeShellCommand(
        path.join(root, "corepack"),
        `
case "$*" in
  'pnpm install --frozen-lockfile')
    printf 'install\\n' >> ${shellQuote(events)}
    printf 'install diagnostics\\n'
    exit ${installExit}
    ;;
  'pnpm check:changed')
    printf 'payload\\n' >> ${shellQuote(events)}
    printf 'payload\\n'
    ;;
  *) exit 64 ;;
esac
`,
      );
      const config = parse(readFileSync(path.join(repoRoot, ".crabbox.yaml"), "utf8")) as {
        jobs: { "testbox-changed": { shell?: boolean; command: string } };
      };
      const job = config.jobs["testbox-changed"];
      // Crabbox jobRunArgs uses strings.Fields unless shell is enabled.
      const command = job.shell
        ? job.command
        : job.command.trim().split(/\s+/u).map(shellQuote).join(" ");
      const result = spawnSync("bash", ["-c", command], {
        cwd: root,
        encoding: "utf8",
        timeout: 10_000,
        env: { ...process.env, PATH: [root, process.env.PATH].join(path.delimiter) },
      });
      expect(result.status, result.stderr).toBe(installExit);
      expect(result.stdout).toBe(installExit ? "" : "payload\n");
      expect(result.stderr).toContain("install diagnostics");
      expect(readFileSync(events, "utf8")).toBe(installExit ? "install\n" : "install\npayload\n");
    },
  );

  it("exports CI for complete Blacksmith Testbox shell snippets", () => {
    const { output } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--shell",
      "--",
      "cd packages && pnpm install && pnpm build",
    ]);

    expect(output.args.at(-1)).toContain(remoteTestboxBootstrap);
    expect(output.args.at(-1)).not.toContain("remote-testbox-sync");
    expect(output.args).toEqual([
      "run",
      "--provider",
      "blacksmith-testbox",
      "--shell",
      "--",
      expect.stringContaining("cd packages && pnpm install && pnpm build"),
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
    const { output, result } = runSuccessfulWrapper(
      azureProviderHelp,
      [
        "run",
        "--target",
        "windows",
        "--windows-mode",
        "wsl2",
        "--",
        "corepack",
        "pnpm",
        "check:changed",
      ],
      {
        gitResponses: {
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: " M scripts/crabbox-wrapper.mts\n" },
          [GIT_MERGE_BASE_MAIN_HEAD_KEY]: { stdout: "abc123\n" },
        },
      },
    );

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
    expect(remoteCommand).toContain("install-dependencies.sh");
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_wsl2_js || exit $?");
    expectChangedGateGitBootstrap(remoteCommand);
    expect(remoteCommand.indexOf("node --version >&2 || return 1")).toBeLessThan(
      remoteCommand.indexOf("node -e"),
    );
    expect(remoteCommand.indexOf("corepack enable --install-directory")).toBeLessThan(
      remoteCommand.indexOf("node -e"),
    );
    expect(remoteCommand.indexOf("node -e")).toBeLessThan(
      remoteCommand.indexOf("pnpm --version >&2"),
    );
    expect(remoteCommand).toContain(
      `{ openclaw_crabbox_env ${remoteChangedGateEnvPrefix} corepack pnpm check:changed\n}`,
    );
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(result.stderr).toContain("overlaying the local worktree as changes from abc123");
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

  it.each([
    { scenario: "Azure advertised", help: azureProviderHelp, leaseArgs: [] },
    { scenario: "Azure unavailable", help: defaultProviderHelp, leaseArgs: [] },
    { scenario: "existing lease", help: azureProviderHelp, leaseArgs: ["--id", "cbx_existing"] },
  ])("preserves the Windows provider env override with $scenario", ({ help, leaseArgs }) => {
    const args = ["run", ...leaseArgs, "--target", "windows", "--", "echo ok"];
    const { output, result } = runSuccessfulWrapper(help, args, {
      env: { CRABBOX_PROVIDER: "aws" },
    });
    expect(output.args).toEqual(args);
    expect(result.stderr).toContain("provider=aws");
  });

  it("uses the native Windows daemon job for Windows hydrate actions", () => {
    const { output } = runSuccessfulWindowsHydrate("--id", "cbx_existing");

    expect(output.args).toEqual(
      windowsHydrateArgs("--id", "cbx_existing", "--job", "hydrate-windows-daemon"),
    );
  });

  it.each([[], ["--field", "--job=custom"], ["--field", "--job"]])(
    "repairs generic hydrate jobs for native Windows hydrate actions: %j",
    (...prefix) => {
      const { output } = runSuccessfulWindowsHydrate(
        ...prefix,
        "--job",
        "hydrate",
        "--id",
        "cbx_existing",
      );

      expect(output.args).toEqual(
        windowsHydrateArgs(...prefix, "--job", "hydrate-windows-daemon", "--id", "cbx_existing"),
      );
    },
  );

  it.each([[], ["--field", "--job=custom"], ["--field", "--job"]])(
    "repairs generic hydrate job assignments for native Windows hydrate actions: %j",
    (...prefix) => {
      const { output } = runSuccessfulWindowsHydrate(
        ...prefix,
        "--job=hydrate",
        "--id",
        "cbx_existing",
      );

      expect(output.args).toEqual(
        windowsHydrateArgs(...prefix, "--job=hydrate-windows-daemon", "--id", "cbx_existing"),
      );
    },
  );

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

  it.each([
    { selection: "market", options: ["--target=macos", "--market", "spot"] },
    { selection: "lease", options: ["--target", "macos", "--id", "cbx_existing"] },
  ])("preserves the explicit AWS macOS $selection selection", ({ options }) => {
    const { output } = runSuccessfulDefaultWrapper([
      "run",
      "--provider",
      "aws",
      ...options,
      "--",
      "echo ok",
    ]);
    expect(output.args).toEqual([
      "run",
      "--provider",
      "aws",
      ...options,
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
    expect(remoteCommand).not.toContain(".openclaw-crabbox-changed-gate.bundle");
    expectGroupedShellCommand(remoteCommand, "node --version");
  });

  it("preflights Swift 6.3 for raw AWS macOS Swift app builds", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand([
      "swift",
      "build",
      "--package-path",
      "apps/macos",
      "--product",
      "OpenClaw",
    ]);
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_63");
    expect(remoteCommand).toContain("/Applications/Xcode_26*.app");
    expect(remoteCommand).toContain("/Applications/Xcode-26*.app");
    expect(remoteCommand).toContain("/Applications/Xcode_2[7-9]*.app");
    expect(remoteCommand).toContain('sudo xcode-select -s "$openclaw_developer"');
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Swift tools 6.3+");
    expect(remoteCommand).toContain("xcodebuild -version");
    expect(remoteCommand).toContain("OpenClaw macOS app proof requires Xcode 26.4+");
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
        expect(remoteCommand).toContain("OpenClaw macOS app proof requires Swift tools 6.3+");
        expect(remoteCommand).toContain("OpenClaw macOS app proof requires Xcode 26.4+");
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
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_63");
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
      expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_63");
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

  it.each([
    [
      "env -i bash scripts/package-mac-app.sh",
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    ],
    [
      "env -i PATH=$PATH bash scripts/package-mac-app.sh > out.log",
      "openclaw_crabbox_env -i PATH=$PATH bash scripts/package-mac-app.sh > out.log",
    ],
    [
      "env -i bash scripts/package-mac-app.sh >out.log 2>&1",
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh >out.log 2>&1",
    ],
    [
      "env -i bash scripts/package-mac-app.sh && echo done",
      "openclaw_crabbox_env -i bash scripts/package-mac-app.sh && echo done",
    ],
    [
      "set -e; env -i bash scripts/package-mac-app.sh",
      "set -e; openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    ],
    [
      "time env -i bash scripts/package-mac-app.sh",
      "time openclaw_crabbox_env -i bash scripts/package-mac-app.sh",
    ],
    [
      "(env -i bash scripts/package-mac-app.sh)",
      "(openclaw_crabbox_env -i bash scripts/package-mac-app.sh)",
    ],
    [
      "{ env -i bash scripts/package-mac-app.sh; }",
      "{ openclaw_crabbox_env -i bash scripts/package-mac-app.sh; }",
    ],
    [
      "if true; then env -i bash scripts/package-mac-app.sh; fi",
      "if true; then openclaw_crabbox_env -i bash scripts/package-mac-app.sh; fi",
    ],
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
  ])("preserves package-script shell syntax when rewriting %s", (command, expected) => {
    expectMacosPackageCommand(runSuccessfulMacosShell(command), expected, (remoteCommand) => {
      expect(remoteCommand).not.toContain("'>'");
      expect(remoteCommand).toContain('export OPENCLAW_CRABBOX_BOOTSTRAP_PATH="$PATH";');
    });
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
    expect(remoteCommand).toContain("openclaw_crabbox_require_macos_swift_63");
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
    expect(remoteCommand).not.toContain("openclaw_crabbox_require_macos_swift_63");
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
    expect(remoteCommand).toContain("bun_version=1.4.0");
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

  it.each([
    {
      command: ["./tools/env", "-i", "pnpm", "--version"],
      expected: "./tools/env -i pnpm --version",
    },
    {
      command: ["command", "env", "-i", "PATH=/usr/bin:/bin", "pnpm", "--version"],
      expected: "command env -i PATH=/usr/bin:/bin pnpm --version",
    },
    {
      command: ["exec", "env", "-i", "PATH=/usr/bin:/bin", "pnpm", "--version"],
      expected: "exec env -i PATH=/usr/bin:/bin pnpm --version",
    },
    { command: ["env", "-i", "-S", "pnpm --version"], expected: "env -i -S 'pnpm --version'" },
  ])("keeps unshimmable env commands outside JS bootstrap: $expected", ({ command, expected }) => {
    const run = runSuccessfulMacosCommand(command);
    expect(run.remoteCommand).not.toContain("openclaw_crabbox_bootstrap_macos_js");
    expectHydratedPosixShell(run, expected);
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

  it("bootstraps Corepack for raw AWS macOS env split-string pnpm commands", () => {
    const { remoteCommand } = runSuccessfulMacosCommand(["/usr/bin/env", "-S", "pnpm --version"]);
    expect(remoteCommand).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(remoteCommand).toContain("pnpm --version >&2");
    expect(remoteCommand.indexOf("-S|--split-string|-S*|--split-string=*)")).toBeLessThan(
      remoteCommand.indexOf("-[!-]*i*)"),
    );
    expectGroupedShellCommand(remoteCommand, "openclaw_crabbox_env -S 'pnpm --version'");
  });

  it.each([
    { provider: "aws", target: "macos", targetArgs: [] },
    { provider: "azure", target: "windows", targetArgs: ["--windows-mode", "wsl2"] },
  ])(
    "prepares the capsule installer before a Node changed gate ($provider/$target)",
    ({ provider, target, targetArgs }) => {
      const { output, remoteCommand: renderedCommand } = runSuccessfulWrapper(
        azureProviderHelp,
        [
          "run",
          "--provider",
          provider,
          "--target",
          target,
          ...targetArgs,
          "--",
          "node",
          "scripts/check-changed.mjs",
        ],
        sparseChangedGateOptions,
      );
      const remoteCommand = normalizeShellLineEndings(output.scriptContent || renderedCommand);
      const node = remoteCommand.indexOf("node --version >&2");
      const shim = remoteCommand.indexOf('corepack enable --install-directory "$PNPM_HOME"');
      const receiver = remoteCommand.indexOf("node -e");
      const manager = remoteCommand.indexOf("pnpm --version >&2");
      expect(node).toBeGreaterThanOrEqual(0);
      expect(shim).toBeGreaterThan(node);
      expect(receiver).toBeGreaterThan(shim);
      expect(manager).toBeGreaterThan(receiver);
      expect(remoteCommand).toContain("install-dependencies.sh");
      const payload =
        "openclaw_crabbox_env " + remoteChangedGateEnvPrefix + " node scripts/check-changed.mjs";
      if (provider === "aws") {
        expectGroupedShellCommand(remoteCommand, payload);
      } else {
        expect(remoteCommand).toContain("{ " + payload + "\n}");
      }
    },
  );

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
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_63");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_63 || exit $?");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Swift tools 6.3+");
    expect(output.scriptContent).toContain("OpenClaw macOS app proof requires Xcode 26.4+");
    expect(output.scriptContent).toContain(`\n${script}`);
  });

  it("preflights Swift and JS for AWS macOS script-stdin package scripts", () => {
    const script = ["#!/usr/bin/env bash", "set -euo pipefail", "pnpm mac:package"].join("\n");
    const { output } = runSuccessfulMacosScript(script);
    expect(output.scriptContent).toContain("openclaw_crabbox_bootstrap_macos_js");
    expect(output.scriptContent).toContain("pnpm --version >&2");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_63");
    expect(output.scriptContent).toContain("openclaw_crabbox_require_macos_swift_63 || exit $?");
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
    expect(output.scriptContent).toContain("bun_version=1.4.0");
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

  it.each(
    // prettier-ignore
    [
    ["bootstraps raw AWS macOS shell scripts with setup inside command substitutions", "version=$(cd repo && pnpm --version)", undefined],
    ["bootstraps raw AWS macOS shell scripts with assignment-prefix command substitutions", "TOOL_ROOT=$(pwd) pnpm --version", undefined],
    ["bootstraps raw AWS macOS shell scripts with case branches inside command substitutions", 'version=$(case "$pm" in pnpm) pnpm --version ;; esac)', undefined],
    ["bootstraps raw AWS macOS shell scripts with grouped setup inside command substitutions", 'echo "$( (echo setup); pnpm --version )"', undefined],
    ["bootstraps raw AWS macOS shell scripts after comments and setup commands", ["# setup", "cd repo && pnpm --version"].join("\n"), undefined],
    ["bootstraps raw AWS macOS shell scripts after escaped newlines", "cd repo && \\\npnpm --version", undefined],
    ["bootstraps raw AWS macOS shell scripts with exec-prefixed JavaScript commands", "set -e; exec pnpm check:changed", `${remoteChangedGateExport} set -e; exec pnpm check:changed`],
    ["bootstraps raw AWS macOS shell scripts with time-prefixed JavaScript commands", "time -p node -e 'process.exit(0)'", undefined],
    ["bootstraps raw AWS macOS shell scripts with JavaScript control conditions", "if node -e 'process.exit(0)'; then echo ok; fi", undefined],
    ["bootstraps raw AWS macOS shell scripts with env-prefixed JavaScript control conditions", "if CI=1 pnpm --version; then echo ok; fi", undefined],
    ["bootstraps raw AWS macOS shell scripts with JavaScript pipeline stages", "echo '{}' | node -e 'process.stdin.resume()'", undefined],
    ["bootstraps raw AWS macOS shell scripts after background setup commands", "setup_task & pnpm --version", undefined],
    ["bootstraps raw AWS macOS shell scripts with JavaScript else branches", "if test -d node_modules; then echo cached; else pnpm --version; fi", undefined],
    ["bootstraps raw AWS macOS shell scripts with JavaScript case branches", 'case "$(uname -m)" in arm64|x64) pnpm --version ;; esac', undefined],
  ] as const,
  )("%s", (_name, shellScript, expectedCommand) => {
    const { remoteCommand } = runSuccessfulMacosShell(shellScript);
    expectMacosJsBootstrap(remoteCommand, expectedCommand ?? shellScript);
  });

  it.each(
    // prettier-ignore
    [
    ["does not bootstrap raw AWS macOS shell scripts for JavaScript-named case labels", 'case "$packageManager" in pnpm) echo "$packageManager" ;; esac', undefined],
    ["does not bootstrap raw AWS macOS shell scripts that only mention JavaScript tools", 'echo "node and pnpm are documented here"', true],
    ["does not bootstrap raw AWS macOS shell scripts for quoted JavaScript tool mentions", 'echo "docs; pnpm --version"', undefined],
    ["does not bootstrap raw AWS macOS shell scripts for inline comment mentions", "echo ok # $(pnpm --version)", undefined],
    ["does not bootstrap raw AWS macOS shell scripts for reserved words in arguments", "echo then pnpm --version && echo use-case", undefined],
    ["does not bootstrap raw AWS macOS shell scripts for arithmetic expansion names", "node=1; echo $((node + 1))", undefined],
    ["does not bootstrap raw AWS macOS shell scripts for quoted assignment mentions", 'MSG="use pnpm here" printf "%s\\n" "$MSG"', undefined],
    ["does not bootstrap raw AWS macOS shell scripts for command lookup checks", "command -v pnpm", undefined],
    ["does not bootstrap raw AWS macOS shell scripts for timed command lookup checks", "/usr/bin/time -l command -v pnpm", undefined],
  ] as const,
  )("%s", (_name, shellScript, expectSingleShell) => {
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

  it.each([
    {
      provider: "aws",
      command: ["corepack pnpm check:changed"],
      shell: true,
      expected: "corepack pnpm check:changed",
    },
    {
      provider: "azure",
      command: ["corepack pnpm check:changed"],
      shell: true,
      expected: "corepack pnpm check:changed",
    },
    {
      provider: "aws",
      command: ["pnpm", "--filter", "@openclaw/discord", "test"],
      shell: false,
      expected: "pnpm --filter '@openclaw/discord' test",
    },
  ] as const)(
    "restores hydrated modules for $provider Windows commands: $expected",
    ({ provider, command, shell, expected }) => {
      const run = runSuccessfulWrapper("provider: hetzner, aws, azure, local-container\n", [
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
      expect(run.output.args).toContain("--shell");
      expect(run.remoteCommand).toContain(
        "$env:CRABBOX_PNPM_MODULES_DIR) { $env:CRABBOX_PNPM_MODULES_DIR } else { $env:PNPM_CONFIG_MODULES_DIR }",
      );
      expect(run.remoteCommand).toContain("hydrated pnpm modules directory does not exist");
      expect(run.remoteCommand).toContain('mklink /J "$openclawSelfModules" "$openclawModulesDir"');
      expect(run.remoteCommand).toContain(
        'mklink /J "$openclawWorkspaceModules" "$openclawModulesDir"',
      );
      expect(run.remoteCommand).toContain(expected);
      expect(run.remoteCommand).not.toContain('ln -s "$PNPM_CONFIG_MODULES_DIR" node_modules');
    },
  );

  it("restores hydrated node_modules before POSIX run commands", () => {
    expectHydratedPosixShell(
      runSuccessfulDefaultWrapper(["run", "--provider", "aws", "--", "echo", "ok"]),
      "echo ok",
    );
  });

  it.each([
    {
      source: "environment",
      args: ["--provider", "aws"],
      options: { env: { CRABBOX_TARGET: "windows" } },
    },
    {
      source: "config",
      args: [],
      options: {
        configJson: managedBrokerConfig("aws", { target: "windows", windowsMode: "normal" }),
      },
    },
  ])("keeps $source-selected native Windows outside POSIX bootstrap", ({ args, options }) => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", ...args, "--", "echo", "ok"],
      options,
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

  it.each([
    ["run", "--help"],
    ["warmup", "--help"],
    ["actions", "hydrate", "--help"],
    ["warmup", "--provider", "aws", "--help"],
    ["actions", "hydrate", "--provider", "aws", "--help"],
    ["warmup", "--keep", "--help"],
    ["actions", "hydrate", "--reclaim", "--help"],
    ["help", "actions", "hydrate"],
    ["run", "--label", "--", "--help"],
    ["warmup", "--lease-id", "--", "--help"],
    ["actions", "hydrate", "--field", "--", "--help"],
  ])("prints help without provider checks or sparse checkout preparation: %j", (...args) => {
    const logPath = makeInvocationLog();
    writeFileSync(logPath, "");
    const syncRoot = path.join(path.dirname(logPath), "sync");
    const result = runDefaultWrapper(args, {
      ...cleanSparseSyncOptions,
      configJson: managedBrokerConfig("aws"),
      env: {
        OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
        OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: logPath,
      },
    });

    expect(result.status).toBe(0);
    const commandLength = args[0] === "actions" ? 2 : 1;
    if (args.length === commandLength + 1) {
      const optionHelp =
        args[0] === "run"
          ? fakeRunValueOptionHelp
          : args[0] === "warmup"
            ? fakeWarmupValueOptionHelp
            : fakeHydrateValueOptionHelp;
      expect(result.stdout).toBe(`${defaultProviderHelp}${optionHelp}`);
    } else {
      expect(parseFakeCrabboxOutput(result).args).toEqual(args);
    }
    expect(existsSync(syncRoot)).toBe(false);
    expect(
      readInvocations(logPath).filter(([command]) => command === "config" || command === "doctor"),
    ).toEqual([]);
  });

  it.each([
    ["run", "--provider", "aws", "--label", "--help", "--", "echo ok"],
    ["run", "--provider", "aws", "--", "--help"],
    ["run", "--provider", "aws", "node", "--help"],
    ["run", "--", "--help"],
    ["warmup", "--", "--help"],
    ["actions", "hydrate", "--", "--help"],
    ["warmup", "--lease-id", "--help"],
    ["actions", "hydrate", "--field", "--help"],
    ["run", "--provider", "aws", "-", "--help"],
    ["warmup", "--provider", "aws", "-", "--help"],
    ["actions", "hydrate", "--provider", "aws", "-", "--help"],
  ])("keeps provider gates when help belongs to a payload: %j", (...args) => {
    const result = runDefaultWrapper(args, {
      configJson: directBrokerConfig("aws"),
      env: { OPENCLAW_FAKE_CRABBOX_MISSING_BROKER_PROVIDERS: "aws" },
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("provider=aws failed readiness for OpenClaw proof");
  });

  it("keeps unsupported provider selections rejected", () => {
    const result = runDefaultWrapper(["run", "--provider", "bogus", "--", "echo ok"]);

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("selected binary does not advertise provider bogus");
  });

  it.each([
    ["help", "run", "--", "echo ok"],
    ["help", "actions", "hydrate", "--", "echo ok"],
  ])("does not bypass preparation for a help alias containing a remote payload: %j", (...args) => {
    const result = runDefaultWrapper(args, {
      configJson: managedBrokerConfig("bogus"),
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
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

  it("parses provider choices from the supported --provider help formats", () => {
    const helpText =
      "Usage: crabbox run [options]\n  --provider hetzner|aws|local-container|blacksmith-testbox|cloudflare\n";

    expect(parseProvidersFromHelp(helpText)).toEqual([
      "hetzner",
      "aws",
      "local-container",
      "blacksmith-testbox",
      "cloudflare",
    ]);
    expect(
      parseProvidersFromHelp(
        "  -provider string\n    provider: aws, blacksmith-testbox, local-container (defaults to configured selection)\n",
      ),
    ).toEqual(["aws", "blacksmith-testbox", "local-container"]);
  });

  it.each([
    {
      scenario: "Blacksmith feature ref",
      provider: "blacksmith-testbox",
      args: ["--blacksmith-ref", "feature-branch"],
      command: ["corepack", "pnpm", "check:changed"],
    },
    {
      scenario: "AWS changed gate",
      provider: "aws",
      args: [],
      command: ["corepack", "pnpm", "check:changed"],
      overlay: true,
    },
    {
      scenario: "AWS Windows lease",
      provider: "aws",
      args: ["--target", "windows", "--id", "cbx_existing"],
      command: ["corepack", "pnpm", "build"],
    },
    { scenario: "local container", provider: "local-container", args: [], command: ["echo ok"] },
    {
      scenario: "existing AWS lease",
      provider: "aws",
      args: ["--id", "cbx_existing"],
      command: ["echo ok"],
      reclaim: true,
    },
    {
      scenario: "Blacksmith main ref",
      provider: "blacksmith-testbox",
      args: ["--blacksmith-ref", "main"],
      command: ["echo ok"],
    },
  ])(
    "syncs a clean sparse checkout through a full worktree: $scenario",
    ({ provider, args, command, overlay, reclaim }) => {
      const { output, result } = runSuccessfulDefaultWrapper(
        ["run", "--provider", provider, ...args, "--", ...command],
        cleanSparseSyncOptions,
      );
      expect(result.stderr).toContain("syncing from temporary full checkout");
      expect(output.cwd).toContain("openclaw-crabbox-sync-");
      expect(output.args).not.toContain("--no-sync");
      if (overlay) {
        expect(result.stderr).toContain("overlaying the local worktree as changes from abc123");
        expect(output.args.join(" ")).toContain(".openclaw-crabbox-changed-gate.bundle");
      }
      if (reclaim) {
        expect(output.args).toContain("--reclaim");
      }
    },
  );

  it("bootstraps Git metadata for sparse changed gates on remote raw syncs", () => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", "corepack", "pnpm", "check:changed"],
      sparseChangedGateOptions,
    );
    expect(output.args).toContain("--shell");
    expectChangedGateGitBootstrap(remoteCommand);
    expectHydratedPosixShell({ output, remoteCommand }, "corepack pnpm check:changed");
    expect(remoteCommand).toContain("refs/openclaw/source-capsule");
    expect(remoteCommand).toMatch(
      /; env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
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
    expect(result.stderr).toContain("overlaying the local worktree as changes from release123");
    expect(remoteCommand).toContain('"baseSha":"release123"');
    expect(remoteCommand).toContain("refs/remotes/origin/release/2026.7.2");
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

  it.skipIf(process.platform === "win32").each([
    ["aws", true, "transport"],
    ["aws", false, "transport"],
    ["blacksmith-testbox", true, "transport"],
    ["blacksmith-testbox", false, "transport"],
    ["blacksmith-testbox", false, "graph"],
    ["blacksmith-testbox", false, "frozen"],
    ["blacksmith-testbox", false, "lifecycle"],
    ["blacksmith-testbox", false, "lifecycle-staged-extra"],
    ["blacksmith-testbox", false, "lifecycle-base-ref"],
  ] as const)(
    "transports verified source and dependencies (provider=%s, shallow=%s, scenario=%s)",
    (provider, shallow, scenario) => {
      const root = makeTempDir(tempDirs, "openclaw-changed-gate-real-git-");
      const origin = path.join(root, "origin");
      const producer = path.join(root, "producer");
      const capturedBundle = path.join(root, "captured.bundle");
      const deletedOwned = [
        "committed-deleted.ignored",
        "staged-deleted.ignored",
        "index-only-deleted.ignored",
        "deleted-dir.ignored/owned.txt",
      ];
      const retainedPrivate = ["protected-deleted.ignored", "runtime.ignored"];
      const replacedHistory = provider === "aws" && shallow;
      const deletionReferent = path.join(root, "deletion-referent");
      mkdirSync(deletionReferent);
      writeFileSync(path.join(deletionReferent, "canary.txt"), "private referent\n");
      const fakeBin = makeFakeCrabbox(defaultProviderHelp);
      const home = path.join(root, "home");
      const env = {
        ...testHomeEnv(home),
        PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_AUTHOR_NAME: "Transport fixture",
        GIT_AUTHOR_EMAIL: "transport@example.invalid",
        GIT_COMMITTER_NAME: "Transport fixture",
        GIT_COMMITTER_EMAIL: "transport@example.invalid",
        OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
        OPENCLAW_CRABBOX_SYNC_TMPDIR: path.join(root, "sync"),
        OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "0",
        OPENCLAW_FAKE_CRABBOX_COPY_CHANGED_GATE_BUNDLE_TO: capturedBundle,
        OPENCLAW_FAKE_CRABBOX_PRIVACY_PATHS: JSON.stringify([
          "private-canary.txt",
          "protected-deleted.ignored",
        ]),
      };
      const runCommand = (
        command: string,
        args: string[],
        options: SpawnSyncOptionsWithStringEncoding,
      ) => {
        const startedAt = Date.now();
        const result = spawnSync(command, args, options);
        return { ...result, elapsedMs: Date.now() - startedAt };
      };
      const failureDetail = (result: ReturnType<typeof runCommand>) =>
        `${result.stderr}\n${result.error?.message ?? "no spawn error"}; signal=${result.signal}; elapsed=${result.elapsedMs}ms`;
      const expectRejectedBeforeUpload = (result: ReturnType<typeof runCommand>) => {
        const detail = failureDetail(result);
        expect(result.error, detail).toBeUndefined();
        expect(result.status, detail).toBeTypeOf("number");
        expect(result.status, detail).not.toBe(0);
        expect(existsSync(capturedBundle)).toBe(false);
      };
      const git = (cwd: string, args: string[]) => {
        const result = runCommand("git", args, { cwd, env, encoding: "utf8", timeout: 10_000 });
        expect(result.status, `${args.join(" ")}\n${failureDetail(result)}`).toBe(0);
        return result.stdout.trim();
      };
      mkdirSync(path.join(origin, "scripts"), { recursive: true });
      git(origin, ["init", "-q", "-b", "main"]);
      writeFileSync(path.join(origin, ".gitignore"), ".tmp/\n*.ignored\n!reincluded.ignored\n");
      writeFileSync(path.join(origin, ".gitattributes"), "* text=auto eol=lf\n");
      writeFileSync(
        path.join(origin, ".crabbox.yaml"),
        "sync:\n  exclude:\n    - private-canary.txt\n    - protected-deleted.ignored\n",
      );
      const restored = "old content beyond the receiver's shallow history\n";
      mkdirSync(path.join(origin, "restored"));
      writeFileSync(path.join(origin, "restored", "old.txt"), restored);
      git(origin, ["add", "-A"]);
      git(origin, ["commit", "-qm", "old content"]);
      rmSync(path.join(origin, "restored"), { recursive: true });
      git(origin, ["add", "-A"]);
      git(origin, ["commit", "-qm", "remove old content"]);
      git(origin, ["commit", "--allow-empty", "-qm", "advance history"]);
      const unchanged = Buffer.concat(
        Array.from({ length: 4096 }, (_, index) =>
          createHash("sha256").update(`unchanged-${index}`).digest(),
        ),
      );
      writeFileSync(path.join(origin, "unchanged.bin"), unchanged);
      const hiddenPath = "sparse-only/data.bin";
      const hiddenBytes = Buffer.from([0, 255, 13, 10, 128]);
      mkdirSync(path.join(origin, "sparse-only"));
      writeFileSync(path.join(origin, hiddenPath), hiddenBytes);
      for (const file of ["owner.txt", "deleted.txt", "rename-before.txt", "mode.sh"]) {
        writeFileSync(path.join(origin, file), "base\n");
      }
      writeFileSync(path.join(origin, "tracked.ignored"), "tracked ignored base\n");
      writeFileSync(path.join(origin, "reincluded.ignored"), "reincluded base\n");
      if (replacedHistory) {
        writeFileSync(path.join(origin, "removed-kind.ignored"), "old file kind\n");
        git(origin, ["add", "-f", "removed-kind.ignored"]);
      }
      writeFileSync(path.join(origin, "raw-crlf.txt"), "base\n");
      mkdirSync(path.join(origin, "source-dir"));
      writeFileSync(path.join(origin, "source-dir", "kept.txt"), "source directory\n");
      symlinkSync("source-dir", path.join(origin, "directory-alias"), "dir");
      symlinkSync("owner.txt", path.join(origin, "alias"));
      git(origin, ["add", "-f", "tracked.ignored"]);
      // The leaf is deliberately inert: this test proves transport, not check lanes.
      writeFileSync(
        path.join(origin, "scripts/check-changed.mjs"),
        'import fs from "node:fs"; if (process.env.TRANSPORT_FIXTURE_ARGV) fs.writeFileSync(process.env.TRANSPORT_FIXTURE_ARGV, JSON.stringify(process.argv.slice(2))); process.stdout.write("transport fixture reached\\n");\n',
      );
      copyFileSync(
        path.join(origin, "scripts/check-changed.mjs"),
        path.join(origin, "scripts/source-fixture.mjs"),
      );
      git(origin, ["add", "-A"]);
      git(origin, ["commit", "-qm", "base"]);
      const base = git(origin, ["rev-parse", "HEAD"]);
      const partial = provider === "blacksmith-testbox" && shallow;
      git(origin, ["config", "uploadpack.allowFilter", "true"]);
      git(root, [
        "clone",
        "-q",
        ...(shallow ? ["--depth=1"] : []),
        ...(partial ? ["--filter=blob:none", "--no-checkout"] : []),
        `file://${origin}`,
        producer,
      ]);
      if (partial) {
        git(producer, ["sparse-checkout", "set", "--no-cone", "/*", "!/sparse-only/"]);
        git(producer, ["read-tree", "-mu", "HEAD"]);
        const hiddenObject = git(origin, ["rev-parse", `HEAD:${hiddenPath}`]);
        expect(git(producer, ["rev-list", "--objects", "--all", "--missing=print"])).toContain(
          `?${hiddenObject}`,
        );
      }
      expect(git(producer, ["rev-parse", "--is-shallow-repository"])).toBe(String(shallow));
      const alias = provider === "aws" ? "origin/release/fixture" : "";
      if (alias) {
        git(producer, ["update-ref", `refs/remotes/${alias}`, base]);
      }
      if (!shallow) {
        git(producer, ["repack", "-adb"]);
        expect(
          readdirSync(path.join(producer, ".git", "objects", "pack")).some((file) =>
            file.endsWith(".bitmap"),
          ),
        ).toBe(true);
      }
      const fixtureWrapper = path.join(producer, ".tmp", "crabbox-wrapper.mjs");
      mkdirSync(path.dirname(fixtureWrapper), { recursive: true });
      copyFileSync(realBundledWrapperPath, fixtureWrapper);
      const sourceCommand =
        provider === "blacksmith-testbox"
          ? "scripts/source-fixture.mjs"
          : "scripts/check-changed.mjs";
      const special = "space ' quote ; $(touch injected) `touch injected` & |";
      const sourceArgs = alias ? ["--base", alias, special] : [special];
      const sourceArgv = ["node", sourceCommand, ...sourceArgs];
      const shellCommand = sourceArgv.map(shellQuote).join(" ");
      const scriptBody = '#!/usr/bin/env bash\nexec "$@"\n';
      const scriptInput = path.join(root, "input.sh");
      writeFileSync(scriptInput, scriptBody);
      const runSender = (
        mode: "direct" | "shell" | "script" | "stdin" = "direct",
        delegatedArgs?: string[],
      ) => {
        const payload =
          mode === "script"
            ? ["--script", scriptInput, "--", ...sourceArgv]
            : mode === "stdin"
              ? ["--script-stdin", "--", ...sourceArgv]
              : mode === "shell"
                ? ["--shell", "--", `true; ${shellCommand}`]
                : ["--", "node", sourceCommand, ...sourceArgs];
        const result = runCommand(
          process.execPath,
          [fixtureWrapper, ...(delegatedArgs ?? ["run", "--provider", provider, ...payload])],
          {
            cwd: producer,
            env,
            encoding: "utf8",
            input: mode === "stdin" ? scriptBody : undefined,
            timeout: 10_000,
          },
        );
        expect(result.status, failureDetail(result)).toBe(0);
        const run = expectSuccessfulWrapperRun(result);
        expect(existsSync(run.output.cwd)).toBe(false);
        expect(readdirSync(path.join(root, "sync"))).toEqual([]);
        return {
          remoteCommand: run.output.scriptContent || run.remoteCommand,
          sourceFlags: run.output.args
            .slice(0, run.output.args.indexOf("--"))
            .filter((arg) => /^--script(?:-stdin)?(?:=|$)/u.test(arg)),
          remoteArgs: run.output.scriptContent
            ? run.output.args.slice(run.output.args.indexOf("--") + 1)
            : [],
          bundle: readFileSync(capturedBundle),
        };
      };
      const receive = (
        name: string,
        remoteCommand: string,
        bundle?: Buffer,
        source = origin,
        extraEnv: NodeJS.ProcessEnv = {},
        nativeSeed = true,
        remoteArgs: string[] = [],
        prepareReceiver?: (receiver: string) => void,
      ) => {
        const receiver = path.join(root, name);
        if (source === origin && nativeSeed) {
          git(root, ["clone", "-q", `file://${origin}`, receiver]);
          if (lstatSync(path.join(producer, "source-dir")).isSymbolicLink()) {
            rmSync(path.join(receiver, "source-dir"), { recursive: true });
            symlinkSync(
              readlinkSync(path.join(producer, "source-dir"), { encoding: "buffer" }),
              path.join(receiver, "source-dir"),
              "dir",
            );
          }
          for (const file of [
            "tracked.ignored",
            "reincluded.ignored",
            "unchanged.bin",
            "alias",
            "directory-alias",
          ]) {
            rmSync(path.join(receiver, file), { force: true });
          }
          writeFileSync(path.join(receiver, "owner.txt"), "native stale bytes\n");
          chmodSync(path.join(receiver, "mode.sh"), 0o644);
          // The base index has never known these ignored branch/staged paths.
          for (const file of [...deletedOwned, ...retainedPrivate]) {
            mkdirSync(path.dirname(path.join(receiver, file)), { recursive: true });
            if (file === deletedOwned[2]) {
              symlinkSync(deletionReferent, path.join(receiver, file), "dir");
            } else {
              writeFileSync(path.join(receiver, file), "stale ignored bytes\n");
            }
          }
          writeFileSync(
            path.join(receiver, "deleted-dir.ignored", "runtime.txt"),
            "private runtime\n",
          );
          if (replacedHistory) {
            rmSync(path.join(receiver, "removed-kind.ignored"));
            mkdirSync(path.join(receiver, "removed-kind.ignored"));
            writeFileSync(
              path.join(receiver, "removed-kind.ignored", "owned.txt"),
              "stale child\n",
            );
          }
        } else {
          mkdirSync(receiver);
        }
        prepareReceiver?.(receiver);
        const transport =
          provider === "blacksmith-testbox" ? path.join(root, `${name}-transport`) : receiver;
        if (transport !== receiver) {
          mkdirSync(path.join(transport, ".git"), { recursive: true });
          symlinkSync(
            realpathSync(receiver),
            path.join(transport, ".git", "crabbox-artifact-root"),
            "dir",
          );
        }
        if (bundle) {
          writeFileSync(path.join(transport, ".openclaw-crabbox-changed-gate.bundle"), bundle);
        }
        const result = runCommand("bash", ["-c", remoteCommand, "receiver-script", ...remoteArgs], {
          cwd: transport,
          encoding: "utf8",
          timeout: 10_000,
          env: {
            ...env,
            GIT_CONFIG_COUNT: "2",
            GIT_CONFIG_KEY_0: `url.file://${source}.insteadOf`,
            GIT_CONFIG_VALUE_0: "https://github.com/openclaw/openclaw.git",
            GIT_CONFIG_KEY_1: "protocol.file.allow",
            GIT_CONFIG_VALUE_1: "always",
            ...extraEnv,
          },
        });
        expect(result.error, failureDetail(result)).toBeUndefined();
        if (transport !== receiver && result.status === 0) {
          expect(readlinkSync(path.join(transport, ".git", "crabbox-artifact-root"))).toBe(
            realpathSync(receiver),
          );
          expect(existsSync(path.join(transport, "owner.txt"))).toBe(false);
        }
        return { receiver, result };
      };
      if (scenario !== "transport") {
        const installOwner = ".github/actions/setup-node-env/install-dependencies.sh";
        const ownerPath = path.join(repoRoot, installOwner);
        // Baseline uses the same action-owned recipe before its pure extraction.
        const action: { runs: { steps: Array<{ name?: string; run?: string }> } } = parse(
          readFileSync(path.join(repoRoot, ".github/actions/setup-node-env/action.yml"), "utf8"),
        );
        const installStep = action.runs.steps.find((step) => step.name === "Install dependencies");
        if (!installStep?.run) {
          throw new Error("Missing canonical install recipe");
        }
        const installer: string = existsSync(ownerPath)
          ? readFileSync(ownerPath, "utf8")
          : "#!/usr/bin/env bash\n" + installStep.run;
        const { packageManager }: { packageManager: string } = JSON.parse(
          readFileSync(path.join(repoRoot, "package.json"), "utf8"),
        );
        const { environment } = pnpmLockfileDocuments(
          readFileSync(path.join(repoRoot, "pnpm-lock.yaml"), "utf8"),
        );
        const dependencyEnv = {
          ...env,
          CI: "true",
          PATH: [path.dirname(process.execPath), env.PATH].join(path.delimiter),
          PNPM_CONFIG_STORE_DIR: path.join(root, "dependency-store"),
          PNPM_CONFIG_CACHE_DIR: path.join(root, "dependency-cache"),
        };
        const runPnpm = (directory: string, args: string[]) => {
          const runner = resolvePnpmRunner({ cwd: directory, env: dependencyEnv });
          const result = runCommand(runner.command, [...runner.args, ...args], {
            cwd: directory,
            env: dependencyEnv,
            encoding: "utf8",
          });
          expect(result.error, failureDetail(result)).toBeUndefined();
          expect(result.status, failureDetail(result)).toBe(0);
          return result;
        };
        const rootManifest = { name: "capsule-dependency-fixture", private: true, packageManager };
        const consumerManifest = (graph: "a" | "b") => ({
          name: "capsule-dependency-consumer",
          private: true,
          dependencies: { "capsule-proof-dep": "file:../../fixture-deps/" + graph },
        });
        const writeDependencySource = (directory: string, graph: "a" | "b") => {
          for (const version of ["a", "b"]) {
            const dependency = path.join(directory, "fixture-deps", version);
            mkdirSync(dependency, { recursive: true });
            writeFileSync(
              path.join(dependency, "package.json"),
              JSON.stringify({
                name: "capsule-proof-dep",
                version: version === "a" ? "1.0.0" : "2.0.0",
                main: "index.cjs",
              }),
            );
            writeFileSync(
              path.join(dependency, "index.cjs"),
              "module.exports = 'graph-" + version + "';\n",
            );
          }
          writeFileSync(path.join(directory, "package.json"), JSON.stringify(rootManifest));
          mkdirSync(path.join(directory, "packages/consumer"), { recursive: true });
          writeFileSync(
            path.join(directory, "packages/consumer/package.json"),
            JSON.stringify(consumerManifest(graph)),
          );
          writeFileSync(path.join(directory, "pnpm-workspace.yaml"), "packages:\n  - packages/*\n");
          if (environment !== null) {
            writeFileSync(
              path.join(directory, "pnpm-lock.yaml"),
              "---\n" + environment + "\n---\n",
            );
          }
          mkdirSync(path.join(directory, ".capsule-proof"), { recursive: true });
          writeFileSync(
            path.join(directory, ".gitignore"),
            readFileSync(path.join(origin, ".gitignore"), "utf8") +
              "\nnode_modules/\n.capsule-proof/\n",
          );
        };
        writeDependencySource(producer, "b");
        const version = runPnpm(producer, ["--version"]);
        expect("pnpm@" + version.stdout.trim()).toBe(packageManager.split("+")[0]);
        runPnpm(producer, ["install", "--lockfile-only"]);
        mkdirSync(path.dirname(path.join(producer, installOwner)), { recursive: true });
        writeFileSync(path.join(producer, installOwner), installer);
        writeFileSync(
          path.join(producer, sourceCommand),
          [
            'import fs from "node:fs";',
            'import { createRequire } from "node:module";',
            'const actual = createRequire(new URL("../packages/consumer/package.json", import.meta.url))("capsule-proof-dep");',
            'if (actual !== "graph-b") throw new Error("capsule dependency mismatch: " + actual);',
            'fs.writeFileSync(".capsule-proof/payload", actual);',
            'process.stdout.write("capsule graph-b\\n");',
          ].join("\n") + "\n",
        );
        if (scenario === "frozen") {
          writeFileSync(
            path.join(producer, "packages/consumer/package.json"),
            JSON.stringify(consumerManifest("a")),
          );
        } else if (scenario.startsWith("lifecycle")) {
          const mutation =
            scenario === "lifecycle-staged-extra"
              ? [
                  'const fs = require("node:fs");',
                  'const { execFileSync } = require("node:child_process");',
                  'fs.writeFileSync("lifecycle-extra.mjs", "export const lifecycleExtra = true;\\n");',
                  'execFileSync("git", ["add", "--", "lifecycle-extra.mjs"]);',
                  'fs.writeFileSync(".capsule-proof/lifecycle", "staged-extra");',
                ]
              : scenario === "lifecycle-base-ref"
                ? [
                    'const fs = require("node:fs");',
                    'const { execFileSync } = require("node:child_process");',
                    'const git = (args) => execFileSync("git", args, { encoding: "utf8" });',
                    'const before = git(["rev-parse", "refs/remotes/origin/main"]).trim();',
                    'const head = git(["rev-parse", "HEAD"]).trim();',
                    'const indexBefore = git(["ls-files", "--stage", "-v", "-z"]);',
                    'execFileSync("git", ["update-ref", "refs/remotes/origin/main", "HEAD"]);',
                    'const after = git(["rev-parse", "refs/remotes/origin/main"]).trim();',
                    'const indexAfter = git(["ls-files", "--stage", "-v", "-z"]);',
                    'fs.writeFileSync(".capsule-proof/lifecycle", JSON.stringify({ before, head, after, indexBefore, indexAfter }));',
                  ]
                : [
                    'const fs = require("node:fs");',
                    'fs.writeFileSync(".capsule-proof/lifecycle", "ran");',
                    'fs.writeFileSync("owner.txt", "lifecycle source drift\\n");',
                  ];
          writeFileSync(
            path.join(producer, "scripts/capsule-lifecycle.cjs"),
            mutation.join("\n") + "\n",
          );
          writeFileSync(
            path.join(producer, "package.json"),
            JSON.stringify({
              ...rootManifest,
              scripts: { postinstall: "node scripts/capsule-lifecycle.cjs" },
            }),
          );
        }
        const selectedOwner = readFileSync(path.join(producer, "owner.txt"), "utf8");
        const frozen = runSender();
        let preparedGraph = "";
        const imported = receive(
          "dependency-" + scenario,
          frozen.remoteCommand,
          frozen.bundle,
          origin,
          dependencyEnv,
          true,
          [],
          (receiver) => {
            writeDependencySource(receiver, "a");
            runPnpm(receiver, ["install", "--lockfile-only"]);
            runPnpm(receiver, ["install", "--frozen-lockfile"]);
            const probe = runCommand(
              process.execPath,
              [
                "-e",
                'process.stdout.write(require("node:module").createRequire(process.cwd() + "/packages/consumer/package.json")("capsule-proof-dep"))',
              ],
              {
                cwd: receiver,
                env: dependencyEnv,
                encoding: "utf8",
              },
            );
            expect(probe.error, failureDetail(probe)).toBeUndefined();
            expect(probe.status, failureDetail(probe)).toBe(0);
            preparedGraph = probe.stdout;
          },
        );
        expect(preparedGraph).toBe("graph-a");
        const payload = path.join(imported.receiver, ".capsule-proof/payload");
        if (scenario === "graph") {
          expect(imported.result.status, failureDetail(imported.result)).toBe(0);
          expect(imported.result.stdout).toBe("capsule graph-b\n");
          expect(readFileSync(payload, "utf8")).toBe("graph-b");
          expect(imported.result.stderr).toContain("[crabbox] verified source=");
        } else {
          // Prove the metadata mutation occurred before the intended rejection assertion.
          if (scenario === "lifecycle-staged-extra" || scenario === "lifecycle-base-ref") {
            expect(readFileSync(path.join(imported.receiver, "owner.txt"), "utf8")).toBe(
              selectedOwner,
            );
            const lifecycle = readFileSync(
              path.join(imported.receiver, ".capsule-proof/lifecycle"),
              "utf8",
            );
            if (scenario === "lifecycle-staged-extra") {
              expect(lifecycle).toBe("staged-extra");
              expect(
                readFileSync(path.join(imported.receiver, "lifecycle-extra.mjs"), "utf8"),
              ).toBe("export const lifecycleExtra = true;\n");
              expect(git(imported.receiver, ["diff", "--cached", "--name-only"])).toBe(
                "lifecycle-extra.mjs",
              );
            } else {
              const mutation: {
                before: string;
                head: string;
                after: string;
                indexBefore: string;
                indexAfter: string;
              } = JSON.parse(lifecycle);
              expect(mutation.before).not.toBe(mutation.head);
              expect(mutation.after).toBe(mutation.head);
              expect(git(imported.receiver, ["rev-parse", "refs/remotes/origin/main"])).toBe(
                mutation.head,
              );
              expect(mutation.indexAfter).toBe(mutation.indexBefore);
              expect(git(imported.receiver, ["ls-files", "--others", "--exclude-standard"])).toBe(
                "",
              );
            }
          }
          expect(imported.result.status, failureDetail(imported.result)).toBe(2);
          expect(existsSync(payload)).toBe(false);
          expect(imported.result.stderr).not.toContain("[crabbox] verified source=");
          if (scenario === "frozen") {
            expect(imported.result.stdout + imported.result.stderr).toContain(
              'Cannot install with "frozen-lockfile"',
            );
            expect(imported.result.stdout + imported.result.stderr).toContain(
              'importers["packages/consumer"]',
            );
            expect(imported.result.stderr).toContain(
              "selected-source frozen install failed; payload was not run",
            );
          } else if (scenario === "lifecycle") {
            expect(
              readFileSync(path.join(imported.receiver, ".capsule-proof/lifecycle"), "utf8"),
            ).toBe("ran");
            expect(readFileSync(path.join(imported.receiver, "owner.txt"), "utf8")).toBe(
              "lifecycle source drift\n",
            );
            expect(imported.result.stderr).toContain("source bytes mismatch: owner.txt");
          } else {
            expect(imported.result.stderr).toContain(
              scenario === "lifecycle-staged-extra"
                ? "source index mismatch"
                : "source comparison ref mismatch: refs/remotes/origin/main",
            );
          }
        }
        return;
      }
      const empty = runSender();
      expect(empty.bundle.length).toBeGreaterThan(0);
      const unchangedRun = receive("unchanged", empty.remoteCommand, empty.bundle);
      expect(unchangedRun.result.status, failureDetail(unchangedRun.result)).toBe(0);
      expect(git(unchangedRun.receiver, ["rev-parse", "HEAD^{tree}"])).toBe(
        git(origin, ["rev-parse", "HEAD^{tree}"]),
      );

      if (provider === "aws" && !shallow) {
        const policy = "sync:\n  exclude:\n    - private-canary.txt\n";
        const invocationLog = path.join(root, "policy-invocations.jsonl");
        const runWithPolicy = (config: string) => {
          rmSync(capturedBundle, { force: true });
          writeFileSync(invocationLog, "");
          return runCommand(
            process.execPath,
            [fixtureWrapper, "run", "--provider", provider, "--", "node", sourceCommand],
            {
              cwd: producer,
              env: {
                ...env,
                CRABBOX_CONFIG: config,
                OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
              },
              encoding: "utf8",
              timeout: 10_000,
            },
          );
        };
        const expectPolicyRefusal = (result: ReturnType<typeof runCommand>) => {
          expectRejectedBeforeUpload(result);
          expect(
            readInvocations(invocationLog).filter(
              (args) => args[0] === "run" && args[1] !== "--help",
            ),
          ).toEqual([]);
          expect(readdirSync(path.join(root, "sync"))).toEqual([]);
        };
        // Exercise the real producer before the fake policy owner can omit a
        // file. The fake sync-plan does not interpret CRABBOX_CONFIG exclusions.
        for (const [kind, location] of [
          ["leaf", "external"],
          ["leaf", "internal"],
          ["ancestor", "external"],
          ["ancestor", "internal"],
        ] as const) {
          const target = path.join(
            location === "internal" ? producer : root,
            `${kind}-${location}-target.ignored`,
          );
          const policyAlias = path.join(producer, `${kind}-${location}-policy.ignored`);
          const config = path.join(policyAlias, "config.yaml");
          mkdirSync(target);
          writeFileSync(path.join(target, "config.yaml"), policy);
          if (kind === "leaf") {
            mkdirSync(policyAlias);
            symlinkSync(path.join(target, "config.yaml"), config);
          } else {
            symlinkSync(target, policyAlias, "dir");
          }
          try {
            const rejected = runWithPolicy(config);
            expectPolicyRefusal(rejected);
            expect(rejected.stderr).toContain("repository policy");
            expect(rejected.stderr).toContain(path.relative(producer, config));
            expect(readInvocations(invocationLog).some((args) => args[0] === "sync-plan")).toBe(
              false,
            );
            expect(lstatSync(kind === "leaf" ? config : policyAlias).isSymbolicLink()).toBe(true);
            expect(readFileSync(path.join(target, "config.yaml"), "utf8")).toBe(policy);
          } finally {
            rmSync(policyAlias, { recursive: true, force: true });
            rmSync(target, { recursive: true, force: true });
          }
        }
        const directoryPolicy = path.join(producer, "directory-policy.ignored");
        mkdirSync(directoryPolicy);
        try {
          const rejected = runWithPolicy(directoryPolicy);
          expectPolicyRefusal(rejected);
          expect(rejected.stderr).toContain("non-regular repository policy");
          expect(readInvocations(invocationLog).some((args) => args[0] === "sync-plan")).toBe(
            false,
          );
          expect(lstatSync(directoryPolicy).isDirectory()).toBe(true);
        } finally {
          rmSync(directoryPolicy, { recursive: true });
        }
        const missing = runWithPolicy(path.join(producer, "missing-policy.ignored/config.yaml"));
        expectSuccessfulWrapperRun(missing);
        expect(existsSync(capturedBundle)).toBe(true);
        expect(readInvocations(invocationLog).some((args) => args[0] === "sync-plan")).toBe(true);
        expect(readdirSync(path.join(root, "sync"))).toEqual([]);

        const regularPath = path.join(producer, "fixture-policy.yaml");
        writeFileSync(regularPath, policy);
        try {
          const regular = expectSuccessfulWrapperRun(runWithPolicy(regularPath));
          const retained = receive(
            "regular-policy",
            regular.remoteCommand,
            readFileSync(capturedBundle),
          );
          expect(retained.result.status, failureDetail(retained.result)).toBe(0);
          expect(readFileSync(path.join(retained.receiver, "fixture-policy.yaml"), "utf8")).toBe(
            policy,
          );
          expect(readdirSync(path.join(root, "sync"))).toEqual([]);
        } finally {
          rmSync(regularPath);
        }
        const ignoredPath = path.join(producer, "runtime-policy.ignored");
        writeFileSync(ignoredPath, policy);
        try {
          const excluded = runWithPolicy(ignoredPath);
          expectPolicyRefusal(excluded);
          expect(excluded.stderr).toContain("excluded repository runtime configuration");
          expect(readInvocations(invocationLog).some((args) => args[0] === "sync-plan")).toBe(true);
          expect(readFileSync(ignoredPath, "utf8")).toBe(policy);
        } finally {
          rmSync(ignoredPath);
        }
      }

      writeFileSync(path.join(producer, "owner.txt"), "committed\n");
      git(producer, ["add", "owner.txt"]);
      if (replacedHistory) {
        rmSync(path.join(producer, "removed-kind.ignored"));
        mkdirSync(path.join(producer, "removed-kind.ignored"));
        writeFileSync(
          path.join(producer, "removed-kind.ignored", "owned.txt"),
          "new directory kind\n",
        );
        git(producer, ["add", "-A", "-f", "removed-kind.ignored"]);
      }
      for (const file of [...deletedOwned.slice(0, 2), deletedOwned[3]!, retainedPrivate[0]!]) {
        mkdirSync(path.dirname(path.join(producer, file)), { recursive: true });
        writeFileSync(path.join(producer, file), "branch-owned source\n");
        git(producer, ["add", "-f", file]);
      }
      git(producer, ["commit", "-qm", "committed change"]);
      if (replacedHistory) {
        rmSync(path.join(producer, "removed-kind.ignored"), { recursive: true });
      }
      writeFileSync(path.join(producer, deletedOwned[2]!), "new staged ignored source\n");
      git(producer, ["add", "-f", deletedOwned[2]!]);
      for (const file of [...deletedOwned, retainedPrivate[0]!]) {
        rmSync(path.join(producer, file));
      }
      git(producer, ["add", "-u", "staged-deleted.ignored"]);
      writeFileSync(path.join(producer, "owner.txt"), "unstaged\n");
      writeFileSync(path.join(producer, "untracked.txt"), "untracked\n");
      mkdirSync(path.join(producer, "restored"));
      writeFileSync(path.join(producer, "restored", "old.txt"), restored);
      rmSync(path.join(producer, "deleted.txt"));
      renameSync(path.join(producer, "rename-before.txt"), path.join(producer, "renamed.txt"));
      chmodSync(path.join(producer, "mode.sh"), 0o755);
      writeFileSync(path.join(producer, "tracked.ignored"), "changed tracked ignored\r\n");
      writeFileSync(path.join(producer, "reincluded.ignored"), "changed reincluded\r\n");
      writeFileSync(path.join(producer, "raw-crlf.txt"), "raw bytes\r\nsecond line\r\n");
      writeFileSync(
        path.join(producer, "dirty.bin"),
        Buffer.concat(
          Array.from({ length: 2048 }, (_, index) =>
            createHash("sha256").update(`dirty-${index}`).digest(),
          ),
        ),
      );
      writeFileSync(path.join(producer, "staged.ignored"), "new ignored staged\r\n");
      git(producer, ["add", "-f", "staged.ignored"]);
      const external = path.join(root, "external");
      mkdirSync(external);
      writeFileSync(path.join(external, "canary.txt"), "external referent must stay local\n");
      writeFileSync(path.join(external, "kept.txt"), "shadowed tracked referent must stay local\n");
      rmSync(path.join(producer, "source-dir"), { recursive: true });
      symlinkSync(external, path.join(producer, "source-dir"), "dir");
      rmSync(path.join(producer, "directory-alias"));
      symlinkSync(external, path.join(producer, "directory-alias"), "dir");
      rmSync(path.join(producer, "alias"));
      symlinkSync(Buffer.from([46, 47, 255, 10]), path.join(producer, "alias"));
      const privatePaths = [
        "private-canary.txt",
        "global-canary.txt",
        "info-canary.txt",
        "secret.ignored",
      ];
      writeFileSync(path.join(producer, ".git", "info", "exclude"), "info-canary.txt\n");
      mkdirSync(home, { recursive: true });
      const globalExclude = path.join(home, "git-exclude");
      const localExcludes =
        provider === "aws" && !shallow
          ? "relative"
          : provider === "blacksmith-testbox" && shallow
            ? "empty"
            : "";
      writeFileSync(globalExclude, "global-canary.txt\n" + (localExcludes ? "keep.txt\n" : ""));
      writeFileSync(path.join(home, ".gitconfig"), `[core]\n excludesFile = ${globalExclude}\n`);
      env.GIT_CONFIG_GLOBAL = path.join(home, ".gitconfig");
      if (localExcludes) {
        writeFileSync(path.join(producer, "keep.txt"), "eligible under the local override\n");
        const policy = path.join(root, "local-exclude-policy");
        writeFileSync(policy, "global-canary.txt\n");
        symlinkSync(policy, path.join(producer, "exclusion-policy"));
        writeFileSync(
          path.join(producer, ".git", "info", "exclude"),
          "info-canary.txt\nexclusion-policy\nglobal-canary.txt\n",
        );
        git(producer, [
          "config",
          "--local",
          "core.excludesFile",
          localExcludes === "empty" ? "" : "exclusion-policy",
        ]);
      }
      for (const file of privatePaths) {
        writeFileSync(path.join(producer, file), "private fixture canary\n");
      }
      git(producer, ["add", "mode.sh", "rename-before.txt", "renamed.txt"]);
      const sparse = provider === "blacksmith-testbox";
      if (sparse) {
        git(producer, ["sparse-checkout", "set", "--no-cone", "/*", "!/sparse-only/"]);
        expect(existsSync(path.join(producer, hiddenPath))).toBe(false);
      }
      const headBefore = git(producer, ["rev-parse", "HEAD"]);
      const indexBefore = readFileSync(path.join(producer, ".git", "index"));
      const statusBefore = git(producer, ["status", "--porcelain=v1"]);
      const shallowBefore = shallow
        ? readFileSync(path.join(producer, ".git", "shallow"))
        : undefined;
      const candidate = runSender();
      // A change must not resend the unchanged, incompressible base blob.
      expect(candidate.bundle.length).toBeLessThan(unchanged.length);
      expect(git(producer, ["rev-parse", "HEAD"])).toBe(headBefore);
      expect(readFileSync(path.join(producer, ".git", "index"))).toEqual(indexBefore);
      expect(git(producer, ["status", "--porcelain=v1"])).toBe(statusBefore);
      expect(
        shallow
          ? readFileSync(path.join(producer, ".git", "shallow"))
          : existsSync(path.join(producer, ".git", "shallow")),
      ).toEqual(shallowBefore ?? false);

      const newerFiles = [
        "newer-source.txt",
        "newer-source-link",
        "newer-directory/owned.txt",
        "newer-directory/.gitignore",
        "newer-directory/hidden/.gitignore",
        "newer-directory/hidden/generated.js",
      ];
      const newerCaches = [
        "newer-directory/cache.ignored",
        "newer-directory/changed-cache.ignored",
        "newer-directory/.cache.ignored/.gitignore",
        "newer-directory/.changed-cache.ignored/.gitignore",
        "newer-directory/.untracked-cache.ignored/.gitignore",
      ];
      const prepareNewerReceiver = (receiver: string) => {
        writeFileSync(path.join(receiver, newerFiles[0]!), "newer workflow source\n");
        symlinkSync("newer-source.txt", path.join(receiver, newerFiles[1]!));
        mkdirSync(path.join(receiver, "newer-directory"));
        writeFileSync(path.join(receiver, newerFiles[2]!), "newer nested source\n");
        mkdirSync(path.join(receiver, "newer-directory/hidden"));
        writeFileSync(path.join(receiver, newerFiles[3]!), "hidden/\n!*.ignored\n");
        writeFileSync(path.join(receiver, newerFiles[4]!), "generated.js\n");
        writeFileSync(path.join(receiver, newerFiles[5]!), "newer hidden source\n");
        writeFileSync(path.join(receiver, "newer-private.ignored"), "retained private bytes\n");
        for (const file of newerCaches) {
          mkdirSync(path.dirname(path.join(receiver, file)), { recursive: true });
          writeFileSync(path.join(receiver, file), "retained cache bytes\n");
        }
        git(receiver, [
          "add",
          "-f",
          ...newerFiles,
          ...newerCaches.slice(0, -1),
          "newer-private.ignored",
        ]);
        git(receiver, ["commit", "-qm", "newer workflow source"]);
        // A stale execution index cannot erase ownership recorded by its commit.
        git(receiver, ["update-index", "--force-remove", ...newerFiles]);
        writeFileSync(path.join(receiver, "newer-private.ignored"), "changed private bytes\n");
        writeFileSync(path.join(receiver, newerCaches[1]!), "changed cache bytes\n");
        writeFileSync(path.join(receiver, newerCaches[3]!), "changed cache bytes\n");
      };
      const imported = receive(
        "candidate",
        candidate.remoteCommand,
        candidate.bundle,
        origin,
        {
          GIT_DIR: path.join(root, "unrelated-git"),
          GIT_WORK_TREE: root,
          GIT_INDEX_FILE: path.join(root, "unrelated-index"),
          GIT_COMMON_DIR: path.join(root, "unrelated-common"),
          GIT_OBJECT_DIRECTORY: path.join(root, "unrelated-objects"),
          GIT_ALTERNATE_OBJECT_DIRECTORIES: path.join(root, "unrelated-alternates"),
        },
        true,
        [],
        provider === "blacksmith-testbox" ? prepareNewerReceiver : undefined,
      );
      expect(imported.result.status, failureDetail(imported.result)).toBe(0);
      expect(imported.result.stdout).toBe("transport fixture reached\n");
      expect(existsSync(path.join(imported.receiver, "injected"))).toBe(false);
      if (provider === "blacksmith-testbox") {
        for (const file of newerFiles) {
          expect(() => lstatSync(path.join(imported.receiver, file))).toThrow();
        }
        for (const [index, file] of newerCaches.entries()) {
          expect(readFileSync(path.join(imported.receiver, file), "utf8")).toBe(
            index === 1 || index === 3 ? "changed cache bytes\n" : "retained cache bytes\n",
          );
        }
        expect(readFileSync(path.join(imported.receiver, "newer-private.ignored"), "utf8")).toBe(
          "changed private bytes\n",
        );
      }
      expect(git(imported.receiver, ["rev-parse", "HEAD^"])).toBe(base);
      expect(git(imported.receiver, ["rev-list", "--count", "HEAD"])).toBe("3");
      if (alias) {
        expect(git(imported.receiver, ["rev-parse", alias])).toBe(base);
      }
      expect(readFileSync(path.join(imported.receiver, hiddenPath))).toEqual(hiddenBytes);
      expect(imported.result.stderr).toContain(headBefore);
      expect(git(imported.receiver, ["rev-parse", "HEAD"])).not.toBe(headBefore);
      expect(readFileSync(path.join(imported.receiver, "unchanged.bin"))).toEqual(unchanged);
      expect(readFileSync(path.join(imported.receiver, "owner.txt"), "utf8")).toBe("unstaged\n");
      expect(readFileSync(path.join(imported.receiver, "untracked.txt"), "utf8")).toBe(
        "untracked\n",
      );
      expect(existsSync(path.join(imported.receiver, "deleted.txt"))).toBe(false);
      expect(existsSync(path.join(imported.receiver, "rename-before.txt"))).toBe(false);
      for (const file of deletedOwned) {
        expect(existsSync(path.join(imported.receiver, file)), file).toBe(false);
      }
      if (replacedHistory) {
        expect(existsSync(path.join(imported.receiver, "removed-kind.ignored"))).toBe(false);
      }
      for (const file of retainedPrivate) {
        expect(readFileSync(path.join(imported.receiver, file), "utf8")).toBe(
          "stale ignored bytes\n",
        );
      }
      expect(
        readFileSync(path.join(imported.receiver, "deleted-dir.ignored", "runtime.txt"), "utf8"),
      ).toBe("private runtime\n");
      expect(readFileSync(path.join(deletionReferent, "canary.txt"), "utf8")).toBe(
        "private referent\n",
      );
      if (localExcludes) {
        expect(readFileSync(path.join(imported.receiver, "keep.txt"), "utf8")).toBe(
          "eligible under the local override\n",
        );
        expect(existsSync(path.join(imported.receiver, "exclusion-policy"))).toBe(false);
      }
      expect(readFileSync(path.join(imported.receiver, "renamed.txt"), "utf8")).toBe("base\n");
      expect(readFileSync(path.join(imported.receiver, "restored", "old.txt"), "utf8")).toBe(
        restored,
      );
      expect(git(imported.receiver, ["ls-tree", "HEAD", "alias"])).toMatch(/^120000 blob /u);
      expect(git(imported.receiver, ["ls-tree", "HEAD", "mode.sh"])).toMatch(/^100755 blob /u);
      const selected = git(producer, [
        "ls-files",
        "--cached",
        "--others",
        "--exclude-standard",
        "-z",
      ])
        .split("\0")
        .filter((file) => file && !privatePaths.includes(file) && file !== "source-dir/kept.txt")
        .filter((file) => {
          try {
            return !lstatSync(path.join(producer, file)).isDirectory();
          } catch {
            return false;
          }
        });
      const sourceManifest = (directory: string, files: string[]) =>
        [...new Set(files)].toSorted().map((file): [string, string, string] => {
          const fullPath = path.join(directory, file);
          const stat = lstatSync(fullPath);
          const symlink = stat.isSymbolicLink();
          return [
            file,
            symlink ? "120000" : stat.mode & 0o100 ? "100755" : "100644",
            createHash("sha256")
              .update(
                symlink ? readlinkSync(fullPath, { encoding: "buffer" }) : readFileSync(fullPath),
              )
              .digest("hex"),
          ];
        });
      const remotePaths = git(imported.receiver, ["ls-files", "-z"]).split("\0").filter(Boolean);
      const expectedManifest = sourceManifest(producer, selected);
      if (sparse) {
        expectedManifest.push(...sourceManifest(origin, [hiddenPath]));
      }
      expectedManifest.sort((left, right) => left[0].localeCompare(right[0]));
      expect(
        sourceManifest(imported.receiver, remotePaths).toSorted((left, right) =>
          left[0].localeCompare(right[0]),
        ),
      ).toEqual(expectedManifest);
      expect(git(imported.receiver, ["ls-files", "--others", "--exclude-standard"])).toBe("");
      for (const file of privatePaths) {
        expect(existsSync(path.join(imported.receiver, file)), file).toBe(false);
      }
      expect(
        readlinkSync(path.join(imported.receiver, "directory-alias"), { encoding: "buffer" }),
      ).toEqual(Buffer.from(external));
      expect(readFileSync(path.join(external, "canary.txt"), "utf8")).toBe(
        "external referent must stay local\n",
      );
      expect(readFileSync(path.join(external, "kept.txt"), "utf8")).toBe(
        "shadowed tracked referent must stay local\n",
      );
      expect(git(imported.receiver, ["ls-tree", "HEAD", "source-dir"])).toMatch(/^120000 blob /u);
      expect(
        git(imported.receiver, ["diff", "--no-renames", "--name-only", base, "HEAD"]).split("\n"),
      ).toEqual(
        expect.arrayContaining([
          "raw-crlf.txt",
          "tracked.ignored",
          "reincluded.ignored",
          "staged.ignored",
          "deleted.txt",
          "mode.sh",
          "alias",
          "directory-alias",
        ]),
      );

      if (provider === "aws" && !shallow) {
        // AWS supports uploaded SSH scripts; Blacksmith supports commands only.
        for (const { name, mode, flags } of [
          { name: "file", mode: "script", flags: ["--script", scriptInput] },
          { name: "stdin", mode: "stdin", flags: ["--script-stdin"] },
          { name: "stdin-empty-file-after", mode: "stdin", flags: ["--script-stdin", "--script="] },
          {
            name: "empty-file-before-stdin",
            mode: "stdin",
            flags: ["--script=", "--script-stdin"],
          },
          {
            name: "repeated-stdin",
            mode: "stdin",
            flags: ["--script-stdin", "--script-stdin=true"],
          },
          {
            name: "file-disabled-stdin",
            mode: "script",
            flags: ["--script-stdin", "--script-stdin=false", "--script", scriptInput],
          },
        ] as const) {
          const script = runSender(mode, [
            "run",
            "--provider",
            provider,
            ...flags,
            "--",
            ...sourceArgv,
          ]);
          expect(script.sourceFlags).toEqual(["--script"]);
          const argvPath = path.join(root, `${name}-argv.json`);
          const accepted = receive(
            `${name}-candidate`,
            script.remoteCommand,
            script.bundle,
            origin,
            { TRANSPORT_FIXTURE_ARGV: argvPath },
            true,
            script.remoteArgs,
          );
          expect(accepted.result.status, failureDetail(accepted.result)).toBe(0);
          expect(accepted.result.stdout).toBe("transport fixture reached\n");
          expect(JSON.parse(readFileSync(argvPath, "utf8"))).toEqual(sourceArgs);
          expect(existsSync(path.join(accepted.receiver, "injected"))).toBe(false);
          expect(
            sourceManifest(accepted.receiver, remotePaths).toSorted((left, right) =>
              left[0].localeCompare(right[0]),
            ),
          ).toEqual(expectedManifest);
          rmSync(argvPath);
          const rejected = receive(
            `${name}-missing-capsule`,
            script.remoteCommand,
            undefined,
            origin,
            { TRANSPORT_FIXTURE_ARGV: argvPath },
            false,
            script.remoteArgs,
          );
          expect(rejected.result.status, failureDetail(rejected.result)).toBe(2);
          expect(rejected.result.stdout).toBe("");
          expect(existsSync(argvPath)).toBe(false);
          expect(existsSync(path.join(rejected.receiver, ".git"))).toBe(false);
        }
      }
      // Shared receiver failure paths need one full real-Git fixture; provider/history
      // variants above retain independent successful source identity checks.
      if (provider === "blacksmith-testbox" && !shallow) {
        for (const [fault, file, message] of [
          ["bytes", "newer-source.txt", "source bytes mismatch"],
          ["mode", "newer-source.txt", "source mode mismatch"],
          ["kind", "newer-source.txt", "source mode mismatch"],
          ["link", "newer-source-link", "source bytes mismatch"],
          ["parent", "newer-directory", "unexpected source entry"],
          ["untracked", "unowned.txt", "unexpected source entry"],
          ["index", "unowned.txt", "unexpected source entry"],
          ["hidden-untracked", "newer-directory/hidden/unknown.js", "unexpected source entry"],
          ["hidden-bytes", "newer-directory/hidden/generated.js", "source bytes mismatch"],
        ] as const) {
          let retained: ReturnType<typeof sourceManifest> = [];
          let priorHead = "";
          const rejected = receive(
            `newer-${fault}`,
            candidate.remoteCommand,
            candidate.bundle,
            origin,
            {},
            true,
            [],
            (receiver) => {
              prepareNewerReceiver(receiver);
              priorHead = git(receiver, ["rev-parse", "HEAD"]);
              const fullPath = path.join(receiver, file);
              if (fault === "mode") {
                chmodSync(fullPath, 0o755);
              } else if (fault === "kind" || fault === "link" || fault === "parent") {
                rmSync(fullPath, { recursive: true });
                symlinkSync(
                  fault === "parent" ? deletionReferent : path.join(deletionReferent, "canary.txt"),
                  fullPath,
                );
              } else {
                writeFileSync(fullPath, "retained changed bytes\n");
              }
              if (fault === "index") {
                git(receiver, ["add", file]);
              }
              retained = sourceManifest(receiver, [file]);
            },
          );
          expect(rejected.result.status, failureDetail(rejected.result)).toBe(2);
          expect(rejected.result.stderr, fault).toContain(message);
          expect(rejected.result.stdout, fault).not.toContain("transport fixture reached");
          expect(
            sourceManifest(
              rejected.receiver,
              retained.map(([retainedFile]) => retainedFile),
            ),
            fault,
          ).toEqual(retained);
          expect(git(rejected.receiver, ["rev-parse", "HEAD"]), fault).toBe(priorHead);
          expect(readFileSync(path.join(deletionReferent, "canary.txt"), "utf8")).toBe(
            "private referent\n",
          );
        }
        const corrupt = Buffer.from(candidate.bundle);
        const lastIndex = corrupt.length - 1;
        corrupt.writeUInt8(corrupt.readUInt8(lastIndex) ^ 1, lastIndex);
        const wrongBase = git(imported.receiver, [
          "commit-tree",
          `${base}^{tree}`,
          "-m",
          "other base",
        ]);
        const wrongCarrier = git(imported.receiver, [
          "commit-tree",
          "HEAD^{tree}",
          "-p",
          wrongBase,
          "-m",
          "other prerequisite",
        ]);
        git(imported.receiver, ["update-ref", "HEAD", wrongCarrier]);
        const emptyTree = git(imported.receiver, ["hash-object", "-w", "-t", "tree", "--stdin"]);
        const emptyCarrier = git(imported.receiver, [
          "commit-tree",
          emptyTree,
          "-p",
          base,
          "-m",
          "empty source fixture",
        ]);
        git(imported.receiver, ["update-ref", "refs/openclaw/source-capsule", emptyCarrier]);
        const emptyTreeBundle = path.join(root, "empty-tree.bundle");
        git(imported.receiver, [
          "bundle",
          "create",
          emptyTreeBundle,
          "refs/openclaw/source-capsule",
          `^${base}`,
        ]);
        const wrongBundle = path.join(root, "wrong-base.bundle");
        git(imported.receiver, ["bundle", "create", wrongBundle, "HEAD", `^${wrongBase}`]);
        for (const [name, bundle] of [
          ["missing-bundle", undefined],
          ["empty-bundle", Buffer.alloc(0)],
          ["valid-empty-tree-bundle", readFileSync(emptyTreeBundle)],
          ["stale-valid-bundle", empty.bundle],
          ["truncated-bundle", candidate.bundle.subarray(0, candidate.bundle.length / 2)],
          ["wrong-base-bundle", readFileSync(wrongBundle)],
          ["corrupt-bundle", corrupt],
        ] as const) {
          const rejected = receive(name, candidate.remoteCommand, bundle, origin, {}, false);
          expect(rejected.result.status, failureDetail(rejected.result)).toBe(2);
          expect(rejected.result.stdout).not.toContain("transport fixture reached");
          expect(existsSync(path.join(rejected.receiver, ".git"))).toBe(false);
        }
        const shell = runSender("shell");
        const acceptedShell = receive("shell-candidate", shell.remoteCommand, shell.bundle);
        expect(acceptedShell.result.status, failureDetail(acceptedShell.result)).toBe(0);
        expect(acceptedShell.result.stdout).toBe("transport fixture reached\n");
        expect(existsSync(path.join(acceptedShell.receiver, "injected"))).toBe(false);
        const rejectedShell = receive(
          "shell-missing-capsule",
          shell.remoteCommand,
          undefined,
          origin,
          {},
          false,
        );
        expect(rejectedShell.result.status, failureDetail(rejectedShell.result)).toBe(2);
        expect(rejectedShell.result.stdout).toBe("");
        expect(existsSync(path.join(rejectedShell.receiver, ".git"))).toBe(false);
        for (const extraEnv of [
          { OPENCLAW_FAKE_CRABBOX_SELECTION_COUNT_DELTA: "1" },
          { OPENCLAW_FAKE_CRABBOX_SELECTION_UNKNOWN_PATH: "1" },
          {
            OPENCLAW_FAKE_CRABBOX_PRIVACY_PATHS: JSON.stringify([
              "private-canary.txt",
              "tracked.ignored",
            ]),
          },
        ]) {
          rmSync(capturedBundle, { force: true });
          const rejected = runCommand(
            process.execPath,
            [fixtureWrapper, "run", "--provider", provider, "--", "node", sourceCommand],
            { cwd: producer, env: { ...env, ...extraEnv }, encoding: "utf8", timeout: 10_000 },
          );
          expectRejectedBeforeUpload(rejected);
        }
        for (const mutation of ["mode", "bytes", "deletion"]) {
          const preload = path.join(root, `mutate-${mutation}.cjs`);
          writeFileSync(
            preload,
            `const fs = require("node:fs"); const chmod = fs.chmodSync; fs.chmodSync = (file, mode) => { chmod(file, mode); if (file === "mode.sh") { ${mutation === "mode" ? "chmod(file, mode & ~0o100)" : mutation === "deletion" ? 'fs.writeFileSync("committed-deleted.ignored", "stale restored source")' : 'fs.appendFileSync(file, "corrupted after materialization")'}; } };`,
          );
          const rejected = receive(
            `receiver-${mutation}-mismatch`,
            candidate.remoteCommand,
            candidate.bundle,
            origin,
            { NODE_OPTIONS: `--require=${preload}` },
          );
          expect(rejected.result.status, failureDetail(rejected.result)).toBe(2);
          expect(rejected.result.stderr).toContain(`source ${mutation} mismatch`);
          expect(rejected.result.stdout).not.toContain("transport fixture reached");
          expect(git(rejected.receiver, ["rev-parse", "HEAD"])).toBe(base);
        }
        const reserved = path.join(producer, ".openclaw-crabbox-changed-gate.bundle");
        const victim = path.join(external, "canary.txt");
        symlinkSync(victim, reserved);
        rmSync(capturedBundle, { force: true });
        const reservedRejection = runCommand(
          process.execPath,
          [fixtureWrapper, "run", "--provider", provider, "--", "node", sourceCommand],
          { cwd: producer, env, encoding: "utf8", timeout: 10_000 },
        );
        expectRejectedBeforeUpload(reservedRejection);
        expect(readFileSync(victim, "utf8")).toBe("external referent must stay local\n");
        rmSync(reserved);
        const emptyOrigin = path.join(root, "empty-origin");
        mkdirSync(emptyOrigin);
        git(emptyOrigin, ["init", "-q", "--bare"]);
        const missingBase = receive(
          "missing-base",
          candidate.remoteCommand,
          candidate.bundle,
          emptyOrigin,
        );
        expect(missingBase.result.status, failureDetail(missingBase.result)).toBe(2);
        expect(missingBase.result.stdout).not.toContain("transport fixture reached");
        const blob = git(producer, ["rev-parse", "HEAD:mode.sh"]);
        const invalidPathEntry = Buffer.concat([
          Buffer.from(`100644 ${blob}\tinvalid-`),
          Buffer.from([255]),
          Buffer.from(".txt\0"),
        ]);
        const indexed = runCommand("git", ["update-index", "-z", "--index-info"], {
          cwd: producer,
          env,
          encoding: "utf8",
          input: invalidPathEntry,
          timeout: 10_000,
        });
        expect(indexed.status, failureDetail(indexed)).toBe(0);
        rmSync(capturedBundle, { force: true });
        const invalidPathRejection = runCommand(
          process.execPath,
          [fixtureWrapper, "run", "--provider", provider, "--", "node", sourceCommand],
          { cwd: producer, env, encoding: "utf8", timeout: 10_000 },
        );
        expectRejectedBeforeUpload(invalidPathRejection);
      }
    },
  );

  it.runIf(process.platform === "win32")(
    "selects a real source capsule through a Crabbox .cmd shim",
    () => {
      const root = invocationLogTempDirs.make("openclaw-capsule-cmd-");
      const producer = path.join(root, "producer");
      const capturedBundle = path.join(root, "captured.bundle");
      const invocationLog = path.join(root, "invocations.jsonl");
      const fakeBin = makeFakeCrabbox(defaultProviderHelp);
      expect(existsSync(path.join(fakeBin, "crabbox.cmd"))).toBe(true);
      const emptyGitConfig = path.join(root, "empty.gitconfig");
      writeFileSync(emptyGitConfig, "");
      const env = {
        ...testHomeEnv(path.join(root, "home")),
        SystemRoot: process.env.SystemRoot,
        ComSpec: process.env.ComSpec,
        PATH: [fakeBin, path.dirname(process.execPath), process.env.PATH ?? ""].join(
          path.delimiter,
        ),
        GIT_CONFIG_GLOBAL: emptyGitConfig,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Transport fixture",
        GIT_AUTHOR_EMAIL: "transport@example.invalid",
        GIT_COMMITTER_NAME: "Transport fixture",
        GIT_COMMITTER_EMAIL: "transport@example.invalid",
        OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
        OPENCLAW_CRABBOX_SYNC_TMPDIR: path.join(root, "sync"),
        OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "0",
        OPENCLAW_FAKE_CRABBOX_COPY_CHANGED_GATE_BUNDLE_TO: capturedBundle,
        OPENCLAW_FAKE_CRABBOX_INVOCATION_LOG: invocationLog,
      };
      mkdirSync(producer);
      const git = (args: string[]) => {
        const result = spawnSync("git", args, {
          cwd: producer,
          env,
          encoding: "utf8",
          timeout: 10_000,
        });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git(["init", "-q", "-b", "main"]);
      git(["remote", "add", "origin", producer]);
      writeFileSync(path.join(producer, ".gitignore"), ".tmp/\n");
      writeFileSync(
        path.join(producer, "package.json"),
        JSON.stringify({ packageManager: "pnpm@12.0.0" }),
      );
      git(["add", "-A"]);
      git(["commit", "-qm", "base"]);
      git(["update-ref", "refs/remotes/origin/main", git(["rev-parse", "HEAD"])]);
      const wrapper = path.join(producer, ".tmp", "crabbox-wrapper.mjs");
      mkdirSync(path.dirname(wrapper));
      copyFileSync(realBundledWrapperPath, wrapper);
      const result = spawnSync(
        process.execPath,
        [wrapper, "run", "--provider", "aws", "--target", "linux", "--", "pnpm", "check:changed"],
        { cwd: producer, env, encoding: "utf8", timeout: 10_000 },
      );
      const run = expectSuccessfulWrapperRun(result);
      expect(readInvocations(invocationLog)).toContainEqual([
        "sync-plan",
        "--json",
        "--limit",
        "2147483647",
      ]);
      expect(readFileSync(capturedBundle).length).toBeGreaterThan(0);
      expect(git(["bundle", "list-heads", capturedBundle])).toMatch(
        / refs\/openclaw\/source-capsule$/u,
      );
      expect(existsSync(run.output.cwd)).toBe(false);
      expect(readdirSync(path.join(root, "sync"))).toEqual([]);
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
    expect(result.stderr).toContain("overlaying the local worktree as changes from abc123");
    expect(output.cwd).toContain("openclaw-crabbox-sync-");
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("node -e");
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand).toMatch(
      /; env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
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
      /; env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 corepack pnpm check:changed$/u,
    );
  });

  it("preserves macOS JS bootstrapping for sparse changed gates on remote raw syncs", () => {
    const { output, remoteCommand } = runSuccessfulMacosCommand(
      ["pnpm", "check:changed"],
      sparseChangedGateOptions,
    );
    expect(output.args.filter((arg) => arg === "--shell")).toHaveLength(1);
    expect(remoteCommand).toContain(remoteChangedGateFetch);
    expect(remoteCommand.indexOf("node --version >&2 || return 1")).toBeLessThan(
      remoteCommand.indexOf("node -e"),
    );
    expect(remoteCommand.indexOf("corepack enable --install-directory")).toBeLessThan(
      remoteCommand.indexOf("node -e"),
    );
    expect(remoteCommand.indexOf("node -e")).toBeLessThan(
      remoteCommand.indexOf("pnpm --version >&2"),
    );
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
    expect(remoteCommand).toContain("node -e");
    expectMacosJsBootstrap(remoteCommand, `${remoteChangedGateExport} ${shellScript}`);
  });

  it("preserves macOS JS and Git bootstraps for shell-wrapped sparse changed gates", () => {
    const shellScript = "bash -lc 'pnpm check:changed'";
    const { remoteCommand } = runSuccessfulMacosShell(shellScript, sparseChangedGateOptions);
    expect(remoteCommand).toContain("node -e");
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

    expect(remoteCommand).toContain("node -e");
    if (expectFetch) {
      expect(remoteCommand).toContain(remoteChangedGateFetch);
    }
    expect(remoteCommand).toContain(`; ${remoteChangedGateExport} ${shellScript}`);
  });

  it.each([
    {
      target: "node",
      command: [
        "timeout",
        "1200s",
        "node",
        "scripts/check-changed.mjs",
        "--base",
        "origin/main",
        "--head",
        "HEAD",
      ],
      suffix:
        /; env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s node scripts\/check-changed\.mjs --base origin\/main --head HEAD$/u,
    },
    {
      target: "shell",
      command: ["timeout", "1200s", "bash", "-lc", "pnpm check:changed"],
      suffix:
        /; env OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 timeout 1200s bash -lc 'pnpm check:changed'$/u,
    },
    {
      target: "env -i",
      command: ["env", "-i", "pnpm", "check:changed"],
      suffix:
        /; env -i OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 pnpm check:changed$/u,
    },
    {
      target: "absolute env -i",
      command: ["/usr/bin/env", "-i", "pnpm", "check:changed"],
      suffix:
        /; \/usr\/bin\/env -i OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1 pnpm check:changed$/u,
    },
  ])("preserves direct $target changed gates after Git bootstrap", ({ command, suffix }) => {
    const { output, remoteCommand } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "aws", "--", ...command],
      sparseChangedGateOptions,
    );
    expect(output.args).toContain("--shell");
    expect(remoteCommand).toContain("node -e");
    expect(remoteCommand).toMatch(suffix);
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
    expect(renderedCommand).not.toContain("node -e");
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

    expect(remoteCommand).not.toContain("node -e");
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
      /; export OPENCLAW_CHECK_CHANGED_REMOTE_CHILD=1 OPENCLAW_CHANGED_LANES_RAW_SYNC=1 CI=1; env CI=1 pnpm check:changed$/u,
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

  it.each([
    {
      root: ".crabbox-test-invalid-disk-sync-root",
      key: "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES",
      value: "1024mb",
      error:
        'OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a non-negative integer byte count, got "1024mb"',
    },
    {
      root: ".crabbox-test-unsafe-disk-sync-root",
      key: "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES",
      value: String(Number.MAX_SAFE_INTEGER + 1),
      error: "OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES must be a safe non-negative integer byte count",
    },
    {
      root: ".crabbox-test-invalid-keepalive-sync-root",
      key: "OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS",
      value: "10ms",
      error:
        'OPENCLAW_CRABBOX_SYNC_KEEPALIVE_MS must be a non-negative integer millisecond interval, got "10ms"',
    },
  ])("rejects invalid sparse-sync limits: $key=$value", ({ root, key, value, error }) => {
    withSparseSyncRoot(root, { [key]: value }, ({ result, syncRoot }) => {
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(error);
      expect(readdirSync(syncRoot)).toEqual([]);
    });
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

  it("freezes ordinary Blacksmith source even when the worktree is dirty", () => {
    const { output, result } = runSuccessfulDefaultWrapper(
      ["run", "--provider", "blacksmith-testbox", "--blacksmith-ref", "main", "--", "echo ok"],
      {
        gitResponses: {
          [GIT_CONFIG_SPARSE_KEY]: { stdout: "true\n" },
          [GIT_STATUS_PORCELAIN_KEY]: { stdout: " M scripts/crabbox-wrapper.mjs\n" },
        },
      },
    );

    expect(result.stderr).toContain("syncing from temporary full checkout");
    expect(output.cwd).not.toBe(repoRoot);
    expectChangedGateGitBootstrap(output.args.at(-1) ?? "");
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

  it.each([
    { mode: "capsule", artifacts: "captures", exitCode: 23, fault: undefined },
    { mode: "capsule", artifacts: "both", exitCode: 23, fault: undefined },
    { mode: "sparse", artifacts: "both", exitCode: 23, fault: undefined },
    { mode: "capsule", artifacts: "runs", exitCode: 0, fault: undefined },
    { mode: "capsule", artifacts: "none", exitCode: 0, fault: undefined },
    { mode: "direct", artifacts: "captures", exitCode: 23, fault: undefined },
    ...[0, 23].map((exitCode) => ({
      mode: "capsule",
      artifacts: "both",
      exitCode,
      fault: "destination file",
    })),
    ...(process.platform === "win32"
      ? []
      : [
          "source root link",
          "source root dangling link",
          "source runs link",
          "source captures link",
          "source captures dangling link",
          "nested file link",
          "nested directory link",
          "nested internal link",
          "nested dangling link",
          "destination root link",
          "destination root dangling link",
          "destination parent link",
          "destination parent dangling link",
          "nested fifo",
        ]
    ).map((fault) => ({ mode: "capsule", artifacts: "both", exitCode: 0, fault })),
  ])(
    "retains native artifacts through the wrapper ($mode, $artifacts, exit=$exitCode, fault=$fault)",
    ({ mode, artifacts, exitCode, fault }) => {
      const root = realpathSync(artifactTempDirs.make("openclaw-wrapper-artifacts-"));
      const producer = path.join(root, "repo");
      const syncRoot = path.join(root, "sync");
      const fixtureWrapper = path.join(producer, ".tmp", "crabbox-wrapper.mjs");
      mkdirSync(path.dirname(fixtureWrapper), { recursive: true });
      copyFileSync(realBundledWrapperPath, fixtureWrapper);
      const env = {
        ...testHomeEnv(path.join(root, "home")),
        XDG_STATE_HOME: path.join(root, "home", ".local", "state"),
        ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}),
        PATH: [makeFakeCrabbox(defaultProviderHelp), process.env.PATH ?? ""].join(path.delimiter),
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_AUTHOR_NAME: "Artifact fixture",
        GIT_AUTHOR_EMAIL: "fixture@example.invalid",
        GIT_COMMITTER_NAME: "Artifact fixture",
        GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        CRABBOX_PROVIDER: "",
        CRABBOX_TARGET: "",
        CRABBOX_TARGET_OS: "",
        CRABBOX_WINDOWS_MODE: "",
        OPENCLAW_CRABBOX_WRAPPER_IGNORE_REPO_BINARY: "1",
        OPENCLAW_CRABBOX_SYNC_TMPDIR: syncRoot,
        OPENCLAW_CRABBOX_SYNC_MIN_FREE_BYTES: "0",
        OPENCLAW_FAKE_CRABBOX_RUN_STATUS: String(exitCode),
      };
      const git = (...args: string[]) => {
        const result = spawnSync("git", args, { cwd: producer, env, encoding: "utf8" });
        expect(result.status, result.stderr).toBe(0);
        return result.stdout.trim();
      };
      git("init", "-q", "-b", "main");
      writeFileSync(path.join(producer, ".gitignore"), ".tmp/\n.crabbox\n");
      writeFileSync(path.join(producer, "fixture.txt"), "source fixture\n");
      git("add", ".gitignore", "fixture.txt");
      git("commit", "-qm", "fixture");
      git("remote", "add", "origin", producer);
      git("update-ref", "refs/remotes/origin/main", "HEAD");
      if (mode === "sparse") {
        git("sparse-checkout", "set", "--no-cone", "/fixture.txt");
      }
      const capturePath = ".crabbox/captures/tbx_fixture-20260904T190427Z.tar.gz";
      const runPath = ".crabbox/runs/run_fixture/proof/nested.json";
      const bundleInput = path.join(root, "bundle-input");
      mkdirSync(bundleInput);
      const logBytes = Buffer.from("synthetic failure\r\n\u001b[31mraw diagnostic\u001b[0m\n");
      writeFileSync(path.join(bundleInput, "stdout.log"), logBytes);
      const bundle = path.join(root, "failure.tar.gz");
      const packed = spawnSync("tar", ["-czf", bundle, "-C", bundleInput, "stdout.log"], { env });
      expect(packed.status).toBe(0);
      const bytes = readFileSync(bundle);
      const files = [
        ...(artifacts === "captures" || artifacts === "both" ? [capturePath] : []),
        ...(artifacts === "runs" || artifacts === "both" ? [runPath] : []),
      ];
      const previousFile = path.join(
        producer,
        mode === "direct" ? ".crabbox/captures/older.tgz" : capturePath,
      );
      mkdirSync(path.dirname(previousFile), { recursive: true });
      writeFileSync(previousFile, "prior evidence\n");
      const retainedRoot = path.join(producer, ".crabbox", "wrapper-artifacts");
      const outside = path.join(root, "outside");
      mkdirSync(outside);
      const sentinel = "synthetic-private-data-must-not-be-printed";
      const sentinelPath = path.join(outside, "private.txt");
      writeFileSync(sentinelPath, sentinel);
      const artifactLinks: Record<string, string> = {};
      const missing = path.join(root, "missing");
      if (fault === "destination file") {
        writeFileSync(retainedRoot, "not a directory\n");
      } else if (fault?.startsWith("destination")) {
        const target = fault.includes("dangling") ? missing : outside;
        if (fault.includes("root")) {
          renameSync(path.join(producer, ".crabbox"), path.join(root, "prior-crabbox"));
          symlinkSync(target, path.join(producer, ".crabbox"), "dir");
        } else {
          symlinkSync(target, retainedRoot, "dir");
        }
      } else if (fault?.startsWith("source")) {
        const file = fault.includes("root")
          ? ".crabbox"
          : fault.includes("runs")
            ? ".crabbox/runs"
            : ".crabbox/captures";
        artifactLinks[file] = fault.includes("dangling") ? missing : outside;
      } else if (fault?.startsWith("nested") && fault !== "nested fifo") {
        const target = fault.includes("dangling")
          ? missing
          : fault.includes("internal")
            ? path.basename(capturePath)
            : fault.includes("directory")
              ? outside
              : sentinelPath;
        artifactLinks[".crabbox/captures/linked-artifact"] = target;
      }
      const retainedDirectories: string[] = [];
      const attempts = mode === "capsule" && artifacts === "both" && !fault ? 2 : 1;
      const emittedFiles = fault?.startsWith("source") && fault.includes("dangling") ? [] : files;
      const ignoredFiles = [".crabbox/credentials/token", ".crabbox/state/claim", ".crabbox/env"];
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const result = spawnSync(
          process.execPath,
          [
            fixtureWrapper,
            "run",
            "--provider",
            mode === "capsule" ? "blacksmith-testbox" : "local-container",
            "--",
            "false",
          ],
          {
            cwd: producer,
            env: {
              ...env,
              OPENCLAW_FAKE_CRABBOX_ARTIFACT_LINKS: JSON.stringify(artifactLinks),
              ...(fault === "nested fifo"
                ? { OPENCLAW_FAKE_CRABBOX_ARTIFACT_FIFO: ".crabbox/captures/pipe" }
                : {}),
              OPENCLAW_FAKE_CRABBOX_ARTIFACTS: JSON.stringify(
                Object.fromEntries([
                  ...emittedFiles.map((file) => [file, bytes.toString("base64")]),
                  ...(fault?.includes("dangling") && fault.startsWith("source")
                    ? []
                    : ignoredFiles.map((file) => [file, Buffer.from(sentinel).toString("base64")])),
                ]),
              ),
            },
            encoding: "utf8",
            timeout: 10_000,
          },
        );
        expect(result.error, result.stderr).toBeUndefined();
        expect(result.stdout, result.stderr).not.toBe("");
        const output = parseFakeCrabboxOutput(result);
        const previousPath = fault?.startsWith("destination root")
          ? path.join(root, "prior-crabbox", path.relative(".crabbox", capturePath))
          : previousFile;
        expect(readFileSync(previousPath, "utf8")).toBe("prior evidence\n");
        expect(readFileSync(sentinelPath, "utf8")).toBe(sentinel);
        expect(result.stdout + result.stderr).not.toContain(sentinel);
        if (fault) {
          expect(result.status, result.stderr).toBe(exitCode || 1);
          expect(result.stderr).toContain("temporary checkout retained");
          expect(result.stderr).toContain(output.cwd);
          expect(result.stderr).not.toContain("preserved temporary artifacts:");
          expect(existsSync(output.cwd)).toBe(true);
          for (const file of emittedFiles) {
            expect(readFileSync(path.join(output.cwd, file))).toEqual(bytes);
          }
          if (fault === "destination file") {
            expect(readFileSync(retainedRoot, "utf8")).toBe("not a directory\n");
          } else if (fault.startsWith("destination")) {
            expect(readdirSync(outside)).toEqual(["private.txt"]);
            expect(existsSync(missing)).toBe(false);
          } else {
            expect(existsSync(retainedRoot) ? readdirSync(retainedRoot) : []).toEqual([]);
          }
          continue;
        }
        expect(result.status, result.stderr).toBe(exitCode);
        if (mode === "direct") {
          expect(output.cwd).toBe(producer);
          expect(existsSync(retainedRoot)).toBe(false);
          for (const file of files) {
            expect(readFileSync(path.join(producer, file))).toEqual(bytes);
          }
        } else {
          expect(output.cwd).not.toBe(producer);
          expect(existsSync(output.cwd)).toBe(false);
          expect(readdirSync(syncRoot)).toEqual([]);
          if (files.length === 0) {
            expect(existsSync(retainedRoot)).toBe(false);
          } else {
            const relocated = result.stderr.match(/preserved temporary artifacts: (.+) -> (.+)/u);
            expect(relocated?.[1]).toBe(path.join(output.cwd, ".crabbox"));
            const retained = path.resolve(producer, relocated![2]!);
            expect(retainedDirectories).not.toContain(retained);
            retainedDirectories.push(retained);
            for (const directory of retainedDirectories) {
              if (process.platform !== "win32") {
                expect(lstatSync(directory).mode & 0o777).toBe(0o700);
              }
              expect(new Set(readdirSync(directory))).toEqual(
                new Set(files.map((file) => file.split("/")[1])),
              );
              for (const file of files) {
                const retainedFile = path.join(directory, path.relative(".crabbox", file));
                expect(readFileSync(retainedFile)).toEqual(bytes);
                expect(lstatSync(retainedFile).isFile()).toBe(true);
                if (file === capturePath) {
                  const unpacked = spawnSync("tar", ["-xOf", retainedFile, "stdout.log"], { env });
                  expect(unpacked.status).toBe(0);
                  expect(unpacked.stdout).toEqual(logBytes);
                }
                if (process.platform !== "win32") {
                  expect(lstatSync(retainedFile).mode & 0o777).toBe(0o600);
                  expect(lstatSync(path.dirname(retainedFile)).mode & 0o777).toBe(0o700);
                  expect(lstatSync(retainedFile).uid).toBe(process.getuid?.());
                }
              }
            }
          }
        }
      }
      expect(git("status", "--porcelain")).toBe("");
    },
  );

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
