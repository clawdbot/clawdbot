import { asOptionalRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import { mergeProcessEnv } from "../../infra/process-env.js";
import type { ServiceChildStart } from "./service-child-protocol.js";

export function buildWindowsJobEnvironmentBlock(env: Record<string, string> | undefined): Buffer {
  const merged = mergeProcessEnv([env], "win32");
  for (const [key, value] of Object.entries(merged)) {
    if (key.includes("\0") || value.includes("\0")) {
      throw new Error("owned command environment contains a NUL byte");
    }
  }
  const entries = Object.keys(merged)
    .toSorted((left, right) => {
      const leftFolded = left.toUpperCase();
      const rightFolded = right.toUpperCase();
      return leftFolded < rightFolded ? -1 : leftFolded > rightFolded ? 1 : 0;
    })
    .map((key) => `${key}=${merged[key]}`);
  return Buffer.from(`${entries.join("\0")}\0\0`, "utf16le");
}

export function isWindowsJobServiceStart(value: unknown): value is ServiceChildStart {
  const message = asOptionalRecord(value);
  return Boolean(
    message &&
    message.type === "start" &&
    typeof message.generation === "string" &&
    typeof message.command === "string" &&
    Array.isArray(message.args) &&
    message.args.every((arg) => typeof arg === "string") &&
    (message.cwd === undefined || typeof message.cwd === "string") &&
    (message.env === undefined || isStringRecord(message.env)) &&
    (message.stdinMode === "inherit" ||
      message.stdinMode === "pipe-open" ||
      message.stdinMode === "pipe-closed") &&
    (message.secretFd === undefined || typeof message.secretFd === "number") &&
    (message.controlFd === undefined || typeof message.controlFd === "number") &&
    (message.windowsShellCommand === undefined || typeof message.windowsShellCommand === "string"),
  );
}
