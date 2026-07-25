import { spawn } from "node:child_process";
import { createPnpmRunnerSpawnSpec } from "./pnpm-runner.mjs";

const KNIP_VERSION = "6.8.0";
const KNIP_TIMEOUT_MS = 10 * 60 * 1000;
const KNIP_KILL_GRACE_MS = 5_000;
const KNIP_PROCESS_TREE_EXIT_POLL_MS = 25;
const KNIP_POST_FORCE_KILL_WAIT_MS = 1_000;
const KNIP_HEARTBEAT_MS = 60_000;

/** Maximum buffered Knip output retained for diagnostics. */
export const KNIP_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function normalizeRepoPath(value) {
  return value.replaceAll("\\", "/").replace(/^\.\//u, "");
}

export function uniqueSorted(values) {
  return [...new Set(values.map(normalizeRepoPath))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function isLikelyRepoFilePath(value) {
  const normalized = normalizeRepoPath(value);
  return (
    !normalized.startsWith("/") &&
    !/^[A-Za-z]:/u.test(normalized) &&
    !normalized.startsWith("../") &&
    !normalized.includes("/../") &&
    /\.(?:[cm]?[jt]sx?)$/u.test(normalized)
  );
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

function processTreeAlive(child) {
  if (!child.pid) {
    return false;
  }
  if (process.platform === "win32") {
    return child.exitCode === null && child.signalCode === null;
  }
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function waitForProcessTreeExit(child, timeoutMs) {
  const deadlineAt = Date.now() + timeoutMs;
  while (Date.now() < deadlineAt) {
    if (!processTreeAlive(child)) {
      return true;
    }
    await new Promise((resolvePoll) => {
      setTimeout(resolvePoll, KNIP_PROCESS_TREE_EXIT_POLL_MS);
    });
  }
  return !processTreeAlive(child);
}

/** Runs pinned Knip with the supplied CLI arguments. */
export async function runKnip(knipArgs, params = {}) {
  const run = params.spawnCommand ?? spawn;
  const timeoutMs = params.timeoutMs ?? KNIP_TIMEOUT_MS;
  const heartbeatMs = params.heartbeatMs ?? KNIP_HEARTBEAT_MS;
  const maxBufferBytes = params.maxBufferBytes ?? KNIP_MAX_BUFFER_BYTES;
  const killGraceMs = params.killGraceMs ?? KNIP_KILL_GRACE_MS;
  const scanName = params.scanName ?? "scan";
  const writeStatus = params.writeStatus ?? ((message) => process.stderr.write(`${message}\n`));
  const args = [
    "--config.minimum-release-age=0",
    "dlx",
    "--package",
    `knip@${KNIP_VERSION}`,
    "knip",
    ...knipArgs,
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
    const parentSignalHandlers = [];
    const cleanupParentSignalHandlers = () => {
      for (const { signal, handler } of parentSignalHandlers) {
        process.off(signal, handler);
      }
      parentSignalHandlers.length = 0;
    };
    const relayParentSignal = (signal) => {
      const handler = () => {
        signalProcessTree(child, signal);
        signalProcessTree(child, "SIGKILL");
        cleanupParentSignalHandlers();
        process.kill(process.pid, signal);
      };
      parentSignalHandlers.push({ signal, handler });
      process.once(signal, handler);
    };
    if (process.platform !== "win32") {
      relayParentSignal("SIGINT");
      relayParentSignal("SIGTERM");
      relayParentSignal("SIGHUP");
    }

    const heartbeatTimer = setInterval(() => {
      writeStatus(
        `[deadcode] Knip ${scanName} still running after ${Math.round((Date.now() - startedAt) / 1000)}s.`,
      );
    }, heartbeatMs);

    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      clearInterval(heartbeatTimer);
      writeStatus(
        `[deadcode] Knip ${scanName} timed out after ${Math.round(timeoutMs / 1000)}s; terminating.`,
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
      cleanupParentSignalHandlers();
      resolve({ ...result, output: output.join("") });
    };
    const finishAfterProcessTreeCleanup = async (result) => {
      if (processTreeAlive(child)) {
        await waitForProcessTreeExit(child, killGraceMs);
      }
      if (processTreeAlive(child)) {
        signalProcessTree(child, "SIGKILL");
        await waitForProcessTreeExit(child, KNIP_POST_FORCE_KILL_WAIT_MS);
      }
      finish(result);
    };

    const appendOutput = (chunk) => {
      if (settled || bufferExceeded) {
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
      bufferExceeded = true;
      writeStatus(
        `[deadcode] Knip ${scanName} exceeded ${maxBufferBytes} output bytes; terminating.`,
      );
      child.stdout?.off?.("data", appendOutput);
      child.stderr?.off?.("data", appendOutput);
      child.stdout?.destroy?.();
      child.stderr?.destroy?.();
      clearInterval(heartbeatTimer);
      signalProcessTree(child, "SIGTERM");
      killTimer = setTimeout(() => signalProcessTree(child, "SIGKILL"), killGraceMs);
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
        void finishAfterProcessTreeCleanup({
          errorCode: "ETIMEDOUT",
          errorMessage: `Knip ${scanName} timed out after ${elapsedSeconds}s`,
          signal: exitSignal,
          status: exitStatus,
        });
        return;
      }
      if (bufferExceeded) {
        void finishAfterProcessTreeCleanup({
          errorCode: "ENOBUFS",
          errorMessage: `Knip ${scanName} exceeded ${maxBufferBytes} output bytes`,
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
