import type { TerminalUploadFile, TerminalUploadResult } from "../../infra/terminal-file-upload.js";
import type { LocalTerminalBackendSpawner, TerminalBackend } from "./backend.js";
import type { TerminalOutputController } from "./output-flow-control.js";
import type { TerminalOutputRing } from "./output-ring.js";

export type TerminalEventSink = (connId: string, event: string, payload: unknown) => void;

export type TerminalExitReason = "process_exit" | "closed" | "disconnected" | "detached" | "error";

export type TerminalOwner =
  | { kind: "conn"; connId: string }
  | { kind: "agent"; agentSessionKey: string };

export type TerminalSession = {
  id: string;
  /** Null only while a connection-owned session is detached. */
  owner: TerminalOwner | null;
  /** Operator connections co-attached to an agent-owned session. */
  viewers: Set<string>;
  agentId: string;
  cwd: string;
  shell: string;
  backend: TerminalBackend;
  stageUpload: (file: TerminalUploadFile) => Promise<TerminalUploadResult>;
  closed: boolean;
  createdAtMs: number;
  buffer: TerminalOutputRing;
  output: TerminalOutputController;
  /** Kills the session when a detach outlives the grace period. */
  reaper: ReturnType<typeof setTimeout> | null;
  detachedAtMs: number | null;
};

export type TerminalSessionManagerOptions = {
  emit: TerminalEventSink;
  getBufferedAmount?: (connId: string) => number | undefined;
  spawn?: LocalTerminalBackendSpawner;
  maxSessions?: number;
  env?: NodeJS.ProcessEnv;
  /** Detach grace; 0 preserves kill-on-disconnect. Gateway wiring owns its default. */
  detachGraceMs?: number;
  maxDetachedSessions?: number;
  scrollbackChars?: number;
};

export type TerminalOpenRequest = {
  owner: TerminalOwner;
  agentId: string;
  cwd: string;
  shell: string;
  args: string[];
  cols: number;
  rows: number;
  env: Record<string, string>;
  /** Request-scoped cancellation; a late backend is killed before registration. */
  signal?: AbortSignal;
  createBackend?: () => Promise<TerminalBackend>;
  stageUpload?: (file: TerminalUploadFile) => Promise<TerminalUploadResult>;
};

export type TerminalOpenOutcome =
  | { ok: true; sessionId: string; agentId: string; cwd: string; shell: string }
  | { ok: false; code: "limit" | "spawn_failed" | "closed"; message: string };

/** Abort state shared between a pending open and lifecycle/policy teardown. */
export type TerminalPendingOpen = {
  agentId: string;
  abortMessage?: string;
  abort(message: string): void;
};
