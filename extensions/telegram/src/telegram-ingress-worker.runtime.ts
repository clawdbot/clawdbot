import { parentPort, workerData } from "node:worker_threads";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { normalizeTelegramApiRoot } from "./api-root.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isRecoverableTelegramNetworkError } from "./network-errors.js";
import { makeProxyFetch } from "./proxy.js";
import { TELEGRAM_GET_UPDATES_REQUEST_TIMEOUT_MS } from "./request-timeouts.js";
import { writeTelegramSpooledUpdate } from "./telegram-ingress-spool.js";
import type {
  TelegramIngressWorkerMessage,
  TelegramIngressWorkerOptions,
} from "./telegram-ingress-worker.js";
import { writeTelegramUpdateOffset } from "./update-offset-store.js";

const options = workerData as TelegramIngressWorkerOptions;
const pollLimit = 100;
const retryInitialMs = 1000;
const retryMaxMs = 30_000;
let stopped = false;
let activeController: AbortController | undefined;

function post(message: TelegramIngressWorkerMessage): void {
  // oxlint-disable-next-line unicorn/require-post-message-target-origin -- Node worker_threads ports do not accept a targetOrigin argument.
  parentPort?.postMessage(message);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

parentPort?.on("message", (message: { type?: string }) => {
  if (message?.type !== "stop") {
    return;
  }
  stopped = true;
  activeController?.abort(new Error("telegram ingress worker stopped"));
});

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
  const pollTimeoutSeconds =
    typeof options.timeoutSeconds === "number" && Number.isFinite(options.timeoutSeconds)
      ? Math.max(1, Math.floor(options.timeoutSeconds))
      : 30;
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
          const updateId = await writeTelegramSpooledUpdate({
            spoolDir: options.spoolDir,
            update,
          });
          if (lastUpdateId === null || updateId > lastUpdateId) {
            lastUpdateId = updateId;
            await writeTelegramUpdateOffset({
              accountId: options.accountId,
              botToken: options.token,
              updateId,
            });
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
  .then(() => undefined)
  .catch((err) => {
    post({ type: "poll-error", message: formatErrorMessage(err), finishedAt: Date.now() });
    process.exitCode = 1;
  });
