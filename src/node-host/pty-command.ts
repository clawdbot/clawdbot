import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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

function resolvePtyCwd(candidate?: string): string {
  if (candidate && path.isAbsolute(candidate)) {
    try {
      if (fs.statSync(candidate).isDirectory()) {
        return candidate;
      }
    } catch {
      // Missing/unreadable catalog cwd falls back to the node user's home.
    }
  }
  return os.homedir();
}

function decodePtyInput(payloadJSON: string): NodePtyInput | null {
  try {
    const value = JSON.parse(payloadJSON) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const input = value as Record<string, unknown>;
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

export function decodeNodePtyResumeParams(
  paramsJSON: string | null | undefined,
  validateThreadId: (value: unknown) => string,
): NodePtyResumeParams {
  let value: unknown;
  try {
    value = JSON.parse(paramsJSON ?? "");
  } catch {
    throw new Error("INVALID_REQUEST: terminal resume params must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("INVALID_REQUEST: terminal resume params must be an object");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(["threadId", "cwd", "cols", "rows"]);
  const unknown = Object.keys(record).find((key) => !allowed.has(key));
  if (unknown) {
    throw new Error(`INVALID_REQUEST: unknown terminal resume parameter: ${unknown}`);
  }
  const dimension = (candidate: unknown, label: string) => {
    if (!Number.isInteger(candidate) || (candidate as number) < 1 || (candidate as number) > 2000) {
      throw new Error(`INVALID_REQUEST: ${label} must be an integer from 1 to 2000`);
    }
    return candidate as number;
  };
  if (
    record.cwd !== undefined &&
    (typeof record.cwd !== "string" || Buffer.byteLength(record.cwd, "utf8") > 4096)
  ) {
    throw new Error("INVALID_REQUEST: cwd must be a bounded string");
  }
  return {
    threadId: validateThreadId(record.threadId),
    ...(typeof record.cwd === "string" && record.cwd ? { cwd: record.cwd } : {}),
    cols: dimension(record.cols, "cols"),
    rows: dimension(record.rows, "rows"),
  };
}

/** Runs one allowlisted plugin-owned command in an interactive node PTY. */
export async function runNodePtyCommand(
  params: {
    file: string;
    args: string[];
    cwd?: string;
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
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  env.TERM ??= "xterm-256color";
  env.OPENCLAW_TERMINAL = "1";
  if (params.pathEnv) {
    env.PATH = params.pathEnv;
  }
  const pty = await spawn({
    file: params.file,
    args: params.args,
    cwd: resolvePtyCwd(params.cwd),
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
