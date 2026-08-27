#!/usr/bin/env node
// Bridges one OpenClaw sandbox exec into a Daytona sandbox over the toolbox API.
// Spawned by the daytona sandbox backend with a payload file describing the run.

import { randomBytes } from "node:crypto";
import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const EXIT_POLL_INTERVAL_MS = 500;
const SIGNAL_NUMBERS = new Map([
  ["SIGHUP", 1],
  ["SIGINT", 2],
  ["SIGTERM", 15],
]);

export function decodePayload(argv) {
  const payloadFileIndex = argv.indexOf("--payload-file");
  if (payloadFileIndex < 0) {
    throw new Error("Missing --payload-file");
  }
  const payloadFile = argv[payloadFileIndex + 1];
  if (!payloadFile) {
    throw new Error("Missing --payload-file value");
  }
  const payloadJson = readFileSync(payloadFile, "utf8");
  // The payload carries the Daytona API key; drop it from disk as soon as it
  // is read so the secret only lives in this process.
  rmSync(path.dirname(payloadFile), { force: true, recursive: true });
  return JSON.parse(payloadJson);
}

export function shellEscape(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function buildSessionCommand(command, env = {}) {
  const exports = Object.entries(env).map(([key, value]) => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key)) {
      throw new Error(
        `Invalid Daytona sandbox environment variable name ${JSON.stringify(key)}; use a POSIX variable name.`,
      );
    }
    if (value.includes("\0")) {
      throw new Error(
        `Invalid Daytona sandbox environment variable ${JSON.stringify(key)}; values must not contain NUL bytes.`,
      );
    }
    return `export ${key}=${shellEscape(value)}`;
  });
  return exports.length > 0 ? `${exports.join("; ")}; exec ${command}` : command;
}

function formatError(error) {
  if (error && typeof error === "object" && typeof error.stack === "string") {
    return error.stack;
  }
  return String(error);
}

function signalExitCode(signal) {
  const signalNumber = SIGNAL_NUMBERS.get(signal);
  return signalNumber === undefined ? 1 : 128 + signalNumber;
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Register signal cleanup before any remote call so a timeout or cancellation
 * SIGTERM during startup still kills the remote session or PTY. An accepted
 * command must never keep running after this launcher reports it stopped.
 */
export function registerCleanupSignals(cleanup, options = {}) {
  const onSignal = options.onSignal ?? ((signal, handler) => process.on(signal, handler));
  const exit = options.exit ?? ((code) => process.exit(code));
  // Callers await this promise before reporting a signal exit; otherwise
  // main's process.exit can beat remote teardown and leave the command running.
  const state = { interrupted: null, cleanupPromise: Promise.resolve() };
  for (const signal of SIGNAL_NUMBERS.keys()) {
    onSignal(signal, () => {
      if (state.interrupted) {
        return;
      }
      state.interrupted = signal;
      state.cleanupPromise = cleanup()
        .catch(() => {})
        .then(() => {})
        .finally(() => exit(signalExitCode(signal)));
    });
  }
  return state;
}

export async function runPtyExec(sandbox, payload, options = {}) {
  const ptyId = `openclaw-pty-${randomBytes(6).toString("hex")}`;
  // Cleanup is armed before the PTY exists; killing an id that was never
  // created fails harmlessly inside the catch.
  const signalState = registerCleanupSignals(() => sandbox.process.killPtySession(ptyId), options);
  let ptyHandle;
  try {
    ptyHandle = await sandbox.process.createPty({
      id: ptyId,
      cwd: payload.cwd,
      envs: payload.env,
      cols: process.stdout.columns ?? 80,
      rows: process.stdout.rows ?? 24,
      onData: (data) => {
        process.stdout.write(Buffer.from(data));
      },
    });
    await ptyHandle.waitForConnection();
    if (signalState.interrupted) {
      await signalState.cleanupPromise;
      return signalExitCode(signalState.interrupted);
    }
    // `exec` replaces the interactive shell so the PTY session ends with the
    // command and reports its exit code. The command stays single quoted, which
    // keeps embedded newlines inside one shell word for the line-based PTY.
    await ptyHandle.sendInput(`exec /bin/sh -c ${shellEscape(payload.command)}\n`);
    if (signalState.interrupted) {
      await signalState.cleanupPromise;
      return signalExitCode(signalState.interrupted);
    }

    const stdin = options.stdin ?? process.stdin;
    let inputQueue = Promise.resolve();
    const enqueueInput = (data) => {
      // Preserve terminal byte order across the SDK's async send boundary;
      // EOT must never overtake the final stdin chunk.
      inputQueue = inputQueue.then(() => ptyHandle.sendInput(data)).catch(() => {});
    };
    stdin.on("data", (chunk) => {
      enqueueInput(new Uint8Array(chunk));
    });
    // A pipe-open caller closes stdin to signal EOF. PTYs have no half-close,
    // so forward terminal EOT or commands waiting for EOF can hang indefinitely.
    stdin.on("end", () => {
      enqueueInput("\x04");
    });
    stdin.resume();
    process.stdout.on("resize", () => {
      void ptyHandle
        .resize(process.stdout.columns ?? 80, process.stdout.rows ?? 24)
        .catch(() => {});
    });

    const result = await ptyHandle.wait();
    if (signalState.interrupted) {
      await signalState.cleanupPromise;
      return signalExitCode(signalState.interrupted);
    }
    if (result.error && result.exitCode === undefined) {
      process.stderr.write(`[daytona-sandbox] pty failed: ${result.error}\n`);
      return 1;
    }
    return result.exitCode ?? 0;
  } catch (error) {
    // A rejected connection, input, or wait does not prove the remote process
    // stopped. Kill by id before reporting failure, then release the socket.
    await sandbox.process.killPtySession(ptyId).catch(() => {});
    throw error;
  } finally {
    await ptyHandle?.disconnect().catch(() => {});
  }
}

export async function runSessionExec(sandbox, payload, options = {}) {
  const sessionId = `openclaw-exec-${randomBytes(6).toString("hex")}`;
  const deleteSession = async () => {
    await sandbox.process.deleteSession(sessionId).catch(() => {});
  };
  // Cleanup is armed before the session exists; deleting the session kills a
  // remote command that was accepted while this launcher was being torn down.
  const signalState = registerCleanupSignals(deleteSession, options);
  await sandbox.process.createSession(sessionId);
  try {
    if (signalState.interrupted) {
      return signalExitCode(signalState.interrupted);
    }
    const execution = await sandbox.process.executeSessionCommand(sessionId, {
      command: buildSessionCommand(payload.command, payload.env),
      runAsync: true,
      suppressInputEcho: true,
    });
    if (signalState.interrupted) {
      return signalExitCode(signalState.interrupted);
    }
    const commandId = execution.cmdId;
    if (!commandId) {
      throw new Error("Daytona did not return a command id for the exec session");
    }

    process.stdin.on("data", (chunk) => {
      void sandbox.process
        .sendSessionCommandInput(sessionId, commandId, chunk.toString("utf8"))
        .catch(() => {});
    });
    process.stdin.resume();

    // Track emitted lengths so the post-exit catch-up fetch only appends
    // output the live stream missed. The stream can end while the command is
    // still running, so command lifecycle never depends on it.
    let stdoutEmitted = 0;
    let stderrEmitted = 0;
    const emitStdout = (chunk) => {
      stdoutEmitted += chunk.length;
      process.stdout.write(chunk);
    };
    const emitStderr = (chunk) => {
      stderrEmitted += chunk.length;
      process.stderr.write(chunk);
    };
    void sandbox.process
      .getSessionCommandLogs(sessionId, commandId, emitStdout, emitStderr)
      .catch(() => {});

    let exitCode;
    let pollFailures = 0;
    for (;;) {
      if (signalState.interrupted) {
        return signalExitCode(signalState.interrupted);
      }
      try {
        const command = await sandbox.process.getSessionCommand(sessionId, commandId);
        exitCode = command.exitCode;
        pollFailures = 0;
      } catch (error) {
        pollFailures += 1;
        if (pollFailures >= 5) {
          throw error;
        }
      }
      if (exitCode !== undefined && exitCode !== null) {
        break;
      }
      await sleep(EXIT_POLL_INTERVAL_MS);
    }

    const finalLogs = await sandbox.process.getSessionCommandLogs(sessionId, commandId);
    const stdoutTail = (finalLogs.stdout ?? "").slice(stdoutEmitted);
    const stderrTail = (finalLogs.stderr ?? "").slice(stderrEmitted);
    if (stdoutTail) {
      process.stdout.write(stdoutTail);
    }
    if (stderrTail) {
      process.stderr.write(stderrTail);
    }
    return exitCode;
  } finally {
    await deleteSession();
  }
}

function isMain() {
  const mainPath = process.argv[1];
  if (!mainPath) {
    return false;
  }
  return import.meta.url === pathToFileURL(path.resolve(mainPath)).href;
}

export async function main() {
  let exitCode;
  try {
    const payload = decodePayload(process.argv.slice(2));
    const { Daytona } = await import("@daytona/sdk");
    const client = new Daytona({
      apiKey: payload.apiKey,
      apiUrl: payload.apiUrl,
      target: payload.target,
    });
    const sandbox = await client.get(payload.sandboxId);
    if (sandbox.state !== "started") {
      // Daytona auto-stops idle sandboxes; restart before running so an exec
      // after an idle gap works instead of failing on a stopped sandbox.
      await sandbox.start();
    }
    exitCode = payload.usePty
      ? await runPtyExec(sandbox, payload)
      : await runSessionExec(sandbox, payload);
  } catch (error) {
    process.stderr.write(`[daytona-sandbox] ${formatError(error)}\n`);
    exitCode = 127;
  }
  process.exit(exitCode ?? 1);
}

if (isMain()) {
  void main();
}
