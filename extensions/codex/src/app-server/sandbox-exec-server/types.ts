/**
 * Shared protocol and runtime state types for the Codex sandbox exec-server
 * WebSocket bridge.
 */
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import type { SandboxContext } from "openclaw/plugin-sdk/sandbox";
import type { WebSocketServer } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";

/** Minimal JSON-RPC request shape accepted by the sandbox exec-server. */
export type JsonRpcRequest = {
  id?: string | number;
  method?: string;
  params?: JsonValue;
};

/** Buffered process output chunk retained for polling and stream replay. */
export type ProcessChunk = {
  seq: number;
  stream: "stdout" | "stderr" | "pty";
  chunk: string;
};

/** Directory entry metadata returned through the sandbox filesystem bridge. */
export type DirectoryEntry = {
  fileName: string;
  isDirectory: boolean;
  isFile: boolean;
};

/** Access level granted by resolved sandbox filesystem policy. */
export type FsAccessMode = "read" | "write" | "none";

/** Normalized filesystem sandbox policy entry, either literal path or glob matcher. */
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

/** Fully resolved filesystem sandbox policy for one exec-server environment. */
export type ResolvedFsSandboxPolicy = {
  unrestricted: boolean;
  entries: ResolvedFsSandboxEntry[];
};

/** Header pair accepted by sandboxed HTTP requests. */
export type HttpHeader = {
  name: string;
  value: string;
};

/** Runtime state for one process launched through the sandbox exec-server. */
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

/** Shared exec-server instance leased by Codex native sandbox environments. */
export type OpenClawExecServer = {
  environmentId: string;
  authPath: string;
  refCount: number;
  closed: boolean;
  url: string;
  sandbox: SandboxContext;
  server: WebSocketServer;
};
