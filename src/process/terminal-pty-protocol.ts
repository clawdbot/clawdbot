import { isRecord, isStringRecord } from "@openclaw/normalization-core/record-coerce";
import type { TerminalPtySpawnParams } from "./terminal-pty.js";

export type TerminalPtyControl =
  | { type: "start"; params: TerminalPtySpawnParams }
  | { type: "input"; data: string }
  | { type: "resize"; cols: number; rows: number }
  | { type: "kill"; signal?: string };

export type TerminalPtyEvent =
  | { type: "boot" }
  | { type: "ready"; pid: number }
  | { type: "error"; message: string }
  | { type: "exit"; exitCode: number; signal?: number };

export function decodeTerminalPtyControl(raw: unknown): TerminalPtyControl | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.type === "start") {
    const params = raw.params;
    if (
      isRecord(params) &&
      typeof params.file === "string" &&
      Array.isArray(params.args) &&
      params.args.every((arg) => typeof arg === "string") &&
      (params.cwd === undefined || typeof params.cwd === "string") &&
      isStringRecord(params.env) &&
      typeof params.cols === "number" &&
      typeof params.rows === "number"
    ) {
      return {
        type: "start",
        params: {
          file: params.file,
          args: params.args,
          cwd: params.cwd,
          env: params.env,
          cols: params.cols,
          rows: params.rows,
        },
      };
    }
  } else if (raw.type === "input" && typeof raw.data === "string") {
    return { type: "input", data: raw.data };
  } else if (
    raw.type === "resize" &&
    typeof raw.cols === "number" &&
    typeof raw.rows === "number"
  ) {
    return { type: "resize", cols: raw.cols, rows: raw.rows };
  } else if (raw.type === "kill" && (raw.signal === undefined || typeof raw.signal === "string")) {
    return { type: "kill", signal: raw.signal };
  }
  return undefined;
}

export function decodeTerminalPtyEvent(raw: unknown): TerminalPtyEvent | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  if (raw.type === "boot") {
    return { type: "boot" };
  }
  if (
    raw.type === "ready" &&
    typeof raw.pid === "number" &&
    Number.isInteger(raw.pid) &&
    raw.pid > 0
  ) {
    return { type: "ready", pid: raw.pid };
  }
  if (raw.type === "error" && typeof raw.message === "string") {
    return { type: "error", message: raw.message };
  }
  if (
    raw.type === "exit" &&
    typeof raw.exitCode === "number" &&
    (raw.signal === undefined || typeof raw.signal === "number")
  ) {
    return { type: "exit", exitCode: raw.exitCode, signal: raw.signal };
  }
  return undefined;
}
