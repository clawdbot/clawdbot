#!/usr/bin/env node
// Runs knip unused-file detection and compares results to the allowlist.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST,
  KNIP_UNUSED_FILE_ALLOWLIST,
} from "./deadcode-unused-files.allowlist.mjs";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";

const KNIP_VERSION = "6.8.0";
/**
 * Timeout for the unused-file knip child process.
 */
export const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
/**
 * Grace period before force-killing a timed-out knip child process.
 */
export const KNIP_KILL_GRACE_MS = 5_000;
/**
 * Heartbeat interval used while knip runs without output.
 */
export const KNIP_HEARTBEAT_MS = 60_000;
/**
 * Maximum buffered knip output retained for diagnostics.
 */
export const KNIP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;
const KNIP_ARGS = [
  "--config",
  "config/knip.config.ts",
  "--production",
  "--no-progress",
  "--reporter",
  "compact",
  "--files",
  "--no-config-hints",
];

function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRepoPath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

function isLikelyRepoFilePath(value) {
  return /^(apps|docs|extensions|packages|scripts|src|test|ui)\//u.test(normalizeRepoPath(value));
}

/**
 * Parses compact knip output into unused file paths.
 */
export function parseKnipCompactUnusedFiles(output) {
  const files = [];
  let inUnusedFilesSection = false;
  let sawUnusedFilesSection = false;

  for (const line of output.split(/\r?\n/u)) {
    if (/^Unused files \(\d+\)$/u.test(line)) {
      inUnusedFilesSection = true;
      sawUnusedFilesSection = true;
      continue;
    }
    if (inUnusedFilesSection && line.trim() === "") {
      break;
    }

    const separatorIndex = line.lastIndexOf(": ");
    if (separatorIndex === -1) {
      continue;
    }
    if (sawUnusedFilesSection && !inUnusedFilesSection) {
      continue;
    }
    const file = line.slice(separatorIndex + 2).trim();
    if (isLikelyRepoFilePath(file)) {
      files.push(file);
    }
  }

  return uniqueSorted(files);
}

/**
 * Compares detected unused files against the checked-in allowlist.
 */
export function compareUnusedFilesToAllowlist(
  actualFiles,
  allowlistFiles,
  optionalAllowlistFiles = [],
) {
  const actual = uniqueSorted(actualFiles);
  const allowed = uniqueSorted(allowlistFiles);
  const optionalAllowed = uniqueSorted(optionalAllowlistFiles);
  const allowedOrOptionalSet = new Set([...allowed, ...optionalAllowed]);
  const actualSet = new Set(actual);

  return {
    actual,
    allowed,
    unexpected: actual.filter((file) => !allowedOrOptionalSet.has(file)),
    stale: allowed.filter((file) => !actualSet.has(file)),
    duplicateAllowedCount: allowlistFiles.length - new Set(allowlistFiles).size,
    allowlistIsSorted:
      JSON.stringify(allowlistFiles.map(normalizeRepoPath)) === JSON.stringify(allowed),
  };
}

/**
 * Formats unused-file allowlist drift for CLI output.
 */
export function formatUnusedFileComparison(comparison) {
  const lines = [];
  if (!comparison.allowlistIsSorted) {
    lines.push("deadcode unused-file allowlist is not sorted.");
  }
  if (comparison.duplicateAllowedCount > 0) {
    lines.push(
      `deadcode unused-file allowlist contains ${comparison.duplicateAllowedCount} duplicate entr${
        comparison.duplicateAllowedCount === 1 ? "y" : "ies"
      }.`,
    );
  }
  if (comparison.unexpected.length > 0) {
    lines.push("Unexpected unused files:");
    lines.push(...comparison.unexpected.map((file) => `  ${file}`));
  }
  if (comparison.stale.length > 0) {
    lines.push("Stale allowlist entries:");
    lines.push(...comparison.stale.map((file) => `  ${file}`));
  }
  return lines.join("\n");
}

function spawnErrorCode(error) {
  return error && typeof error === "object" && "code" in error ? String(error.code) : undefined;
}

function signalProcessTree(child, signal) {
  if (!child.pid) {
    return;
  }
  try {
    if (process.platform === "win32") {
      process.kill(child.pid, signal);
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The child may have exited between the timeout and signal delivery.
  }
}

/**
 * Runs knip and returns parsed unused-file results.
 */
export async function runKnipUnusedFiles(params = {}) {
  const run = params.spawnCommand ?? spawn;
  const timeoutMs = params.timeoutMs ?? KNIP_TIMEOUT_MS;
  const heartbeatMs = params.heartbeatMs ?? KNIP_HEARTBEAT_MS;
  const maxBufferBytes = params.maxBufferBytes ?? KNIP_MAX_BUFFER_BYTES;
  const killGraceMs = params.killGraceMs ?? KNIP_KILL_GRACE_MS;
  const writeStatus = params.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
  const args = [
    "--config.minimum-release-age=0",
    "dlx",
    "--package",
    `knip@${KNIP_VERSION}`,
    "knip",
    ...KNIP_ARGS,
  ];

  return await new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let timedOut = false;
    let bufferExceeded = false;
    let outputBytes = 0;
    const output = [];
    let killTimer;
    let exitStatus = null;
    let exitSignal = null;

    const pnpm = createPnpmRunnerSpawnSpec({
      detached: process.platform !== "win32",
      env: params.env,
      nodeExecPath: params.nodeExecPath,
      npmExecPath: params.npmExecPath,
      platform: params.platform,
      pnpmArgs: args,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const child = run(pnpm.command, pnpm.args, {
      ...pnpm.options,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });

    const heartbeatTimer = setInterval(() => {
      writeStatus(
        `[deadcode] Knip unused-file scan still running after ${Math.round(
          (Date.now() - startedAt) / 1000,
        )}s.`,
      );
    }, heartbeatMs);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      clearInterval(heartbeatTimer);
      writeStatus(
        `[deadcode] Knip unused-file scan timed out after ${Math.round(timeoutMs / 1000)}s; terminating.`,
      );
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), killGraceMs);
    }, timeoutMs);

    const finish = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(killTimer);
      resolve({
        ...result,
        output: output.join(""),
      });
    };

    const appendOutput = (chunk) => {
      if (settled) {
        return;
      }
      if (bufferExceeded) {
        return;
      }
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      const remainingBytes = maxBufferBytes - outputBytes;
      if (buffer.length <= remainingBytes) {
        output.push(buffer.toString("utf8"));
        outputBytes += buffer.length;
        return;
      }
      if (remainingBytes > 0) {
        output.push(buffer.subarray(0, remainingBytes).toString("utf8"));
        outputBytes = maxBufferBytes;
      }
      if (!bufferExceeded) {
        bufferExceeded = true;
        writeStatus(
          `[deadcode] Knip unused-file scan exceeded ${maxBufferBytes} output bytes; terminating.`,
        );
        child.stdout?.off?.("data", appendOutput);
        child.stderr?.off?.("data", appendOutput);
        child.stdout?.destroy?.();
        child.stderr?.destroy?.();
        clearInterval(heartbeatTimer);
        signalProcessTree(child, "SIGTERM");
        killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), killGraceMs);
      }
    };

    child.stdout?.on("data", appendOutput);
    child.stderr?.on("data", appendOutput);
    child.on("error", (error) =>
      finish({
        errorCode: spawnErrorCode(error),
        errorMessage: error.message,
        signal: null,
        status: null,
      }),
    );
    child.on("exit", (status, signal) => {
      exitStatus = status;
      exitSignal = signal;
    });
    child.on("close", (status, signal) => {
      exitStatus = exitStatus ?? status;
      exitSignal = exitSignal ?? signal;
      const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
      if (timedOut) {
        finish({
          errorCode: "ETIMEDOUT",
          errorMessage: `Knip unused-file scan timed out after ${elapsedSeconds}s`,
          signal: exitSignal,
          status: exitStatus,
        });
        return;
      }
      if (bufferExceeded) {
        finish({
          errorCode: "ENOBUFS",
          errorMessage: `Knip unused-file scan exceeded ${maxBufferBytes} output bytes`,
          signal: exitSignal,
          status: exitStatus,
        });
        return;
      }
      finish({
        errorCode: undefined,
        errorMessage: undefined,
        signal: exitSignal,
        status: exitStatus,
      });
    });
  });
}
/**
 * Checks detected unused files against the current allowlist.
 */
export function checkUnusedFiles(
  output,
  allowlistFiles = KNIP_UNUSED_FILE_ALLOWLIST,
  optionalAllowlistFiles = KNIP_OPTIONAL_UNUSED_FILE_ALLOWLIST,
) {
  const actual = parseKnipCompactUnusedFiles(output);
  const comparison = compareUnusedFilesToAllowlist(actual, allowlistFiles, optionalAllowlistFiles);
  return {
    ok:
      comparison.allowlistIsSorted &&
      comparison.duplicateAllowedCount === 0 &&
      comparison.unexpected.length === 0 &&
      comparison.stale.length === 0,
    comparison,
    message: formatUnusedFileComparison(comparison),
  };
}

async function main() {
  const result = await runKnipUnusedFiles();
  if (result.errorCode || result.status === null) {
    console.error(
      `deadcode unused-file scan failed: ${result.errorCode ?? result.signal ?? "unknown"}${
        result.errorMessage ? `: ${result.errorMessage}` : ""
      }`,
    );
    if (result.output) {
      console.error(result.output);
    }
    process.exitCode = 1;
    return;
  }
  const check = checkUnusedFiles(result.output);
  if (!check.ok) {
    if (check.message) {
      console.error(check.message);
    }
    process.exitCode = 1;
    return;
  }

  console.log(
    `[deadcode] Knip unused-file allowlist matched ${check.comparison.actual.length} intentional entries.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main();
}
