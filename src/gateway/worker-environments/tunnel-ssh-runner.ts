import { spawn } from "node:child_process";
import { sliceUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { redactSensitiveText } from "../../logging/redact.js";
import {
  runCommandWithTimeout,
  type CommandOptions,
  type SpawnResult,
} from "../../process/exec.js";

export const WORKER_TUNNEL_READY_MARKER = "OPENCLAW_WORKER_TUNNEL_READY";

const STOP_GRACE_MS = 1_500;
const STOP_KILL_WAIT_MS = 2_000;
const STDERR_LIMIT = 4_096;

type WorkerSshProcessExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type WorkerSshProcess = {
  ready: Promise<void>;
  exited: Promise<WorkerSshProcessExit>;
  stop(): Promise<void>;
};

export type WorkerSshRunner = {
  start(argv: string[], options: CommandOptions): WorkerSshProcess;
  run(argv: string[], options: CommandOptions): Promise<SpawnResult>;
};

export function workerSshProcessError(stderr: string): Error {
  const detail = redactSensitiveText(stderr, { mode: "tools" }).replace(/\s+/gu, " ").trim();
  return new Error(detail ? `Worker SSH tunnel failed: ${detail}` : "Worker SSH tunnel failed");
}

/** Production runner that treats the remote post-forward marker as connection readiness. */
export function createWorkerSshRunner(): WorkerSshRunner {
  return {
    run: runCommandWithTimeout,
    start(argv, options) {
      const [command, ...args] = argv;
      if (!command) {
        throw new Error("Worker SSH runner requires a command");
      }
      const child = spawn(command, args, {
        env: options.baseEnv,
        signal: options.signal,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let closed = false;
      let exitedSettled = false;
      let readySettled = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let resolveExited!: (exit: WorkerSshProcessExit) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
      // Readiness can reject after its awaiter timed out and moved on (stop()/late close);
      // observe it here so lifecycle settles never become unhandled rejections.
      void ready.catch(() => {});
      const exited = new Promise<WorkerSshProcessExit>((resolve) => {
        resolveExited = resolve;
      });
      let stdout = "";
      let stderr = "";
      const settleReadyError = () => {
        if (readySettled) {
          return;
        }
        readySettled = true;
        rejectReady(workerSshProcessError(stderr));
      };
      const settleExited = (exit: WorkerSshProcessExit) => {
        if (exitedSettled) {
          return;
        }
        exitedSettled = true;
        resolveExited(exit);
      };
      child.stdout.setEncoding("utf8");
      child.stdout.on("error", () => {});
      child.stdout.on("data", (chunk: string) => {
        if (readySettled) {
          return;
        }
        stdout = sliceUtf16Safe(`${stdout}${chunk}`, -STDERR_LIMIT);
        if (stdout.split(/\r?\n/u).includes(WORKER_TUNNEL_READY_MARKER)) {
          readySettled = true;
          resolveReady();
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("error", () => {});
      child.stderr.on("data", (chunk: string) => {
        stderr = sliceUtf16Safe(`${stderr}${chunk}`, -STDERR_LIMIT);
      });
      child.once("error", () => {
        settleReadyError();
        // "error" also fires for abort/kill-delivery failures on a live child; only a child
        // that never spawned (no pid) gets a synthesized exit, otherwise close/stop() settle it.
        // The no-pid case is terminal: mark it closed so stop() never signals an unspawned child.
        if (child.pid === undefined) {
          closed = true;
          settleExited({ code: null, signal: null });
        }
      });
      // "exit" fires before "close", and "close" can be delayed indefinitely while a
      // descendant holds a piped stdio descriptor; settle on the real exit so connected
      // tunnels awaiting `exited` observe termination without depending on stream closure.
      let exitEventResult: WorkerSshProcessExit | undefined;
      child.once("exit", (code, signal) => {
        exitEventResult = { code, signal };
        settleReadyError();
        settleExited(exitEventResult);
        // Release our pipe ends so a descendant holding the other side cannot pin local
        // descriptors across retries; this also lets "close" fire promptly.
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      });
      child.once("close", (code, signal) => {
        closed = true;
        settleReadyError();
        settleExited({ code, signal });
      });
      child.stdin.on("error", () => {});
      if (options.input !== undefined) {
        child.stdin.end(options.input);
      } else {
        child.stdin.end();
      }

      let stopPromise: Promise<void> | undefined;
      return {
        ready,
        exited,
        stop() {
          return (stopPromise ??= (async () => {
            if (closed) {
              return;
            }
            child.kill("SIGTERM");
            let timer: ReturnType<typeof setTimeout> | undefined;
            await Promise.race([
              exited,
              new Promise<void>((resolve) => {
                timer = setTimeout(resolve, STOP_GRACE_MS);
                timer.unref?.();
              }),
            ]);
            clearTimeout(timer);
            if (!closed && !exitedSettled) {
              // A false return can also mean the child died a moment ago with its "exit"
              // event still queued; always take the bounded wait before judging.
              const killDelivered = child.kill("SIGKILL");
              let killTimer: ReturnType<typeof setTimeout> | undefined;
              let killWaitExpired = false;
              await Promise.race([
                exited,
                new Promise<void>((resolve) => {
                  killTimer = setTimeout(() => {
                    killWaitExpired = true;
                    resolve();
                  }, STOP_KILL_WAIT_MS);
                  killTimer.unref?.();
                }),
              ]);
              clearTimeout(killTimer);
              if (killWaitExpired) {
                // Neither delivered SIGKILL nor failed delivery proves termination without
                // an exit event; fail the stop so the owner keeps tracking the live child.
                throw workerSshProcessError(
                  killDelivered
                    ? "SSH child did not exit after SIGKILL; it may still be running"
                    : "SIGKILL delivery failed; SSH child may still be running",
                );
              }
            }
          })());
        },
      };
    },
  };
}
