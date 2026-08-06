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
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
      let closed = false;
      let readySettled = false;
      let resolveReady!: () => void;
      let rejectReady!: (error: Error) => void;
      let resolveExited!: (exit: WorkerSshProcessExit) => void;
      const ready = new Promise<void>((resolve, reject) => {
        resolveReady = resolve;
        rejectReady = reject;
      });
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
      child.once("error", settleReadyError);
      child.once("close", (code, signal) => {
        closed = true;
        settleReadyError();
        resolveExited({ code, signal });
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
            if (!closed) {
              child.kill("SIGKILL");
              await exited;
            }
          })());
        },
      };
    },
  };
}
