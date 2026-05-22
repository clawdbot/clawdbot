import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import type { WebSocketServer } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";

export type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: JsonValue;
};

export type ProcessChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  chunk: string;
};

export type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

export type FsAccessMode = "read" | "write" | "none";

export type ResolvedFsSandboxEntry =
  | {
      kind: "path";
      path: string;
      access: FsAccessMode;
    }
  | {
      kind: "glob";
      pattern: string;
      matcher: RegExp;
      literalPrefix: string;
      access: FsAccessMode;
    };

export type ResolvedFsSandboxPolicy = {
  unrestricted: boolean;
  entries: ResolvedFsSandboxEntry[];
};

export type HttpHeader = {
  name: string;
  value: string;
};

export type ManagedProcess = {
  processId: string;
  chunks: ProcessChunk[];
  retainedOutputBytes: number;
  nextSeq: number;
  exited: boolean;
  exitCode: number | null;
  closed: boolean;
  failure: string | null;
  tty: boolean;
  pipeStdin: boolean;
  abortController: AbortController;
  child: ChildProcessWithoutNullStreams | null;
  finalizeToken?: unknown;
  finalizeExec?: NonNullable<SandboxContext["backend"]>["finalizeExec"];
  finalized: boolean;
  evictionTimer?: ReturnType<typeof setTimeout>;
  waiters: Array<() => void>;
  emitNotification: (method: string, params: JsonObject) => void;
  evictProcess: () => void;
};

export type OpenClawExecServer = {
  environmentId: string;
  authPath: string;
  refCount: number;
  closed: boolean;
  url: string;
  sandbox: SandboxContext;
  server: WebSocketServer;
};
