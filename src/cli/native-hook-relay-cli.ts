// CLI adapter for invoking native provider hooks through direct relay or gateway fallback.
import {
  invokeNativeHookRelayBridge,
  isNativeHookRelayBridgeStaleRegistrationError,
  renderNativeHookRelayUnavailableResponse,
  type NativeHookRelayProcessResponse,
} from "../agents/harness/native-hook-relay.js";
import { callGateway } from "../gateway/call.js";
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
  callGateway?: typeof callGateway;
};

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

/** Run one native hook relay invocation from stdin JSON to stdout/stderr response streams. */
export async function runNativeHookRelayCli(
  opts: NativeHookRelayCliOptions,
  deps: NativeHookRelayCliDeps = {},
): Promise<number> {
  const stdin = deps.stdin ?? process.stdin;
  const stdout = deps.stdout ?? process.stdout;
  const stderr = deps.stderr ?? process.stderr;
  const invokeBridge = deps.invokeBridge ?? invokeNativeHookRelayBridge;
  const callGatewayFn = deps.callGateway ?? callGateway;
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
  }
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
