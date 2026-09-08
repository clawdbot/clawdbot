import type { ChildProcess } from "node:child_process";
import { createWriteStream, write, writev } from "node:fs";
import { createRequire } from "node:module";
import type { Writable } from "node:stream";
import { toErrorObject } from "../infra/errors.js";
import type { SpawnSecretInput } from "./supervisor/types.js";

export type SpawnStdioEntry = "ignore" | "inherit" | "ipc" | "overlapped" | "pipe" | number;

const require = createRequire(import.meta.url);
type SecretPipe = { fds: number[]; close: (fd: number) => void };
let createPipe: (() => SecretPipe) | undefined;

function createSecretPipe(): SecretPipe {
  createPipe ??= (() => {
    // SAFETY: Koffi's require export has the same API as its typed default export.
    const koffi = require("koffi") as typeof import("koffi").default;
    const libc = koffi.load(null);
    const closeFd = libc.func("int close(int fd)");
    const close = (fd: number) => {
      if (closeFd(fd) !== 0) {
        throw new Error(`secret input close failed (errno ${koffi.errno()})`);
      }
    };
    const pipe = libc.func(
      process.platform === "linux"
        ? "int pipe2(_Out_ int *fds, int flags)"
        : "int pipe(_Out_ int *fds)",
    );
    const fcntl =
      process.platform === "linux" ? undefined : libc.func("int fcntl(int fd, int cmd, ...)");
    return () => {
      const fds = [-1, -1];
      // Linux allocates with O_CLOEXEC atomically. POSIX F_SETFD=2/FD_CLOEXEC=1
      // protects other execs on platforms without pipe2; no async work intervenes.
      if (pipe(fds, ...(fcntl ? [] : [0x80000])) !== 0) {
        throw new Error(`secret input pipe creation failed (errno ${koffi.errno()})`);
      }
      try {
        if (fcntl && fds.some((fd) => fcntl(fd, 2, "int", 1) !== 0)) {
          throw new Error(`secret input close-on-exec failed (errno ${koffi.errno()})`);
        }
        return { fds, close };
      } catch (error) {
        fds.forEach(close);
        throw error;
      }
    };
  })();
  return createPipe();
}

type SecretDeliveryOptions = {
  abortSignal?: AbortSignal;
};

export function prepareSecretInputStdio(
  stdio: SpawnStdioEntry[],
  secretInput: SpawnSecretInput | undefined,
):
  | {
      deliverTo: (child: ChildProcess, options?: SecretDeliveryOptions) => Promise<void>;
      [Symbol.dispose]: () => void;
    }
  | undefined {
  if (!secretInput) {
    return undefined;
  }
  if (!Number.isInteger(secretInput.fd) || secretInput.fd < 3) {
    throw new Error("secret input file descriptor must be an integer greater than 2");
  }
  while (stdio.length <= secretInput.fd) {
    stdio.push("ignore");
  }
  // Node's POSIX stdio "pipe" is a socketpair, which cannot be reopened through
  // /proc/self/fd. A real anonymous pipe supports external CLI descriptor readers
  // while preserving one-shot consumption without credential files or shell relays.
  const pipe = process.platform === "win32" ? undefined : createSecretPipe();
  let [readFd, writeFd] = pipe?.fds ?? [];
  stdio[secretInput.fd] = readFd ?? "overlapped";
  const closeRead = () => {
    if (readFd !== undefined) {
      pipe!.close(readFd);
      readFd = undefined;
    }
  };
  return {
    [Symbol.dispose]() {
      closeRead();
      if (writeFd !== undefined) {
        pipe!.close(writeFd);
        writeFd = undefined;
      }
    },
    async deliverTo(child, options) {
      closeRead();
      const stream =
        writeFd === undefined
          ? (child.stdio[secretInput.fd] as Writable | null | undefined)
          : createWriteStream("", {
              fd: writeFd,
              fs: {
                write,
                writev,
                // Native allocations are outside Node's per-worker fd registry.
                close(fd, callback) {
                  try {
                    pipe!.close(fd);
                    callback(null);
                  } catch (error) {
                    callback(toErrorObject(error, "secret input close failed"));
                  }
                },
              },
            });
      writeFd = undefined;
      if (!stream || typeof stream.end !== "function") {
        throw new Error(`secret input file descriptor ${secretInput.fd} is unavailable`);
      }
      const abortSignal = options?.abortSignal;
      if (abortSignal?.aborted) {
        stream.destroy();
        throw new Error("secret delivery aborted");
      }
      let data: Buffer | undefined;
      try {
        data = secretInput.createData();
        // Close the writer after delivery: later readers must see EOF, never a replay.
        await new Promise<void>((resolve, reject) => {
          let settled = false;
          const settle = (error?: Error | null) => {
            if (settled) {
              return;
            }
            settled = true;
            abortSignal?.removeEventListener("abort", onAbort);
            if (error) {
              reject(error);
            } else {
              resolve();
            }
          };
          const onAbort = () => {
            stream.destroy();
            settle(new Error("secret delivery aborted"));
          };
          const onError = (error: Error) => settle(error);
          // A pipe can emit its terminal error after end's callback. Retain the
          // handler until close while only the first outcome settles delivery.
          abortSignal?.addEventListener("abort", onAbort, { once: true });
          stream.on("error", onError);
          stream.once("close", () => stream.off("error", onError));
          stream.end(data, settle);
        });
      } finally {
        data?.fill(0);
        stream.destroy();
      }
    },
  };
}
