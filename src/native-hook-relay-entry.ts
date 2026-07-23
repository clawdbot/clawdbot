#!/usr/bin/env node
// Minimal native-hook transport. Policy remains in the long-lived Gateway.
import { request as httpRequest } from "node:http";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import {
  renderCodexNativeHookUnavailableResponse,
  type NativeHookRelayResponseEvent,
  type NativeHookRelayWireResponse,
} from "./agents/harness/native-hook-relay-response.js";

const MAX_STDIN_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 5_000;
const REGISTRATION_RETRY_MS = 100;
const STALE_RETRY_MS = 250;
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
const EVENTS = new Set<NativeHookRelayResponseEvent>([
  "pre_tool_use",
  "post_tool_use",
  "permission_request",
  "before_agent_finalize",
]);

export type FastRelayOptions = {
  provider: string;
  relayId: string;
  stateDb: string;
  stateSchemaVersion: number;
  generation?: string;
  event: NativeHookRelayResponseEvent;
  preToolUseUnavailable?: "noop";
  timeoutMs: number;
};

type FastRelayRecord = {
  relayId: string;
  pid: number;
  hostname: "127.0.0.1";
  port: number;
  token: string;
  expiresAtMs: number;
};

export type FastRelayDeps = {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
  now?: () => number;
  readRecord?: (options: FastRelayOptions) => FastRelayRecord;
  post?: (params: {
    record: FastRelayRecord;
    body: string;
    timeoutMs: number;
    signal: AbortSignal;
  }) => Promise<NativeHookRelayWireResponse>;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  fallback?: (
    options: FastRelayOptions,
    rawInput: string,
    streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
    timeoutMs: number,
  ) => Promise<number>;
};

class FastRelayError extends Error {
  constructor(
    readonly code: "overloaded" | "stale",
    errorMessage: string,
  ) {
    super(errorMessage);
    this.name = "FastRelayError";
  }
}

type Deadline = {
  expiresAtMs: number;
  signal: AbortSignal;
  timeoutMs: number;
  dispose: () => void;
};

export function parseNativeHookRelayEntryArgs(argv: string[]): FastRelayOptions {
  const values = new Map<string, string>();
  const allowed = new Set([
    "--provider",
    "--relay-id",
    "--state-db",
    "--state-schema-version",
    "--generation",
    "--event",
    "--pre-tool-use-unavailable",
    "--timeout",
  ]);
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag || !allowed.has(flag) || value === undefined || value.startsWith("--")) {
      throw new Error(`invalid native hook relay argument: ${flag ?? "<missing>"}`);
    }
    if (values.has(flag)) {
      throw new Error(`duplicate native hook relay argument: ${flag}`);
    }
    values.set(flag, value);
  }
  const provider = required(values, "--provider");
  if (provider !== "codex") {
    throw new Error(`unsupported native hook relay provider: ${provider}`);
  }
  const event = required(values, "--event");
  if (!EVENTS.has(event as NativeHookRelayResponseEvent)) {
    throw new Error(`unsupported native hook relay event: ${event}`);
  }
  const stateSchemaVersion = positiveInteger(
    required(values, "--state-schema-version"),
    "state schema version",
  );
  const timeoutMs = positiveInteger(
    values.get("--timeout") ?? String(DEFAULT_TIMEOUT_MS),
    "timeout",
  );
  const preToolUseUnavailable = values.get("--pre-tool-use-unavailable");
  if (preToolUseUnavailable !== undefined && preToolUseUnavailable !== "noop") {
    throw new Error(`unsupported pre-tool-use unavailable behavior: ${preToolUseUnavailable}`);
  }
  return {
    provider,
    relayId: required(values, "--relay-id"),
    stateDb: required(values, "--state-db"),
    stateSchemaVersion,
    ...(values.get("--generation") ? { generation: values.get("--generation") } : {}),
    event: event as NativeHookRelayResponseEvent,
    ...(preToolUseUnavailable ? { preToolUseUnavailable } : {}),
    timeoutMs,
  };
}

export async function runNativeHookRelayEntry(
  options: FastRelayOptions,
  deps: FastRelayDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const now = deps.now ?? Date.now;
  const deadline = createDeadline(options.timeoutMs, now);
  let rawInput: string;
  try {
    rawInput = await readBoundedInput(stdin, deadline, now);
  } catch (error) {
    if (deadline.signal.aborted) {
      return writeUnavailable(options, stdout, stderr, "Native hook relay timed out", error);
    }
    write(stderr, `failed to read native hook input: ${message(error)}\n`);
    deadline.dispose();
    return 1;
  }

  try {
    const rawPayload = rawInput.trim() ? JSON.parse(rawInput) : null;
    const body = JSON.stringify({
      provider: options.provider,
      relayId: options.relayId,
      generation: options.generation,
      event: options.event,
      rawPayload,
    });
    const response = await invokeFastRelay(options, body, deadline, now, deps);
    write(stdout, response.stdout);
    write(stderr, response.stderr);
    return response.exitCode;
  } catch (error) {
    if (deadline.signal.aborted) {
      return writeUnavailable(options, stdout, stderr, "Native hook relay timed out", error);
    }
    if (isFastRelayError(error, "overloaded") || isFastRelayError(error, "stale")) {
      const unavailable = isFastRelayError(error, "overloaded")
        ? "Native hook relay overloaded"
        : "Native hook relay unavailable";
      return writeUnavailable(options, stdout, stderr, unavailable, error);
    }
    try {
      const remainingMs = remaining(deadline, now);
      const fallback = deps.fallback ?? runFullRelayFallback;
      return await fallback(options, rawInput, { stdout, stderr }, remainingMs);
    } catch (fallbackError) {
      const unavailable = deadline.signal.aborted
        ? "Native hook relay timed out"
        : "Native hook relay unavailable";
      return writeUnavailable(options, stdout, stderr, unavailable, fallbackError);
    }
  } finally {
    deadline.dispose();
  }
}

async function invokeFastRelay(
  options: FastRelayOptions,
  body: string,
  deadline: Deadline,
  now: () => number,
  deps: FastRelayDeps,
): Promise<NativeHookRelayWireResponse> {
  const startedAt = now();
  for (;;) {
    try {
      const record = (deps.readRecord ?? readFastRelayRecord)(options);
      if (now() > record.expiresAtMs) {
        throw new Error("native hook relay bridge expired");
      }
      return await (deps.post ?? postFastRelay)({
        record,
        body,
        timeoutMs: remaining(deadline, now),
        signal: deadline.signal,
      });
    } catch (error) {
      if (isFastRelayError(error, "overloaded")) {
        throw error;
      }
      const elapsedMs = now() - startedAt;
      const retryable = isRetryable(error);
      const stale = isFastRelayError(error, "stale");
      if (
        (!retryable || elapsedMs >= REGISTRATION_RETRY_MS) &&
        (!stale || elapsedMs >= STALE_RETRY_MS)
      ) {
        throw error;
      }
      await (deps.sleep ?? delay)(Math.min(10, remaining(deadline, now)), deadline.signal);
    }
  }
}

function readFastRelayRecord(options: FastRelayOptions): FastRelayRecord {
  const db = new DatabaseSync(path.resolve(options.stateDb), {
    readOnly: true,
  });
  try {
    db.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS};`);
    const versionRow = db.prepare("PRAGMA user_version").get() as
      | { user_version?: unknown }
      | undefined;
    const version = versionRow?.user_version;
    if (typeof version !== "number" || version > options.stateSchemaVersion) {
      throw new Error("unsupported OpenClaw state database schema");
    }
    const row = db
      .prepare(
        "SELECT relay_id, pid, hostname, port, token, expires_at_ms FROM native_hook_relay_bridges WHERE relay_id = ?",
      )
      .get(options.relayId) as Record<string, unknown> | undefined;
    if (
      row?.relay_id !== options.relayId ||
      !Number.isSafeInteger(row.pid) ||
      row.hostname !== "127.0.0.1" ||
      !Number.isSafeInteger(row.port) ||
      Number(row.port) <= 0 ||
      Number(row.port) > 65_535 ||
      typeof row.token !== "string" ||
      row.token.length === 0 ||
      !Number.isSafeInteger(row.expires_at_ms)
    ) {
      throw Object.assign(new Error("native hook relay bridge not found"), {
        code: "ENOENT",
      });
    }
    return {
      relayId: options.relayId,
      pid: Number(row.pid),
      hostname: row.hostname,
      port: Number(row.port),
      token: row.token,
      expiresAtMs: Number(row.expires_at_ms),
    };
  } finally {
    db.close();
  }
}

function postFastRelay(params: {
  record: FastRelayRecord;
  body: string;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<NativeHookRelayWireResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        hostname: params.record.hostname,
        port: params.record.port,
        path: "/invoke",
        method: "POST",
        signal: params.signal,
        timeout: params.timeoutMs,
        headers: {
          authorization: `Bearer ${params.record.token}`,
          "content-type": "application/json",
          "content-length": Buffer.byteLength(params.body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (chunk) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buffer.byteLength;
          if (total > MAX_RESPONSE_BYTES) {
            res.destroy(new Error("native hook relay bridge response too large"));
            return;
          }
          chunks.push(buffer);
        });
        res.on("error", reject);
        res.on("end", () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as
              | { ok: true; result: NativeHookRelayWireResponse }
              | { ok: false; code?: string; error?: string };
            if (parsed.ok) {
              resolve(parsed.result);
            } else if (parsed.code === "overloaded") {
              reject(new FastRelayError("overloaded", "native hook relay overloaded"));
            } else if (res.statusCode === 410) {
              reject(new FastRelayError("stale", parsed.error ?? "native hook relay stale"));
            } else {
              reject(new Error(parsed.error ?? "native hook relay bridge failed"));
            }
          } catch (error) {
            reject(error instanceof Error ? error : new Error(String(error)));
          }
        });
      },
    );
    req.on("timeout", () => req.destroy(new Error("native hook relay bridge timed out")));
    req.on("error", reject);
    req.end(params.body);
  });
}

async function runFullRelayFallback(
  options: FastRelayOptions,
  rawInput: string,
  streams: { stdout: NodeJS.WritableStream; stderr: NodeJS.WritableStream },
  timeoutMs: number,
): Promise<number> {
  const startedAt = Date.now();
  const { runNativeHookRelayCli } = await import("./cli/native-hook-relay-cli.js");
  const remainingMs = Math.max(1, timeoutMs - (Date.now() - startedAt));
  return runNativeHookRelayCli(
    {
      provider: options.provider,
      relayId: options.relayId,
      stateDb: options.stateDb,
      ...(options.generation ? { generation: options.generation } : {}),
      event: options.event,
      ...(options.preToolUseUnavailable
        ? { preToolUseUnavailable: options.preToolUseUnavailable }
        : {}),
      timeout: String(remainingMs),
    },
    { stdin: Readable.from([rawInput]), ...streams },
  );
}

async function readBoundedInput(
  stream: NodeJS.ReadableStream,
  deadline: Deadline,
  now: () => number,
): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  const abort = () => {
    const destroy = (stream as NodeJS.ReadableStream & { destroy?: (error?: Error) => void })
      .destroy;
    destroy?.call(stream, new Error(`native hook relay timed out after ${deadline.timeoutMs}ms`));
  };
  deadline.signal.addEventListener("abort", abort, { once: true });
  try {
    for await (const chunk of stream) {
      remaining(deadline, now);
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += buffer.byteLength;
      if (total > MAX_STDIN_BYTES) {
        throw new Error(`native hook input exceeds ${MAX_STDIN_BYTES} bytes`);
      }
      chunks.push(buffer);
    }
    remaining(deadline, now);
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    deadline.signal.removeEventListener("abort", abort);
  }
}

function createDeadline(timeoutMs: number, now: () => number): Deadline {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return {
    expiresAtMs: now() + timeoutMs,
    signal: controller.signal,
    timeoutMs,
    dispose: () => clearTimeout(timer),
  };
}

function remaining(deadline: Deadline, now: () => number): number {
  const value = deadline.expiresAtMs - now();
  if (value <= 0 || deadline.signal.aborted) {
    throw new Error(`native hook relay timed out after ${deadline.timeoutMs}ms`);
  }
  return Math.max(1, value);
}

function isRetryable(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ECONNREFUSED" || code === "EAGAIN";
}

function isFastRelayError(error: unknown, code: FastRelayError["code"]): error is FastRelayError {
  return (
    (error instanceof FastRelayError && error.code === code) ||
    (error instanceof Error && (error as Error & { code?: unknown }).code === code)
  );
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", abort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      cleanup();
      reject(new Error("native hook relay timed out"));
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function writeUnavailable(
  options: FastRelayOptions,
  stdout: NodeJS.WritableStream,
  stderr: NodeJS.WritableStream,
  unavailable: string,
  error: unknown,
): number {
  const prefix =
    unavailable === "Native hook relay timed out"
      ? "native hook relay timed out"
      : "native hook relay unavailable";
  write(stderr, `${prefix}: ${message(error)}\n`);
  const response = renderCodexNativeHookUnavailableResponse({
    event: options.event,
    ...(options.preToolUseUnavailable
      ? { preToolUseUnavailable: options.preToolUseUnavailable }
      : {}),
    message: unavailable,
  });
  write(stdout, response.stdout);
  write(stderr, response.stderr);
  return response.exitCode;
}

function required(values: Map<string, string>, flag: string): string {
  const value = values.get(flag)?.trim();
  if (!value) {
    throw new Error(`missing required native hook relay argument: ${flag}`);
  }
  return value;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  return parsed;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function write(stream: NodeJS.WritableStream, value: string | undefined): void {
  if (value) {
    stream.write(value);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    process.exitCode = await runNativeHookRelayEntry(
      parseNativeHookRelayEntryArgs(process.argv.slice(2)),
    );
  } catch (error) {
    process.stderr.write(`invalid native hook relay options: ${message(error)}\n`);
    process.exitCode = 1;
  }
}
