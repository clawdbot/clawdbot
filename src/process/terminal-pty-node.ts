import { spawn } from "node:child_process";
import { constants } from "node:os";
import { resolveExecutablePath } from "../infra/executable-path.js";
import { runtimeProcessEntrypoints } from "../infra/runtime-process-entrypoints.js";
import { resolveRuntimeWorkerArgv, resolveRuntimeWorkerUrl } from "../infra/runtime-worker-url.js";
import { createDeferredCore } from "../shared/deferred.js";
import { killProcessTree, signalPtySessionTree } from "./kill-tree.js";
import { decodeTerminalPtyEvent, type TerminalPtyControl } from "./terminal-pty-protocol.js";
import type { TerminalPtyHandle, TerminalPtySpawnParams } from "./terminal-pty.js";

const STARTUP_TIMEOUT_MS = 10_000;
const CLEANUP_TIMEOUT_MS = 2_000;

/** Keeps native PTY I/O on Node while the Gateway or node host runs on Bun. */
export async function spawnNodeTerminalPty(
  params: TerminalPtySpawnParams,
): Promise<TerminalPtyHandle> {
  const node = resolveExecutablePath("node", { env: process.env });
  if (!node) {
    throw new Error("A Node executable is required for terminals on Bun; add node to PATH.");
  }
  const worker = resolveRuntimeWorkerUrl(runtimeProcessEntrypoints.terminalPty);
  const child = spawn(node, resolveRuntimeWorkerArgv(worker, node), {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    serialization: "json",
    env: process.env,
  });
  const stdout = child.stdout;
  const stderrPipe = child.stderr;
  if (!stdout || !stderrPipe) {
    child.once("error", () => undefined);
    child.kill("SIGKILL");
    throw new Error("Terminal Node worker did not provide its required output pipes");
  }
  const ready = createDeferredCore<number>();
  const listeners = new Set<(event: { exitCode: number; signal?: number }) => void>();
  let exited: { exitCode: number; signal?: number } | undefined;
  let reportedExit: typeof exited;
  let startupError: Error | undefined;
  let stderr = "";
  let paused = false;
  let subscribed = false;
  let ptyPid: number | undefined;
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
  let helperExit: typeof exited;
  let outputEnded = false;
  let ipcClosed = false;

  const fail = (error: Error) => {
    if (exited) {
      return;
    }
    startupError ??= error;
    ready.reject(error);
    if (child.connected) {
      child.disconnect();
    }
    stdout.resume();
    if (!helperExit) {
      cleanupTimer ??= setTimeout(() => {
        if (ptyPid !== undefined) {
          signalPtySessionTree(ptyPid, "SIGKILL");
        }
        if (child.pid !== undefined) {
          killProcessTree(child.pid, { force: true, detached: false });
        }
      }, CLEANUP_TIMEOUT_MS);
    }
  };
  const send = (message: TerminalPtyControl) => {
    if (!child.connected) {
      return;
    }
    child.send(message, (error) => {
      if (error) {
        fail(error);
      }
    });
  };
  const timeout = setTimeout(
    () => fail(new Error("Terminal Node worker startup timed out")),
    STARTUP_TIMEOUT_MS,
  );
  const finish = () => {
    if (exited || !helperExit || !outputEnded || !ipcClosed) {
      return;
    }
    ready.reject(
      startupError ?? new Error(stderr.trim() || "Terminal Node worker exited before startup"),
    );
    exited = startupError ? { exitCode: 1 } : (reportedExit ?? helperExit);
    for (const listener of listeners) {
      listener(exited);
    }
  };
  stdout.pause();
  stdout.setEncoding("utf8");
  stderrPipe.setEncoding("utf8");
  stderrPipe.on("data", (data: string) => {
    stderr = (stderr + data).slice(-8_192);
  });
  child.on("error", (error) => {
    if (child.pid === undefined) {
      helperExit = { exitCode: 1 };
      ipcClosed = true;
    }
    fail(error);
    finish();
  });
  stdout.on("error", fail);
  stdout.once("close", () => {
    outputEnded = true;
    finish();
  });
  stdout.once("end", () => {
    outputEnded = true;
    finish();
  });
  child.once("disconnect", () => {
    ipcClosed = true;
    finish();
  });
  child.on("message", (raw: unknown) => {
    const message = decodeTerminalPtyEvent(raw);
    if (!message) {
      fail(new Error("Invalid terminal worker message"));
      return;
    }
    if (message.type === "boot") {
      send({ type: "start", params });
    } else if (message.type === "ready") {
      ptyPid = message.pid;
      ready.resolve(message.pid);
    } else if (message.type === "error") {
      fail(new Error(message.message));
    } else {
      reportedExit = { exitCode: message.exitCode, signal: message.signal };
    }
  });
  child.once("exit", (code, signal) => {
    clearTimeout(timeout);
    clearTimeout(cleanupTimer);
    if (!reportedExit && ptyPid !== undefined) {
      signalPtySessionTree(ptyPid, "SIGKILL");
    }
    helperExit = {
      exitCode: code ?? 1,
      ...(signal ? { signal: constants.signals[signal] } : {}),
    };
    if (ptyPid === undefined) {
      stdout.resume();
    }
    // Node can omit ChildProcess.close after a host-side IPC disconnect. Join
    // process exit, final IPC delivery, and output EOF without dropping tail bytes.
    finish();
  });
  let pid: number;
  try {
    pid = await ready.promise;
  } finally {
    clearTimeout(timeout);
  }
  return {
    pid,
    write: (data) => send({ type: "input", data }),
    resize: (cols, rows) => send({ type: "resize", cols, rows }),
    pause: () => {
      paused = true;
      stdout.pause();
    },
    resume: () => {
      paused = false;
      if (subscribed) {
        stdout.resume();
      }
    },
    onData: (listener) => {
      stdout.on("data", listener);
      subscribed = true;
      if (!paused) {
        stdout.resume();
      }
    },
    onExit: (listener) => {
      listeners.add(listener);
      if (exited) {
        listener(exited);
      }
    },
    kill: (signal) => {
      send({ type: "kill", signal });
      // A paused pipe must drain so process cleanup can reach the close event.
      stdout.resume();
    },
  };
}
