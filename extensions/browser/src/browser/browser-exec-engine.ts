import { Worker } from "node:worker_threads";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

export const DEFAULT_BROWSER_EXEC_TIMEOUT_MS = 60_000;
export const BROWSER_EXEC_MIN_TIMEOUT_MS = 5_000;
export const BROWSER_EXEC_MAX_TIMEOUT_MS = 300_000;
export const BROWSER_EXEC_OUTPUT_MAX_CHARS = 64 * 1024;
export const BROWSER_EXEC_RECOVERY_GUIDANCE =
  "Retry browser_exec after checking the script. If a ref may be stale, call snapshot() again before act().";

const BROWSER_EXEC_TRAFFIC_MAX_CHARS = 1024 * 1024;
const TRUNCATION_MARKER = "\u2026[truncated]";

const BROWSER_EXEC_WORKER_SOURCE = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");

  let nextCallId = 1;
  const pending = new Map();

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextCallId++;
      pending.set(id, { resolve, reject });
      parentPort.postMessage({ type: "call", id, method, params });
    });
  }

  parentPort.on("message", (message) => {
    if (!message || message.type !== "reply") return;
    const call = pending.get(message.id);
    if (!call) return;
    pending.delete(message.id);
    if (message.ok) {
      call.resolve(message.value);
      return;
    }
    const error = new Error(message.error?.message || "Browser helper failed");
    error.name = message.error?.name || "Error";
    if (message.error?.stack) error.stack = message.error.stack;
    call.reject(error);
  });

  function jsonValue(value) {
    if (value === undefined) return null;
    return JSON.parse(JSON.stringify(value));
  }

  (async () => {
    try {
      const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
      const execute = new AsyncFunction(
        "act",
        "snapshot",
        "open",
        "tabs",
        "log",
        '"use strict";\n' + workerData.code + '\n',
      );
      const value = await execute(
        (action) => rpc("act", [action]),
        (options) => rpc("snapshot", options === undefined ? [] : [options]),
        (url) => rpc("open", [url]),
        () => rpc("tabs", []),
        (...values) => rpc("log", values),
      );
      parentPort.postMessage({ type: "result", value: jsonValue(value) });
    } catch (error) {
      parentPort.postMessage({
        type: "error",
        error: {
          name: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
          ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
        },
      });
    } finally {
      parentPort.close();
    }
  })();
`;

export type BrowserExecHelperMethod = "act" | "snapshot" | "open" | "tabs";

export type BrowserExecError = {
  name: string;
  message: string;
  stack?: string;
};

export type BrowserExecResult =
  | { ok: true; value: unknown; logs: string[] }
  | {
      ok: false;
      logs: string[];
      error: BrowserExecError;
      timedOut?: true;
    };

export type BrowserExecHost = (params: {
  method: BrowserExecHelperMethod;
  params: unknown[];
  signal: AbortSignal;
}) => Promise<unknown>;

/** Clamp model input to the Browser script execution window. */
export function resolveBrowserExecTimeoutMs(timeoutMs?: number): number {
  const normalized =
    typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
      ? Math.floor(timeoutMs)
      : DEFAULT_BROWSER_EXEC_TIMEOUT_MS;
  // browser.request and Gateway RPC accept timer-safe explicit budgets well above
  // 300s; their outer watchdogs add separate grace windows at the tool boundary.
  return Math.max(BROWSER_EXEC_MIN_TIMEOUT_MS, Math.min(BROWSER_EXEC_MAX_TIMEOUT_MS, normalized));
}

type WorkerCallMessage = {
  type: "call";
  id: number;
  method: string;
  params: unknown[];
};

type WorkerResultMessage = { type: "result"; value: unknown };
type WorkerErrorMessage = { type: "error"; error: BrowserExecError };

function readWorkerMessage(
  value: unknown,
): WorkerCallMessage | WorkerResultMessage | WorkerErrorMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  if (
    value.type === "call" &&
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    typeof value.method === "string" &&
    Array.isArray(value.params)
  ) {
    return {
      type: "call",
      id: value.id,
      method: value.method,
      params: value.params,
    };
  }
  if (value.type === "result" && Object.hasOwn(value, "value")) {
    return { type: "result", value: value.value };
  }
  if (value.type !== "error" || !isRecord(value.error)) {
    return null;
  }
  const name = typeof value.error.name === "string" ? value.error.name : "Error";
  const message = typeof value.error.message === "string" ? value.error.message : "Script failed";
  const stack = typeof value.error.stack === "string" ? value.error.stack : undefined;
  return { type: "error", error: { name, message, ...(stack ? { stack } : {}) } };
}

function serializeForLimit(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return String(value);
  }
}

function formatLog(values: unknown[]): string {
  return values
    .map((value) => (typeof value === "string" ? value : serializeForLimit(value)))
    .join(" ");
}

type LogCapState = { chars: number; full: boolean };

function appendCappedLog(logs: string[], log: string, maxChars: number, state: LogCapState): void {
  if (state.full) {
    return;
  }
  const separatorChars = logs.length === 0 ? 0 : 1;
  const encoded = JSON.stringify(log);
  if (state.chars + separatorChars + encoded.length <= maxChars) {
    logs.push(log);
    state.chars += separatorChars + encoded.length;
    return;
  }

  let low = 0;
  let high = log.length;
  let truncated: string | undefined;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const candidate = truncateUtf16Safe(log, middle) + TRUNCATION_MARKER;
    if (state.chars + separatorChars + JSON.stringify(candidate).length <= maxChars) {
      truncated = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  if (truncated) {
    logs.push(truncated);
    state.chars += separatorChars + JSON.stringify(truncated).length;
  }
  state.full = true;
}

function capLogs(logs: string[], maxChars: number): string[] {
  const state: LogCapState = { chars: 2, full: maxChars < 2 };
  if (state.full) {
    return [];
  }
  const capped: string[] = [];
  for (const log of logs) {
    appendCappedLog(capped, log, maxChars, state);
  }
  return capped;
}

function capSuccess(value: unknown, logs: string[]): { value: unknown; logs: string[] } {
  const serializedValue = serializeForLimit(value);
  if (serializedValue.length >= BROWSER_EXEC_OUTPUT_MAX_CHARS) {
    let low = 0;
    let high = BROWSER_EXEC_OUTPUT_MAX_CHARS - TRUNCATION_MARKER.length;
    let truncated = TRUNCATION_MARKER;
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = truncateUtf16Safe(serializedValue, middle) + TRUNCATION_MARKER;
      if (JSON.stringify(candidate).length <= BROWSER_EXEC_OUTPUT_MAX_CHARS) {
        truncated = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return {
      value: truncated,
      logs: [],
    };
  }
  return {
    value,
    logs: capLogs(logs, BROWSER_EXEC_OUTPUT_MAX_CHARS - serializedValue.length),
  };
}

function errorWithNextStep(error: BrowserExecError): BrowserExecError {
  const message = error.message.includes(BROWSER_EXEC_RECOVERY_GUIDANCE)
    ? error.message
    : `${error.message} ${BROWSER_EXEC_RECOVERY_GUIDANCE}`;
  return { ...error, message };
}

function failure(error: BrowserExecError, logs: string[], timedOut = false): BrowserExecResult {
  return {
    ok: false,
    logs: capLogs(logs, BROWSER_EXEC_OUTPUT_MAX_CHARS),
    error: errorWithNextStep(error),
    ...(timedOut ? { timedOut: true } : {}),
  };
}

function trafficSize(value: unknown): number {
  try {
    return (JSON.stringify(value) ?? "null").length;
  } catch {
    return BROWSER_EXEC_TRAFFIC_MAX_CHARS + 1;
  }
}

function isHelperMethod(value: string): value is BrowserExecHelperMethod {
  return value === "act" || value === "snapshot" || value === "open" || value === "tabs";
}

/** Run one agent-authored Browser script in a disposable worker thread. */
export async function executeBrowserScript(params: {
  code: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  host: BrowserExecHost;
}): Promise<BrowserExecResult> {
  const timeoutMs = resolveBrowserExecTimeoutMs(params.timeoutMs);
  if (params.signal?.aborted) {
    return failure(
      { name: "AbortError", message: "Browser exec was cancelled before it started." },
      [],
    );
  }

  let worker: Worker;
  try {
    worker = new Worker(BROWSER_EXEC_WORKER_SOURCE, {
      eval: true,
      workerData: { code: params.code },
    });
  } catch (error) {
    return failure(
      {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
        ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
      },
      [],
    );
  }

  return await new Promise<BrowserExecResult>((resolve) => {
    const logs: string[] = [];
    const logCapState: LogCapState = { chars: 2, full: false };
    const hostController = new AbortController();
    let trafficChars = 0;
    let settled = false;

    const settle = (result: BrowserExecResult) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      params.signal?.removeEventListener("abort", onAbort);
      hostController.abort(new Error("browser_exec worker finished"));
      worker.removeAllListeners();
      worker.once("error", () => {});
      void worker.terminate().catch(() => {});
      resolve(result);
    };

    const terminateForTraffic = () =>
      settle(
        failure(
          {
            name: "BrowserExecTrafficError",
            message: `Browser exec helper traffic exceeded ${BROWSER_EXEC_TRAFFIC_MAX_CHARS} characters. Return less data or narrow snapshot options.`,
          },
          logs,
        ),
      );

    const reply = (value: unknown) => {
      if (settled) {
        return false;
      }
      trafficChars += trafficSize(value);
      if (trafficChars > BROWSER_EXEC_TRAFFIC_MAX_CHARS) {
        terminateForTraffic();
        return false;
      }
      try {
        // Node Worker.postMessage has no browser targetOrigin parameter.
        // oxlint-disable-next-line unicorn/require-post-message-target-origin
        worker.postMessage(value);
        return true;
      } catch {
        settle(
          failure(
            {
              name: "BrowserExecSerializationError",
              message:
                "A browser helper returned a value that could not cross the worker boundary.",
            },
            logs,
          ),
        );
        return false;
      }
    };

    const handleCall = async (message: WorkerCallMessage) => {
      trafficChars += trafficSize(message);
      if (trafficChars > BROWSER_EXEC_TRAFFIC_MAX_CHARS) {
        terminateForTraffic();
        return;
      }
      if (message.method === "log") {
        appendCappedLog(
          logs,
          formatLog(message.params),
          BROWSER_EXEC_OUTPUT_MAX_CHARS,
          logCapState,
        );
        reply({ type: "reply", id: message.id, ok: true, value: true });
        return;
      }
      if (!isHelperMethod(message.method)) {
        reply({
          type: "reply",
          id: message.id,
          ok: false,
          error: { name: "Error", message: `Unknown browser_exec helper: ${message.method}` },
        });
        return;
      }
      try {
        const value = await params.host({
          method: message.method,
          params: message.params,
          signal: hostController.signal,
        });
        reply({ type: "reply", id: message.id, ok: true, value });
      } catch (error) {
        reply({
          type: "reply",
          id: message.id,
          ok: false,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: error instanceof Error ? error.message : String(error),
            ...(error instanceof Error && error.stack ? { stack: error.stack } : {}),
          },
        });
      }
    };

    const onAbort = () =>
      settle(failure({ name: "AbortError", message: "Browser exec was cancelled." }, logs));

    params.signal?.addEventListener("abort", onAbort, { once: true });
    worker.on("message", (value: unknown) => {
      const message = readWorkerMessage(value);
      if (!message) {
        settle(
          failure(
            { name: "BrowserExecProtocolError", message: "Worker returned an invalid message." },
            logs,
          ),
        );
        return;
      }
      if (message.type === "call") {
        void handleCall(message);
        return;
      }
      if (message.type === "error") {
        settle(failure(message.error, logs));
        return;
      }
      const capped = capSuccess(message.value, logs);
      settle({ ok: true, value: capped.value, logs: capped.logs });
    });
    worker.once("error", (error: Error) => {
      settle(
        failure(
          {
            name: error.name,
            message: error.message,
            ...(error.stack ? { stack: error.stack } : {}),
          },
          logs,
        ),
      );
    });
    worker.once("exit", (code) => {
      settle(
        failure(
          {
            name: "BrowserExecWorkerExitError",
            message: `Browser exec worker exited before returning a result (code ${code}).`,
          },
          logs,
        ),
      );
    });

    const timer = setTimeout(() => {
      settle(
        failure(
          {
            name: "TimeoutError",
            message: `Browser exec timed out after ${timeoutMs}ms. Retry with a shorter script or a larger timeoutMs.`,
          },
          logs,
          true,
        ),
      );
    }, timeoutMs);
    if (params.signal?.aborted) {
      onAbort();
    }
  });
}
