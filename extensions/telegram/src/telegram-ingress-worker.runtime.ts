import { parentPort, workerData } from "node:worker_threads";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
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

const options = workerData as TelegramIngressWorkerOptions;
const pollLimit = 100;
const retryInitialMs = 1000;
const retryMaxMs = 30_000;
let stopped = false;
let activeController: AbortController | undefined;
let nextSpoolRequestId = 0;
const pendingSpoolRequests = new Map<
  string,
  {
    resolve(updateId: number): void;
    reject(err: Error): void;
  }
>();

function post(message: TelegramIngressWorkerMessage): void {
  if (parentPort) {
    Reflect.apply(Reflect.get(parentPort, "postMessage") as (value: unknown) => void, parentPort, [
      message,
    ]);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function formatErrorMessage(err: unknown): string {
  if (err instanceof Error) {
    return err.message || err.name;
  }
  return String(err);
}

function resolveBackoff(attempt: number): number {
  return Math.min(retryMaxMs, retryInitialMs * 2 ** Math.max(0, attempt - 1));
}

function rejectPendingSpoolRequests(err: Error): void {
  for (const pending of pendingSpoolRequests.values()) {
    pending.reject(err);
  }
  pendingSpoolRequests.clear();
}

parentPort?.on("message", (message: TelegramIngressWorkerCommand) => {
  if (message?.type === "stop") {
    stopped = true;
    const err = new Error("telegram ingress worker stopped");
    activeController?.abort(err);
    rejectPendingSpoolRequests(err);
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

async function requestSpoolUpdate(params: { update: unknown; queued: number }): Promise<number> {
  if (!parentPort) {
    throw new Error("Telegram ingress worker missing parent port.");
  }
  const requestId = String(++nextSpoolRequestId);
  const updateId = await new Promise<number>((resolve, reject) => {
    pendingSpoolRequests.set(requestId, { resolve, reject });
    post({
      type: "update",
      requestId,
      update: params.update,
      queued: params.queued,
    });
  });
  return updateId;
}

async function fetchJson(params: {
  fetch: typeof fetch;
  url: string;
  body: unknown;
}): Promise<unknown> {
  const controller = new AbortController();
  activeController = controller;
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
    const json = (await response.json()) as {
      ok?: unknown;
      result?: unknown;
      description?: unknown;
    };
    if (!response.ok || json.ok !== true) {
      throw new Error(
        typeof json.description === "string"
          ? json.description
          : `Telegram getUpdates failed with HTTP ${response.status}`,
      );
    }
    return json.result;
  } finally {
    clearTimeout(timeout);
    if (activeController === controller) {
      activeController = undefined;
    }
  }
}

async function main(): Promise<void> {
  const proxyFetch = options.proxy ? makeProxyFetch(options.proxy) : undefined;
  const transport = resolveTelegramTransport(proxyFetch, { network: options.network });
  const fetchImpl = transport.fetch ?? globalThis.fetch;
  const apiRoot = normalizeTelegramApiRoot(options.apiRoot ?? "https://api.telegram.org");
  const getUpdatesUrl = `${apiRoot}/bot${options.token}/getUpdates`;
  const pollTimeoutSeconds = resolveTelegramLongPollTimeoutSeconds(options.timeoutSeconds);
  let lastUpdateId = options.initialUpdateId;
  let failures = 0;

  try {
    for (;;) {
      if (stopped) {
        break;
      }
      const offset = lastUpdateId === null ? null : lastUpdateId + 1;
      const startedAt = Date.now();
      post({ type: "poll-start", offset, startedAt });
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
          post({ type: "spooled", updateId, queued: result.length });
        }
        failures = 0;
        post({
          type: "poll-success",
          offset,
          count: result.length,
          finishedAt: Date.now(),
        });
      } catch (err) {
        if (stopped) {
          break;
        }
        failures += 1;
        post({
          type: "poll-error",
          message: formatErrorMessage(err),
          finishedAt: Date.now(),
        });
        if (!isRecoverableTelegramNetworkError(err, { context: "polling" })) {
          throw err;
        }
        await sleep(resolveBackoff(failures));
      }
    }
  } finally {
    await transport.close();
  }
}

main()
  .then(() => {
    parentPort?.close();
  })
  .catch((err: unknown) => {
    post({ type: "poll-error", message: formatErrorMessage(err), finishedAt: Date.now() });
    parentPort?.close();
    process.exitCode = stopped ? 0 : 1;
  });
