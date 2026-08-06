// CLI adapter for invoking native provider hooks through direct relay or gateway fallback.
import { readFileSync } from "node:fs";
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
} from "../agents/harness/native-hook-relay-client.js";
import type { NativeHookRelayProcessResponse } from "../agents/harness/native-hook-relay-types.js";
import type { CallGatewayOptions } from "../gateway/call.js";
import { ADMIN_SCOPE } from "../gateway/method-scopes.js";
import { setSafeTimeout } from "../utils/timer-delay.js";
import { parseTimeoutMsWithFallback } from "./parse-timeout.js";

const MAX_NATIVE_HOOK_STDIN_BYTES = 1024 * 1024;

/** User-facing flags for the native hook relay command. */
export type NativeHookRelayCliOptions = {
  provider?: string;
  relayId?: string;
  stateDb?: string;
  generation?: string;
  event?: string;
  preToolUseUnavailable?: string;
  timeout?: string;
};

type NativeHookRelayCliDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  invokeBridge?: typeof invokeNativeHookRelayBridge;
  callGateway?: CallGateway;
};

type CallGateway = <T = Record<string, unknown>>(opts: CallGatewayOptions) => Promise<T>;

const NATIVE_HOOK_RELAY_VALUE_FLAGS = {
  "--provider": "provider",
  "--relay-id": "relayId",
  "--state-db": "stateDb",
  "--generation": "generation",
  "--event": "event",
  "--pre-tool-use-unavailable": "preToolUseUnavailable",
  "--timeout": "timeout",
} as const satisfies Record<string, keyof NativeHookRelayCliOptions>;

type NativeHookRelayDeadline = {
  expiresAtMs: number;
  signal: AbortSignal;
  timeoutMs: number;
  dispose: () => void;
};

class NativeHookRelayDeadlineError extends Error {
  constructor(timeoutMs: number) {
    super(`native hook relay timed out after ${timeoutMs}ms`);
    this.name = "NativeHookRelayDeadlineError";
  }
}

/** Parse and run the internal native relay directly from the process argument vector. */
export async function runNativeHookRelayCliFromArgv(
  argv: string[],
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  return await runNativeHookRelayCli(parseNativeHookRelayCliOptions(argv), deps);
}

function parseNativeHookRelayCliOptions(argv: string[]): NativeHookRelayCliOptions {
  const relayIndex = argv.findIndex((arg, index) => arg === "relay" && argv[index - 1] === "hooks");
  if (relayIndex < 0) {
    throw new Error("native hook relay command path is required");
  }
  const opts: NativeHookRelayCliOptions = {};
  for (let index = relayIndex + 1; index < argv.length; index += 1) {
    const rawFlag = argv[index] ?? "";
    const equalsIndex = rawFlag.indexOf("=");
    const flag = equalsIndex > 0 ? rawFlag.slice(0, equalsIndex) : rawFlag;
    const key = NATIVE_HOOK_RELAY_VALUE_FLAGS[flag as keyof typeof NATIVE_HOOK_RELAY_VALUE_FLAGS];
    if (!key) {
      throw new Error(`unknown native hook relay option: ${rawFlag}`);
    }
    const value = equalsIndex > 0 ? rawFlag.slice(equalsIndex + 1) : argv[++index];
    if (!value) {
      throw new Error(`native hook relay option ${flag} requires a value`);
    }
    opts[key] = value;
  }
  return opts;
}

type ProcStatResult =
  | { status: "present"; startTime: number; ppid: number }
  | { status: "missing" }
  | { status: "unreadable" };

/**
 * Reads the starttime (clock ticks since boot) and ppid from /proc/[pid]/stat.
 *
 * Returns a discriminated status:
 * - "present" — the entry was read and the fields parsed successfully.
 * - "missing"  — the proc entry does not exist (ENOENT; process is gone).
 * - "unreadable" — the entry exists but cannot be read or parsed (transient
 *   I/O, EACCES, malformed content). The caller should retry, not exit.
 */
export function readProcStat(pid: number): ProcStatResult {
  try {
    const raw = readFileSync(`/proc/${pid}/stat`, "utf8");
    // /proc/[pid]/stat: pid (comm) state ppid ... starttime
    const closeParen = raw.lastIndexOf(")");
    if (closeParen < 0) {
      // Malformed /proc content — treat as unreadable since the entry existed
      // enough to produce output but could not be parsed.
      return { status: "unreadable" };
    }
    const fields = raw.slice(closeParen + 2).split(" ");
    // Validate field count — need at least 20 fields after comm for
    // ppid (index 1) and starttime (index 19).
    if (fields.length <= 19) {
      return { status: "unreadable" };
    }
    const ppid = Number(fields[1]);
    const startTime = Number(fields[19]);
    // Number() of an undefined or non-numeric entry produces NaN.
    // NaN !== NaN in the poll loop would take the PID-reuse branch
    // and exit a live relay. Reject non-numeric field values.
    if (!Number.isFinite(ppid) || !Number.isFinite(startTime) || startTime < 0) {
      return { status: "unreadable" };
    }
    return { status: "present", startTime, ppid };
  } catch (error) {
    // ENOENT means the /proc/[pid] directory is gone — the process exited.
    if (isNodeErrorCode(error, "ENOENT")) {
      return { status: "missing" };
    }
    // Any other error (EACCES, EIO, EAGAIN, etc.) is a transient read failure;
    // the process may still be alive.
    return { status: "unreadable" };
  }
}

function isNodeErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === code;
}

/**
 * On Linux, polls the relay's direct parent process identity and exits when
 * that parent disappears or is replaced. Hook relay helpers are spawned per
 * tool call by the Codex app-server. When the app-server is SIGKILLed
 * (cgroup OOM, container memory cap), the relay process is reparented to
 * PID 1 without cleanup.
 *
 * This watch covers the app-server-death path. The gateway-death path is
 * handled separately by the relay's own call timeout: when the gateway is
 * unreachable the bridge or gateway RPC times out and the relay exits
 * through the normal deadline path. The parent watch and the deadline are
 * complementary — each covers a different failure mode.
 *
 * A signal-0 existence probe (process.kill(pid, 0)) cannot distinguish the
 * original parent from an unrelated process that reused the same numeric
 * PID after the parent died. This watch instead compares the parent's
 * /proc/[pid]/stat start time against the value captured at startup so a
 * recycled PID or reparenting both trigger exit.
 */
export function installParentDeathWatchLinux(
  parentPid: number,
  deps?: { readProcStat?: typeof readProcStat },
): { dispose: () => void } {
  const read = deps?.readProcStat ?? readProcStat;
  const initial = read(parentPid);
  if (initial.status === "missing") {
    // Parent already gone; exit immediately.
    process.exit(0);
  }
  // On "unreadable" at startup, start the poll and retry — we cannot
  // confirm death. A persistent read failure will eventually be bounded
  // by the relay's own deadline.

  const pollMs = 5000;
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  const disposeTimer = () => {
    if (timer) {
      clearInterval(timer);
      timer = undefined;
    }
  };

  timer = setInterval(() => {
    if (disposed) {
      return;
    }
    const current = read(parentPid);
    if (current.status === "missing") {
      // /proc entry missing — parent process no longer exists.
      disposeTimer();
      process.exit(0);
      return;
    }
    if (current.status === "unreadable") {
      // Transient read failure — retry next poll interval.
      return;
    }
    if (initial.status === "present" && current.startTime !== initial.startTime) {
      // Start time changed — the original parent died and this PID was
      // recycled for an unrelated process.
      disposeTimer();
      process.exit(0);
      return;
    }
    // Detect reparenting: when the parent dies the kernel reparents the
    // orphan to PID 1 (or a subreaper). Self-stat ppid is live (unlike
    // cached process.ppid).
    const self = read(process.pid);
    if (self.status === "present" && self.ppid !== parentPid) {
      disposeTimer();
      process.exit(0);
    }
  }, pollMs);
  timer.unref();

  return {
    dispose: () => {
      disposed = true;
      disposeTimer();
    },
  };
}

/** Run one native hook relay invocation from stdin JSON to stdout/stderr response streams. */
export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  // Start parent-death watch on Linux so this relay process exits when the
  // spawning Codex app-server is SIGKILLed (container OOM, cgroup cap).
  // The relay's own deadline handles the gateway-unreachable case separately.
  const parentDeathWatch =
    process.platform === "linux" ? installParentDeathWatchLinux(process.ppid) : undefined;

  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const invokeBridge = deps.invokeBridge ?? invokeNativeHookRelayBridge;
  const callGatewayFn = deps.callGateway ?? callGatewayLazy;
  const provider = readRequiredOption(opts.provider, "provider");
  const relayId = readRequiredOption(opts.relayId, "relay-id");
  const generation = opts.generation?.trim() || undefined;
  const event = readRequiredOption(opts.event, "event");
  let timeoutMs: number;
  try {
    timeoutMs = parseTimeoutMsWithFallback(opts.timeout, 5_000);
  } catch (error) {
    writeText(stderr, formatRelayCliError("invalid native hook timeout", error));
    return 1;
  }

  const deadline = createNativeHookRelayDeadline(timeoutMs);
  try {
    let rawPayload: unknown;
    try {
      const rawInput = await readStreamText(stdin, MAX_NATIVE_HOOK_STDIN_BYTES, deadline);
      rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return writeNativeHookRelayDeadlineResponse({
          stdout,
          stderr,
          opts,
          provider,
          event,
          error,
        });
      }
      writeText(stderr, formatRelayCliError("failed to read native hook input", error));
      return 1;
    }

    try {
      const remainingMs = remainingNativeHookRelayDeadlineMs(deadline);
      const response = await withNativeHookRelayDeadline(
        deadline,
        invokeBridge({
          provider,
          relayId,
          stateDbPath: opts.stateDb?.trim() || undefined,
          generation,
          event,
          rawPayload,
          registrationTimeoutMs: Math.min(100, remainingMs),
          timeoutMs: remainingMs,
        }),
      );
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return writeNativeHookRelayDeadlineResponse({
          stdout,
          stderr,
          opts,
          provider,
          event,
          error,
        });
      }
      if (isNativeHookRelayBridgeStaleRegistrationError(error)) {
        writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
        return writeNativeHookRelayUnavailableResponse({ stdout, stderr, opts, provider, event });
      }
      // Fall through to the gateway path for embedded/local gateway cases and
      // older registrations that predate the direct relay bridge.
    }

    try {
      const response = await withNativeHookRelayDeadline(
        deadline,
        callGatewayFn<NativeHookRelayProcessResponse>({
          method: "nativeHook.invoke",
          params: { provider, relayId, generation, event, rawPayload },
          timeoutMs: remainingNativeHookRelayDeadlineMs(deadline),
          signal: deadline.signal,
          scopes: [ADMIN_SCOPE],
        }),
      );
      writeText(stdout, response.stdout);
      writeText(stderr, response.stderr);
      return response.exitCode;
    } catch (error) {
      if (isNativeHookRelayDeadlineError(error)) {
        return writeNativeHookRelayDeadlineResponse({
          stdout,
          stderr,
          opts,
          provider,
          event,
          error,
        });
      }
      writeText(stderr, formatRelayCliError("native hook relay unavailable", error));
      return writeNativeHookRelayUnavailableResponse({ stdout, stderr, opts, provider, event });
    }
  } finally {
    deadline.dispose();
    parentDeathWatch?.dispose();
  }
}

async function callGatewayLazy<T = Record<string, unknown>>(opts: CallGatewayOptions): Promise<T> {
  const { callGateway } = await import("../gateway/call.js");
  return await callGateway<T>(opts);
}

function readRequiredOption(value: string | undefined, name: string): string {
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  throw new Error(`Missing required option --${name}`);
}

async function readStreamText(
  stream: NodeJS.ReadableStream,
  maxBytes: number,
  deadline: NativeHookRelayDeadline,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const abortRead = () => {
    destroyReadableStream(stream, createNativeHookRelayDeadlineError(deadline));
  };
  deadline.signal.addEventListener("abort", abortRead, { once: true });
  try {
    throwIfNativeHookRelayDeadlineExpired(deadline);
    for await (const chunk of stream) {
      throwIfNativeHookRelayDeadlineExpired(deadline);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > maxBytes) {
        throw new Error(`native hook input exceeds ${maxBytes} bytes`);
      }
      chunks.push(buffer);
    }
    throwIfNativeHookRelayDeadlineExpired(deadline);
    return Buffer.concat(chunks, total).toString("utf8");
  } catch (error) {
    if (isNativeHookRelayDeadlineError(error) || deadline.signal.aborted) {
      throw createNativeHookRelayDeadlineError(deadline);
    }
    throw error;
  } finally {
    deadline.signal.removeEventListener("abort", abortRead);
  }
}

function writeText(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

function formatRelayCliError(prefix: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${prefix}: ${message}\n`;
}

function createNativeHookRelayDeadline(timeoutMs: number): NativeHookRelayDeadline {
  const controller = new AbortController();
  const timer = setSafeTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    expiresAtMs: Date.now() + timeoutMs,
    signal: controller.signal,
    timeoutMs,
    dispose: () => clearTimeout(timer),
  };
}

function createNativeHookRelayDeadlineError(
  deadline: NativeHookRelayDeadline,
): NativeHookRelayDeadlineError {
  return new NativeHookRelayDeadlineError(deadline.timeoutMs);
}

function isNativeHookRelayDeadlineError(error: unknown): error is NativeHookRelayDeadlineError {
  return error instanceof Error && error.name === "NativeHookRelayDeadlineError";
}

function remainingNativeHookRelayDeadlineMs(deadline: NativeHookRelayDeadline): number {
  const remainingMs = deadline.expiresAtMs - Date.now();
  if (remainingMs <= 0 || deadline.signal.aborted) {
    throw createNativeHookRelayDeadlineError(deadline);
  }
  return Math.max(1, remainingMs);
}

function throwIfNativeHookRelayDeadlineExpired(deadline: NativeHookRelayDeadline): void {
  void remainingNativeHookRelayDeadlineMs(deadline);
}

function destroyReadableStream(stream: NodeJS.ReadableStream, error: Error): void {
  const destroy = (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void }).destroy;
  if (typeof destroy === "function") {
    destroy.call(stream, error);
    return;
  }
  stream.pause();
}

async function withNativeHookRelayDeadline<T>(
  deadline: NativeHookRelayDeadline,
  promise: Promise<T>,
): Promise<T> {
  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = () => deadline.signal.removeEventListener("abort", abort);
    const abort = () => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(createNativeHookRelayDeadlineError(deadline));
    };
    deadline.signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
    if (deadline.signal.aborted || deadline.expiresAtMs <= Date.now()) {
      abort();
    }
  });
}

function writeNativeHookRelayUnavailableResponse(params: {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  opts: NativeHookRelayCliOptions;
  provider: string;
  event: string;
  message?: string;
}): number {
  const response = renderNativeHookRelayUnavailableResponse({
    provider: params.provider,
    event: params.event,
    preToolUseUnavailable: params.opts.preToolUseUnavailable,
    message: params.message ?? "Native hook relay unavailable",
  });
  writeText(params.stdout, response.stdout);
  writeText(params.stderr, response.stderr);
  return response.exitCode;
}

function writeNativeHookRelayDeadlineResponse(params: {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
  opts: NativeHookRelayCliOptions;
  provider: string;
  event: string;
  error: NativeHookRelayDeadlineError;
}): number {
  writeText(params.stderr, formatRelayCliError("native hook relay timed out", params.error));
  return writeNativeHookRelayUnavailableResponse({
    stdout: params.stdout,
    stderr: params.stderr,
    opts: params.opts,
    provider: params.provider,
    event: params.event,
    message: "Native hook relay timed out",
  });
}
