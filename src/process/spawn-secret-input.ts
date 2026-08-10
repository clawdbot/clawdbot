import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { SpawnSecretInput } from "./supervisor/types.js";

// A positive integer entry is a descriptor already open in the parent, which
// the child inherits at `fork` — before `exec`. That ordering is what makes an
// inherited descriptor usable as ownership evidence (see addInheritedFdStdio).
export type SpawnStdioEntry = "ignore" | "inherit" | "overlapped" | "pipe" | number;

/**
 * Append a parent-owned descriptor to `stdio` so the child inherits it.
 *
 * Unlike `addSecretInputStdio` (which opens a fresh pipe in the slot), this
 * hands the child a descriptor the parent already holds. The distinction
 * matters: inheritance happens at `fork`, so the child holds the descriptor
 * during the whole pre-`exec` window in which its argv still belongs to the
 * parent and reveals nothing about what it is about to run.
 *
 * Returns the slot used, or undefined when there is nothing to inherit.
 */
export function addInheritedFdStdio(
  stdio: SpawnStdioEntry[],
  fd: number | undefined,
): number | undefined {
  if (fd === undefined) {
    return undefined;
  }
  if (!Number.isInteger(fd) || fd < 0) {
    throw new Error("inherited file descriptor must be a non-negative integer");
  }
  // Never displace stdin/stdout/stderr or an already-assigned slot.
  while (stdio.length < 3) {
    stdio.push("ignore");
  }
  stdio.push(fd);
  return stdio.length - 1;
}

export function addSecretInputStdio(
  stdio: SpawnStdioEntry[],
  secretInput: SpawnSecretInput | undefined,
): void {
  if (!secretInput) {
    return;
  }
  if (!Number.isInteger(secretInput.fd) || secretInput.fd < 3) {
    throw new Error("secret input file descriptor must be an integer greater than 2");
  }
  while (stdio.length <= secretInput.fd) {
    stdio.push("ignore");
  }
  stdio[secretInput.fd] = process.platform === "win32" ? "overlapped" : "pipe";
}

export async function writeSecretInputToChild(
  child: ChildProcess,
  secretInput: SpawnSecretInput | undefined,
): Promise<void> {
  if (!secretInput) {
    return;
  }
  const stream = child.stdio[secretInput.fd] as Writable | null | undefined;
  if (!stream || typeof stream.end !== "function") {
    throw new Error(`secret input file descriptor ${secretInput.fd} is unavailable`);
  }
  let data: Buffer | undefined;
  try {
    data = secretInput.createData();
    // End the parent pipe immediately after delivery so descendants cannot
    // inherit a still-readable credential stream.
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (error?: Error | null) => {
        if (settled) {
          return;
        }
        settled = true;
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };
      const onError = (error: Error) => {
        settle(error);
      };
      // A child-process pipe can emit its terminal error after end's callback.
      // Keep it handled until close while only the first outcome settles delivery.
      stream.on("error", onError);
      stream.once("close", () => {
        stream.off("error", onError);
      });
      stream.end(data, settle);
    });
  } finally {
    data?.fill(0);
  }
}
