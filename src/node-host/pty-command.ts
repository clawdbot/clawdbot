import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { mergeProcessEnv } from "../infra/process-env.js";
import type { OpenClawPluginNodeHostCommandIo } from "../plugins/types.js";
import { spawnTerminalPty } from "../process/terminal-pty.js";

export type NodePtyCommandResult = { exitCode: number; signal?: number };
export type NodePtyResumeParams = {
  threadId: string;
  cwd?: string;
  cols: number;
  rows: number;
};

type NodePtyInput = { kind: "data"; data: string } | { kind: "resize"; cols: number; rows: number };

function resolvePtyCwd(candidate?: string, required = false): string {
  if (candidate && path.isAbsolute(candidate)) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Missing/unreadable catalog cwd falls back to the node user's home.
    }
  }
  if (required) {
    throw new Error("INVALID_REQUEST: cwd must be an existing absolute directory on this node");
  }
  return os.homedir();
}

function decodePtyInput(payloadJSON: string): NodePtyInput | null {
  try {
    const value = JSON.parse(payloadJSON) as unknown;
    if (!isRecord(value)) {
      return null;
    }
    const input = value;
    if (input.kind === "data" && typeof input.data === "string") {
      return { kind: "data", data: input.data };
    }
    if (
      input.kind === "resize" &&
      Number.isInteger(input.cols) &&
      Number.isInteger(input.rows) &&
      (input.cols as number) >= 1 &&
      (input.cols as number) <= 2000 &&
      (input.rows as number) >= 1 &&
      (input.rows as number) <= 2000
    ) {
      return { kind: "resize", cols: input.cols as number, rows: input.rows as number };
    }
    return null;
  } catch {
    return null;
  }
}

function decodePtyParams(paramsJSON: string | null | undefined, action: "start" | "resume") {
  let value: unknown;
  try {
    value = JSON.parse(paramsJSON ?? "");
  } catch {
    throw new Error(`INVALID_REQUEST: terminal ${action} params must be valid JSON`);
  }
  if (!isRecord(value)) {
    throw new Error(`INVALID_REQUEST: terminal ${action} params must be an object`);
  }
  const allowed = new Set([
    action === "start" ? "initialMessage" : "threadId",
    "cwd",
    "cols",
    "rows",
  ]);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`INVALID_REQUEST: unknown terminal ${action} parameter: ${unknown}`);
  }
  const dimension = (candidate: unknown, label: string) => {
    if (
      typeof candidate !== "number" ||
      !Number.isInteger(candidate) ||
      candidate < 1 ||
      candidate > 2000
    ) {
      throw new Error(`INVALID_REQUEST: ${label} must be an integer from 1 to 2000`);
    }
    return candidate;
  };
  if (
    value.cwd !== undefined &&
    (typeof value.cwd !== "string" || Buffer.byteLength(value.cwd, "utf8") > 4096)
  ) {
    throw new Error("INVALID_REQUEST: cwd must be a bounded string");
  }
  return {
    record: value,
    cwd: typeof value.cwd === "string" && value.cwd ? value.cwd : undefined,
    cols: dimension(value.cols, "cols"),
    rows: dimension(value.rows, "rows"),
  };
}

export function decodeNodePtyResumeParams(
  paramsJSON: string | null | undefined,
  validateThreadId: (value: unknown) => string,
): NodePtyResumeParams {
  const { record, ...params } = decodePtyParams(paramsJSON, "resume");
  return { threadId: validateThreadId(record.threadId), ...params };
}

export function decodeNodePtyStartParams(paramsJSON: string | null | undefined) {
  const { record, cwd, ...size } = decodePtyParams(paramsJSON, "start");
  if (
    record.initialMessage !== undefined &&
    (typeof record.initialMessage !== "string" || record.initialMessage.length > 16384)
  ) {
    throw new Error("INVALID_REQUEST: initialMessage must be a string of at most 16384 characters");
  }
  return {
    cwd: resolvePtyCwd(cwd, true),
    ...size,
    ...(typeof record.initialMessage === "string" ? { initialMessage: record.initialMessage } : {}),
  };
}

/** Runs one allowlisted plugin-owned command in an interactive node PTY. */
export async function runNodePtyCommand(
  params: {
    file: string;
    args: string[];
    cwd?: string;
    /** Fresh starts require the selected directory; resume retains its home fallback. */
    requiredCwd?: boolean;
    env?: Record<string, string>;
    pathEnv?: string;
    cols: number;
    rows: number;
  },
  io: OpenClawPluginNodeHostCommandIo,
  spawn: typeof spawnTerminalPty = spawnTerminalPty,
): Promise<NodePtyCommandResult> {
  if (io.signal.aborted) {
    return { exitCode: 130 };
  }
  const env = mergeProcessEnv([
    process.env,
    params.env,
    params.pathEnv ? { PATH: params.pathEnv } : undefined,
    { OPENCLAW_TERMINAL: "1" },
  ]);
  const pty = await spawn({
    file: params.file,
    args: params.args,
    cwd: resolvePtyCwd(params.cwd, params.requiredCwd),
    env,
    cols: params.cols,
    rows: params.rows,
  });
  let outputQueue = Promise.resolve();
  let settled = false;
  const kill = () => pty.kill();
  io.signal.addEventListener("abort", kill, { once: true });
  if (io.signal.aborted) {
    kill();
  }
  io.onInput((payloadJSON) => {
    if (settled || io.signal.aborted) {
      return;
    }
    const input = decodePtyInput(payloadJSON);
    try {
      if (input?.kind === "data") {
        pty.write(input.data);
      } else if (input?.kind === "resize") {
        pty.resize(input.cols, input.rows);
      }
    } catch {
      // Exit resolution owns teardown; input can race a dying native PTY.
    }
  });
  pty.onData((chunk) => {
    if (settled) {
      return;
    }
    pty.pause();
    outputQueue = outputQueue.then(() => io.emitChunk(chunk)).finally(() => pty.resume());
  });
  return await new Promise<NodePtyCommandResult>((resolve) => {
    pty.onExit((event) => {
      if (settled) {
        return;
      }
      settled = true;
      io.signal.removeEventListener("abort", kill);
      void outputQueue.finally(() =>
        resolve({
          exitCode: event.exitCode,
          ...(event.signal ? { signal: event.signal } : {}),
        }),
      );
    });
  });
}
