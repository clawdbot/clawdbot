// Telegram plugin module implements telegram ingress worker behavior.
import { parentPort, workerData } from "node:worker_threads";
import { readResponseWithLimit } from "openclaw/plugin-sdk/response-limit-runtime";
import {
  computeBackoff,
  sleepWithAbort,
  type BackoffPolicy,
} from "openclaw/plugin-sdk/runtime-env";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isRetryableTelegramApiError, readTelegramRetryAfterMs } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import {
  TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS,
  resolveTelegramLongPollTimeoutSeconds,
} from "./request-timeouts.js";
import type {
  TelegramIngressWorkerCommand,
  TelegramIngressWorkerMessage,
  TelegramIngressWorkerOptions,
} from "./telegram-ingress-worker.js";
import { TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER } from "./telegram-ingress-worker.js";

const pollLimit = 100;
// getUpdates can return up to 100 updates; 4 MiB is a generous bound that no legitimate
// Telegram Bot API response will reach, guarding against misbehaving/hostile endpoints.
const TELEGRAM_GET_UPDATES_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const TELEGRAM_EMPTY_POLL_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 50,
  maxMs: 1_000,
  factor: 2,
  jitter: 0,
};
const TELEGRAM_RETRY_BACKOFF_POLICY: BackoffPolicy = {
  initialMs: 1_000,
  maxMs: 30_000,
  factor: 2,
  jitter: 0,
};

type TelegramGetUpdatesJson = {
  ok?: unknown;
  error_code?: unknown;
  result?: unknown;
  description?: unknown;
  parameters?: unknown;
};

type PendingSpoolRequests = Map<
  string,
  {
    resolve(updateId: number): void;
    reject(err: Error): void;
  }
>;

type TelegramIngressRuntimePort = {
  postMessage(message: TelegramIngressWorkerMessage): void;
  onMessage(listener: (message: TelegramIngressWorkerCommand) => void): void;
  close(): void;
};

type TelegramIngressRuntimeDeps = {
  fetch?: typeof fetch;
  closeTransport?: () => Promise<void>;
};

type TelegramIngressWorkerRuntimeData = TelegramIngressWorkerOptions & {
  runtime: typeof TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER;
};

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

function readTelegramErrorCode(err: unknown): number | undefined {
  if (err && typeof err === "object" && "error_code" in err) {
    const code = (err as { error_code: unknown }).error_code;
    if (typeof code === "number") {
      return code;
    }
  }
  return undefined;
}

function postPollError(port: TelegramIngressRuntimePort, err: unknown): void {
  const errorCode = readTelegramErrorCode(err);
  port.postMessage({
    type: "poll-error",
    message: formatErrorMessage(err),
    ...(errorCode === undefined ? {} : { errorCode }),
    finishedAt: Date.now(),
  });
}

function createTelegramGetUpdatesError(params: {
  message: string;
  errorCode?: number;
  parameters?: unknown;
}): Error {
  return Object.assign(
    new Error(params.message),
    params.errorCode === undefined ? {} : { error_code: params.errorCode },
    params.parameters === undefined ? {} : { parameters: params.parameters },
  );
}

function rejectPendingSpoolRequests(pendingSpoolRequests: PendingSpoolRequests, err: Error): void {
  for (const pending of pendingSpoolRequests.values()) {
    pending.reject(err);
  }
  pendingSpoolRequests.clear();
}

async function fetchJson(params: {
  fetch: typeof fetch;
  url: string;
  body: unknown;
  setActiveController(controller: AbortController | undefined): void;
}): Promise<unknown> {
  const controller = new AbortController();
  params.setActiveController(controller);
  const timeout = setTimeout(() => {
    controller.abort(new Error("Telegram getUpdates timed out"));
  }, TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS);
  timeout.unref?.();
  try {
    const response = await params.fetch(params.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params.body),
      signal: controller.signal,
    });
    const raw = (
      await readResponseWithLimit(response, TELEGRAM_GET_UPDATES_MAX_RESPONSE_BYTES)
    ).toString("utf8");
    let json: TelegramGetUpdatesJson;
    try {
      json = JSON.parse(raw) as TelegramGetUpdatesJson;
    } catch (err) {
      if (!response.ok) {
        throw createTelegramGetUpdatesError({
          message: `Telegram getUpdates failed with HTTP ${response.status}`,
          errorCode: response.status,
        });
      }
      throw err;
    }
    if (!response.ok || json.ok !== true) {
      const message =
        typeof json.description === "string"
          ? json.description
          : `Telegram getUpdates failed with HTTP ${response.status}`;
      // Preserve the Bot API error_code across the worker boundary so the
      // parent session can distinguish getUpdates conflicts (409) from fatal
      // errors (401) without parsing description strings.
      throw createTelegramGetUpdatesError({
        message,
        errorCode: typeof json.error_code === "number" ? json.error_code : response.status,
        parameters: json.parameters,
      });
    }
    return json.result;
  } finally {
    clearTimeout(timeout);
    params.setActiveController(undefined);
  }
}

export async function runTelegramIngressWorkerRuntime(params: {
  options: TelegramIngressWorkerOptions;
  port: TelegramIngressRuntimePort;
  deps?: TelegramIngressRuntimeDeps;
}): Promise<void> {
  const { options, port } = params;
  const stopController = new AbortController();
  let stopped = false;
  let activeController: AbortController | undefined;
  let nextSpoolRequestId = 0;
  const pendingSpoolRequests: PendingSpoolRequests = new Map();
  const proxyFetch = options.proxy ? makeProxyFetch(options.proxy) : undefined;
  const transport =
    params.deps?.fetch === undefined
      ? resolveTelegramTransport(proxyFetch, { network: options.network })
      : undefined;
  const fetchImpl = params.deps?.fetch ?? transport?.fetch ?? globalThis.fetch;
  const closeTransport =
    params.deps?.closeTransport ?? (() => transport?.close() ?? Promise.resolve());
  const apiRoot = normalizeTelegramApiRoot(options.apiRoot ?? "https://api.telegram.org");
  const getUpdatesUrl = `${apiRoot}/bot${options.token}/getUpdates`;
  const pollTimeoutSeconds = resolveTelegramLongPollTimeoutSeconds(options.timeoutSeconds);
  let lastUpdateId = options.initialUpdateId;
  let failures = 0;
  let consecutiveEmptyPolls = 0;

  port.onMessage((message) => {
    if (message?.type === "stop") {
      stopped = true;
      const err = new Error("telegram ingress worker stopped");
      stopController.abort(err);
      activeController?.abort(err);
      rejectPendingSpoolRequests(pendingSpoolRequests, err);
      return;
    }
    if (message?.type !== "spool-ack") {
      return;
    }
    const pending = pendingSpoolRequests.get(message.requestId);
    if (!pending) {
      return;
    }
    pendingSpoolRequests.delete(message.requestId);
    if (message.result.ok) {
      pending.resolve(message.result.updateId);
      return;
    }
    pending.reject(new Error(message.result.message));
  });

  const requestSpoolUpdate = async (requestParams: {
    update: unknown;
    queued: number;
  }): Promise<number> => {
    const requestId = String(++nextSpoolRequestId);
    const updateId = await new Promise<number>((resolve, reject) => {
      pendingSpoolRequests.set(requestId, { resolve, reject });
      port.postMessage({
        type: "update",
        requestId,
        update: requestParams.update,
        queued: requestParams.queued,
      });
    });
    return updateId;
  };

  try {
    for (;;) {
      if (stopped) {
        break;
      }
      const offset = lastUpdateId === null ? null : lastUpdateId + 1;
      const startedAt = Date.now();
      port.postMessage({ type: "poll-start", offset, startedAt });
      try {
        const result = await fetchJson({
          fetch: fetchImpl,
          url: getUpdatesUrl,
          body: {
            timeout: pollTimeoutSeconds,
            limit: pollLimit,
            allowed_updates: resolveTelegramAllowedUpdates(),
            ...(offset === null ? {} : { offset }),
          },
          setActiveController(controller) {
            activeController = controller;
          },
        });
        if (!Array.isArray(result)) {
          throw new Error("Telegram getUpdates returned a non-array result.");
        }
        for (const update of result) {
          if (stopped) {
            break;
          }
          const updateId = await requestSpoolUpdate({ update, queued: result.length });
          if (lastUpdateId === null || updateId > lastUpdateId) {
            lastUpdateId = updateId;
          }
          port.postMessage({ type: "spooled", updateId, queued: result.length });
        }
        failures = 0;
        port.postMessage({
          type: "poll-success",
          offset,
          count: result.length,
          finishedAt: Date.now(),
        });
        if (result.length > 0) {
          consecutiveEmptyPolls = 0;
          continue;
        }
        consecutiveEmptyPolls += 1;
        if (consecutiveEmptyPolls > 1) {
          // Some Bot API endpoints return empty long polls immediately. Escalate only
          // while idle, then reset above so active chats keep draining without delay.
          const minIntervalMs = computeBackoff(
            TELEGRAM_EMPTY_POLL_BACKOFF_POLICY,
            consecutiveEmptyPolls - 1,
          );
          const elapsedMs = Math.max(0, Date.now() - startedAt);
          if (elapsedMs < minIntervalMs) {
            await sleepWithAbort(minIntervalMs - elapsedMs, stopController.signal, {
              ref: false,
            });
          }
        }
      } catch (err) {
        if (stopped) {
          break;
        }
        consecutiveEmptyPolls = 0;
        failures += 1;
        postPollError(port, err);
        // 409 must propagate to the parent: it owns duplicate-poller/webhook
        // conflict recovery. Transient Bot API errors stay local to this worker.
        if (!isRetryableTelegramApiError(err, { context: "polling" })) {
          throw err;
        }
        try {
          await sleepWithAbort(
            readTelegramRetryAfterMs(err) ??
              computeBackoff(TELEGRAM_RETRY_BACKOFF_POLICY, failures),
            stopController.signal,
            { ref: false },
          );
        } catch (sleepErr) {
          if (!stopped) {
            throw sleepErr;
          }
        }
      }
    }
  } finally {
    await closeTransport();
  }
}

const workerPort = parentPort;
const runtimePort =
  workerPort === null
    ? null
    : ({
        postMessage(message) {
          Reflect.apply(
            Reflect.get(workerPort, "postMessage") as (value: unknown) => void,
            workerPort,
            [message],
          );
        },
        onMessage(listener) {
          workerPort.on("message", listener);
        },
        close() {
          workerPort.close();
        },
      } satisfies TelegramIngressRuntimePort);
const runtimeOptions =
  workerData &&
  typeof workerData === "object" &&
  "runtime" in workerData &&
  workerData.runtime === TELEGRAM_INGRESS_WORKER_RUNTIME_MARKER
    ? (workerData as TelegramIngressWorkerRuntimeData)
    : null;

if (runtimePort && runtimeOptions) {
  let exitedAfterStop = false;
  runtimePort.onMessage((message) => {
    if (message?.type === "stop") {
      exitedAfterStop = true;
    }
  });
  runTelegramIngressWorkerRuntime({
    options: runtimeOptions,
    port: runtimePort,
  })
    .then(() => {
      runtimePort.close();
    })
    .catch((err: unknown) => {
      postPollError(runtimePort, err);
      runtimePort.close();
      process.exitCode = exitedAfterStop ? 0 : 1;
    });
}
