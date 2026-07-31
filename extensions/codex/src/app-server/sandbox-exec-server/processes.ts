/**
 * Manages subprocess lifecycle, streaming output buffers, stdin writes, and
 * termination for Codex sandbox exec-server process RPCs.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { embeddedAgentLog } from "openclaw/plugin-sdk/agent-harness-runtime";
import type { WebSocket } from "ws";
import type { JsonObject, JsonValue } from "../protocol.js";
import { requireObject, requireString, requireStringArray } from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import type { ManagedProcess, OpenClawExecServer, ProcessChunk } from "./types.js";

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RETAINED_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const CLOSED_PROCESS_EVICTION_MS = 60_000;

/** Starts a sandbox-backed process and registers it in the connection-local process table. */
export async function startProcess(
  execServer: OpenClawExecServer,
  processes: Map<string, ManagedProcess>,
  socket: WebSocket,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/start params");
  const processId = requireString(record.processId, "processId");
  if (processes.has(processId)) {
    throw new Error(`process already exists: ${processId}`);
  }
  const argv = requireStringArray(record.argv, "argv");
  const cwd = resolveExecServerPath(requireString(record.cwd, "cwd"), "process cwd");
  rejectUnsupportedArg0(record.arg0);
  const env = readProcessEnv(record);
  const tty = record.tty === true;
  const pipeStdin = record.pipeStdin === true;
  const managed: ManagedProcess = {
    processId,
    chunks: [],
    retainedOutputBytes: 0,
    nextSeq: 1,
    exited: false,
    exitCode: null,
    closed: false,
    failure: null,
    tty,
    pipeStdin,
    abortController: new AbortController(),
    child: null,
    finalized: false,
    waiters: [],
    emitNotification: (method, notificationParams) => {
      if (socket.readyState === 1) {
        socket.send(JSON.stringify({ jsonrpc: "2.0", method, params: notificationParams }));
      }
    },
    evictProcess: () => {
      if (managed.evictionTimer) {
        return;
      }
      managed.evictionTimer = setTimeout(() => {
        if (processes.get(processId) === managed && managed.closed) {
          processes.delete(processId);
        }
      }, CLOSED_PROCESS_EVICTION_MS);
      managed.evictionTimer.unref?.();
    },
  };
  processes.set(processId, managed);
  try {
    await runProcess(execServer, managed, { argv, cwd, env });
  } catch (error) {
    processes.delete(processId);
    managed.failure = error instanceof Error ? error.message : String(error);
    managed.exitCode = null;
    managed.exited = true;
    managed.closed = true;
    notifyProcessWaiters(managed);
    throw error;
  }
  return { processId };
}

async function runProcess(
  execServer: OpenClawExecServer,
  managed: ManagedProcess,
  params: { argv: string[]; cwd: string; env: Record<string, string> },
): Promise<void> {
  const backend = execServer.sandbox.backend;
  if (!backend) {
    throw new Error("OpenClaw sandbox backend is unavailable.");
  }
  throwIfProcessStartCancelled(managed);
  const execSpec = await backend.buildExecSpec({
    command: shellCommandFromArgv(params.argv),
    workdir: params.cwd,
    env: params.env,
    // This bridge currently owns only pipe-backed child processes. Asking the
    // backend for a PTY can produce commands such as `docker exec -t`, which
    // require this process itself to own a real TTY.
    usePty: false,
  });
  managed.finalizeToken = execSpec.finalizeToken;
  managed.finalizeExec = backend.finalizeExec;
  let child: ChildProcessWithoutNullStreams;
  try {
    if (managed.abortController.signal.aborted) {
      throw new Error("process start cancelled");
    }
    const [command, ...args] = execSpec.argv;
    if (!command) {
      throw new Error("OpenClaw sandbox exec spec did not provide a command.");
    }
    child = spawn(command, args, {
      env: execSpec.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    managed.failure = error instanceof Error ? error.message : String(error);
    await finalizeProcess(managed).catch((finalizeError: unknown) => {
      embeddedAgentLog.warn("codex sandbox exec-server finalize after start failure failed", {
        processId: managed.processId,
        error: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
      });
    });
    throw error;
  }
  managed.child = child;
  const abortListener = () => child.kill("SIGTERM");
  managed.abortController.signal.addEventListener("abort", abortListener, { once: true });
  child.stdout.on("data", (chunk: Buffer) =>
    appendProcessChunk(managed, managed.tty ? "pty" : "stdout", chunk),
  );
  child.stderr.on("data", (chunk: Buffer) => appendProcessChunk(managed, "stderr", chunk));
  child.once("error", (error) => {
    // Node can report an abort or transport error before the child exits. The
    // backend lease and Codex terminal notifications stay owned until close.
    managed.failure ??= error.message;
    notifyProcessWaiters(managed);
  });
  child.once("close", (code) => {
    managed.abortController.signal.removeEventListener("abort", abortListener);
    emitProcessClosed(managed, code ?? 1);
  });
  if (!managed.tty && !managed.pipeStdin) {
    child.stdin.end();
  }
}

function throwIfProcessStartCancelled(managed: ManagedProcess): void {
  if (managed.abortController.signal.aborted) {
    throw new Error("process start cancelled");
  }
}

function appendProcessChunk(
  managed: ManagedProcess,
  stream: ProcessChunk["stream"],
  data: Buffer,
): void {
  if (data.length === 0) {
    return;
  }
  const chunk = {
    seq: managed.nextSeq,
    stream,
    chunk: data.toString("base64"),
  };
  managed.chunks.push(chunk);
  managed.retainedOutputBytes += data.length;
  // Keep enough recent output for polling clients without letting long-running
  // processes grow the app-server bridge memory without bound.
  while (managed.retainedOutputBytes > RETAINED_PROCESS_OUTPUT_BYTES && managed.chunks.length > 1) {
    const removed = managed.chunks.shift();
    if (!removed) {
      break;
    }
    managed.retainedOutputBytes -= Buffer.from(removed.chunk, "base64").byteLength;
  }
  managed.nextSeq += 1;
  managed.emitNotification("process/output", {
    processId: managed.processId,
    seq: chunk.seq,
    stream: chunk.stream,
    chunk: chunk.chunk,
  });
  notifyProcessWaiters(managed);
}

function emitProcessClosed(managed: ManagedProcess, exitCode: number | null): void {
  if (!managed.exited) {
    const exitSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.exitCode = exitCode;
    managed.exited = true;
    if (exitCode !== null) {
      managed.emitNotification("process/exited", {
        processId: managed.processId,
        seq: exitSeq,
        exitCode,
      });
    }
  }
  if (!managed.closed) {
    const closeSeq = managed.nextSeq;
    managed.nextSeq += 1;
    managed.closed = true;
    managed.emitNotification("process/closed", {
      processId: managed.processId,
      seq: closeSeq,
    });
  }
  void finalizeProcess(managed).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    managed.failure ??= message;
    embeddedAgentLog.warn("codex sandbox exec-server finalize failed", {
      processId: managed.processId,
      error: message,
    });
  });
  // Closed processes stay briefly readable so clients that observe close before
  // their final poll can still drain exit/output state.
  managed.evictProcess();
  notifyProcessWaiters(managed);
}

async function finalizeProcess(managed: ManagedProcess): Promise<void> {
  if (managed.finalized) {
    return;
  }
  managed.finalized = true;
  managed.child?.stdin.destroy();
  await managed.finalizeExec?.({
    status: managed.failure ? "failed" : "completed",
    exitCode: managed.exitCode,
    timedOut: false,
    token: managed.finalizeToken,
  });
}

function limitProcessChunks(chunks: ProcessChunk[], maxBytes: number | undefined): ProcessChunk[] {
  if (!maxBytes) {
    return chunks;
  }
  const retained: ProcessChunk[] = [];
  let retainedBytes = 0;
  for (const chunk of chunks) {
    const byteLength = Buffer.from(chunk.chunk, "base64").byteLength;
    if (retained.length > 0 && retainedBytes + byteLength > maxBytes) {
      break;
    }
    retained.push(chunk);
    retainedBytes += byteLength;
    if (retainedBytes >= maxBytes) {
      break;
    }
  }
  return retained;
}

/** Reads buffered process output, optionally waiting for new output or process close. */
export async function readProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "process/read params");
  const processId = requireString(record.processId, "processId");
  const managed = requireProcess(processes, processId);
  const afterSeq = typeof record.afterSeq === "number" ? record.afterSeq : 0;
  const waitMs = typeof record.waitMs === "number" && record.waitMs > 0 ? record.waitMs : 0;
  if (!managed.exited && !hasChunksAtOrAfter(managed, afterSeq) && waitMs > 0) {
    await waitForProcessUpdate(managed, waitMs);
  }
  const chunks = limitProcessChunks(
    managed.chunks.filter((chunk) => chunk.seq > afterSeq),
    typeof record.maxBytes === "number" && record.maxBytes > 0 ? record.maxBytes : undefined,
  );
  const lastChunk = chunks.at(-1);
  return {
    chunks,
    nextSeq: lastChunk ? lastChunk.seq + 1 : managed.nextSeq,
    exited: managed.exited,
    exitCode: managed.exitCode,
    closed: managed.closed,
    failure: managed.failure,
  };
}

/** Writes base64 stdin data to a running process when stdin is still open. */
export function writeProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "process/write params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { status: "unknownProcess" };
  }
  const chunk = Buffer.from(requireString(record.chunk, "chunk"), "base64");
  if ((!managed.tty && !managed.pipeStdin) || managed.closed || !managed.child?.stdin.writable) {
    return { status: "stdinClosed" };
  }
  managed.child.stdin.write(chunk);
  return { status: "accepted" };
}

/** Requests process termination and reports whether it was running at call time. */
export function terminateProcess(
  processes: Map<string, ManagedProcess>,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "process/terminate params");
  const processId = requireString(record.processId, "processId");
  const managed = processes.get(processId);
  if (!managed) {
    return { running: false };
  }
  const running = !managed.exited;
  managed.abortController.abort();
  managed.child?.kill("SIGTERM");
  if (running && !managed.child) {
    emitProcessClosed(managed, null);
  }
  return { running };
}

function waitForProcessUpdate(managed: ManagedProcess, waitMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, Math.min(waitMs, 30_000));
    function done() {
      clearTimeout(timer);
      managed.waiters = managed.waiters.filter((waiter) => waiter !== done);
      resolve();
    }
    managed.waiters.push(done);
  });
}

function notifyProcessWaiters(managed: ManagedProcess): void {
  const waiters = managed.waiters;
  managed.waiters = [];
  for (const waiter of waiters) {
    waiter();
  }
}

function hasChunksAtOrAfter(managed: ManagedProcess, afterSeq: number): boolean {
  return managed.chunks.some((chunk) => chunk.seq > afterSeq);
}

function shellCommandFromArgv(argv: string[]): string {
  return argv.map(shellEscape).join(" ");
}

function shellEscape(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function requireProcess(processes: Map<string, ManagedProcess>, processId: string): ManagedProcess {
  const managed = processes.get(processId);
  if (!managed) {
    throw new Error(`unknown process: ${processId}`);
  }
  return managed;
}

function rejectUnsupportedArg0(value: unknown): void {
  if (value === undefined || value === null) {
    return;
  }
  if (typeof value === "string") {
    throw new Error("Codex sandbox exec-server does not support arg0 overrides.");
  }
  throw new Error("arg0 must be a string or null.");
}

function readEnv(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const env: Record<string, string> = {};
  for (const [key, rawValue] of Object.entries(value)) {
    if (typeof rawValue === "string" && ENV_KEY_RE.test(key)) {
      env[key] = rawValue;
    }
  }
  return env;
}

function readProcessEnv(record: JsonObject): Record<string, string> {
  const policyEnv = buildEnvFromPolicy(record.envPolicy);
  return {
    ...policyEnv,
    ...readEnv(record.env),
  };
}

function buildEnvFromPolicy(value: unknown): Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const policy = value as Record<string, unknown>;
  const inheritedEnv = readEnv(policy.set);
  const includeOnly = readStringList(policy.includeOnly);
  if (includeOnly.length > 0) {
    filterEnvKeys(inheritedEnv, includeOnly, true);
  }
  return inheritedEnv;
}

function filterEnvKeys(
  env: Record<string, string>,
  patterns: string[],
  keepMatches: boolean,
): void {
  if (patterns.length === 0) {
    return;
  }
  const regexes = patterns.map((pattern) => wildcardPatternToRegex(pattern));
  for (const key of Object.keys(env)) {
    const matches = regexes.some((regex) => regex.test(key));
    if (matches !== keepMatches) {
      delete env[key];
    }
  }
}

function wildcardPatternToRegex(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, "\\$&");
  return new RegExp(`^${escaped.replaceAll("*", ".*").replaceAll("?", ".")}$`, "iu");
}

function readStringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}
