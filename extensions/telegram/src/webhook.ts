// Telegram plugin module implements webhook behavior.
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import { InputFile } from "grammy";
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { isDiagnosticsEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "openclaw/plugin-sdk/logging-core";
import { parseStrictNonNegativeInteger } from "openclaw/plugin-sdk/number-runtime";
import type { BackoffPolicy, RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import {
  computeBackoff,
  defaultRuntime,
  formatDurationPrecise,
  sleepWithAbort,
} from "openclaw/plugin-sdk/runtime-env";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { mergeTelegramAccountConfig } from "./account-config.js";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";
import { resolveTelegramTransport } from "./fetch.js";
import { isRetryableTelegramApiError } from "./network-errors.js";
import { getTelegramSequentialKey } from "./sequential-key.js";
import { createTelegramTransportIngressDrain } from "./telegram-ingress-drain-factory.js";
import {
  resolveTelegramIngressSpoolDir,
  writeTelegramSpooledUpdate,
} from "./telegram-ingress-spool.js";
import { createTelegramWebhookStatusPublisher } from "./webhook-status.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
const TELEGRAM_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const TELEGRAM_WEBHOOK_ACCEPTED_VALUE = "durable";
const TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS = 500;
const TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY: BackoffPolicy = {
  initialMs: 5_000,
  maxMs: 60_000,
  factor: 2,
  jitter: 0.2,
};
async function listenHttpServer(params: {
  server: ReturnType<typeof createServer>;
  port: number;
  host: string;
}) {
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      params.server.off("error", onError);
      reject(err);
    };
    params.server.once("error", onError);
    params.server.listen(params.port, params.host, () => {
      params.server.off("error", onError);
      resolve();
    });
  });
}

function resolveWebhookPublicUrl(params: {
  configuredPublicUrl?: string;
  server: ReturnType<typeof createServer>;
  path: string;
  host: string;
  port: number;
}) {
  if (params.configuredPublicUrl) {
    return params.configuredPublicUrl;
  }
  const address = params.server.address();
  if (address && typeof address !== "string") {
    const resolvedHost =
      params.host === "0.0.0.0" || address.address === "0.0.0.0" || address.address === "::"
        ? "localhost"
        : address.address;
    return `http://${resolvedHost}:${address.port}${params.path}`;
  }
  const fallbackHost = params.host === "0.0.0.0" ? "localhost" : params.host;
  return `http://${fallbackHost}:${params.port}${params.path}`;
}

async function initializeTelegramWebhookBotOnce(params: {
  bot: ReturnType<typeof createTelegramBot>;
  runtime: RuntimeEnv;
  abortSignal?: AbortSignal;
}) {
  const initSignal = params.abortSignal as Parameters<(typeof params.bot)["init"]>[0];
  await withTelegramApiErrorLogging({
    operation: "getMe",
    runtime: params.runtime,
    fn: () => params.bot.init(initSignal),
  });
}

async function initializeTelegramWebhookBot(params: {
  abortSignal?: AbortSignal;
  bot: ReturnType<typeof createTelegramBot>;
  retryPolicy: BackoffPolicy;
  runtime: RuntimeEnv;
}) {
  let attempt = 0;
  while (true) {
    try {
      await initializeTelegramWebhookBotOnce({
        bot: params.bot,
        runtime: params.runtime,
        abortSignal: params.abortSignal,
      });
      return;
    } catch (err) {
      if (
        !isRetryableTelegramApiError(err, { context: "webhook" }) ||
        params.abortSignal?.aborted
      ) {
        throw err;
      }
      attempt += 1;
      const delayMs = computeBackoff(params.retryPolicy, attempt);
      params.runtime.log?.(
        `telegram getMe retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}`,
      );
      await sleepWithAbort(delayMs, params.abortSignal);
    }
  }
}

function resolveSingleHeaderValue(header: string | string[] | undefined): string | undefined {
  if (typeof header === "string") {
    return header;
  }
  if (Array.isArray(header) && header.length === 1) {
    return header[0];
  }
  return undefined;
}

function hasValidTelegramWebhookSecret(
  secretHeader: string | undefined,
  expectedSecret: string,
): boolean {
  return safeEqualSecret(secretHeader, expectedSecret);
}

function parseIpLiteral(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    if (end !== -1) {
      const candidate = trimmed.slice(1, end);
      return net.isIP(candidate) === 0 ? undefined : candidate;
    }
  }
  if (net.isIP(trimmed) !== 0) {
    return trimmed;
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > -1 && trimmed.includes(".") && trimmed.indexOf(":") === lastColon) {
    const candidate = trimmed.slice(0, lastColon);
    return net.isIP(candidate) === 4 ? candidate : undefined;
  }
  return undefined;
}

function isTrustedProxyAddress(
  ip: string | undefined,
  trustedProxies?: readonly string[],
): boolean {
  const candidate = parseIpLiteral(ip);
  if (!candidate || !trustedProxies?.length) {
    return false;
  }
  const blockList = new net.BlockList();
  for (const proxy of trustedProxies) {
    const trimmed = normalizeOptionalString(proxy) ?? "";
    if (!trimmed) {
      continue;
    }
    if (trimmed.includes("/")) {
      const [address, prefix] = trimmed.split("/", 2);
      if (address === undefined || prefix === undefined) {
        continue;
      }
      const parsedPrefix = parseStrictNonNegativeInteger(prefix);
      const family = net.isIP(address);
      if (family === 4 && parsedPrefix !== undefined && parsedPrefix >= 0 && parsedPrefix <= 32) {
        blockList.addSubnet(address, parsedPrefix, "ipv4");
      }
      if (family === 6 && parsedPrefix !== undefined && parsedPrefix >= 0 && parsedPrefix <= 128) {
        blockList.addSubnet(address, parsedPrefix, "ipv6");
      }
      continue;
    }
    if (net.isIP(trimmed) === 4) {
      blockList.addAddress(trimmed, "ipv4");
      continue;
    }
    if (net.isIP(trimmed) === 6) {
      blockList.addAddress(trimmed, "ipv6");
    }
  }
  return blockList.check(candidate, net.isIP(candidate) === 6 ? "ipv6" : "ipv4");
}

function resolveForwardedClientIp(
  forwardedFor: string | undefined,
  trustedProxies?: readonly string[],
): string | undefined {
  if (!trustedProxies?.length) {
    return undefined;
  }
  const forwardedChain = forwardedFor
    ?.split(",")
    .map((entry) => parseIpLiteral(entry))
    .filter((entry): entry is string => Boolean(entry));
  if (!forwardedChain?.length) {
    return undefined;
  }
  for (let index = forwardedChain.length - 1; index >= 0; index -= 1) {
    const hop = forwardedChain[index];
    if (!isTrustedProxyAddress(hop, trustedProxies)) {
      return hop;
    }
  }
  return undefined;
}

function resolveTelegramWebhookClientIp(req: IncomingMessage, config?: OpenClawConfig): string {
  const remoteAddress = parseIpLiteral(req.socket.remoteAddress);
  const trustedProxies = config?.gateway?.trustedProxies;
  if (!remoteAddress) {
    return "unknown";
  }
  if (!isTrustedProxyAddress(remoteAddress, trustedProxies)) {
    return remoteAddress;
  }
  const forwardedFor = Array.isArray(req.headers["x-forwarded-for"])
    ? req.headers["x-forwarded-for"][0]
    : req.headers["x-forwarded-for"];
  const forwardedClientIp = resolveForwardedClientIp(forwardedFor, trustedProxies);
  if (forwardedClientIp) {
    return forwardedClientIp;
  }
  if (config?.gateway?.allowRealIpFallback === true) {
    const realIp = Array.isArray(req.headers["x-real-ip"])
      ? req.headers["x-real-ip"][0]
      : req.headers["x-real-ip"];
    return parseIpLiteral(realIp) ?? "unknown";
  }
  return "unknown";
}

function resolveTelegramWebhookRateLimitKey(
  req: IncomingMessage,
  path: string,
  config?: OpenClawConfig,
): string {
  return `${path}:${resolveTelegramWebhookClientIp(req, config)}`;
}

function resolveWebhookSpooledUpdateLaneKey(update: unknown): string {
  return getTelegramSequentialKey({
    update: update as Parameters<typeof getTelegramSequentialKey>[0]["update"],
  });
}

export async function startTelegramWebhook(opts: {
  token: string;
  accountId?: string;
  config?: OpenClawConfig;
  path?: string;
  port?: number;
  host?: string;
  secret?: string;
  runtime?: RuntimeEnv;
  fetch?: typeof fetch;
  abortSignal?: AbortSignal;
  healthPath?: string;
  publicUrl?: string;
  webhookCertPath?: string;
  webhookRegistrationRetryPolicy?: BackoffPolicy;
  spoolDir?: string;
  setStatus?: (patch: Omit<ChannelAccountSnapshot, "accountId">) => void;
}) {
  const path = opts.path ?? "/telegram-webhook";
  const healthPath = opts.healthPath ?? "/healthz";
  const port = opts.port ?? 8787;
  const host = opts.host ?? "127.0.0.1";
  const secret = normalizeOptionalString(opts.secret) ?? "";
  if (!secret) {
    throw new Error(
      "Telegram webhook mode requires a non-empty secret token. " +
        "Set channels.telegram.webhookSecret in your config.",
    );
  }
  const runtime = opts.runtime ?? defaultRuntime;
  const status = createTelegramWebhookStatusPublisher(opts.setStatus);
  status.noteWebhookStart();
  const webhookRegistrationRetryPolicy =
    opts.webhookRegistrationRetryPolicy ?? TELEGRAM_WEBHOOK_REGISTRATION_RETRY_POLICY;
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const spoolDir = opts.spoolDir ?? resolveTelegramIngressSpoolDir({ accountId: opts.accountId });
  let shutDown = false;
  const shutdownAbortController = new AbortController();
  const telegramAccountConfig = opts.config
    ? mergeTelegramAccountConfig(opts.config, opts.accountId ?? "default")
    : undefined;
  const telegramTransport = resolveTelegramTransport(opts.fetch, {
    network: telegramAccountConfig?.network,
  });
  let closeTransportPromise: Promise<void> | undefined;
  const closeTransportOnce = (): Promise<void> => {
    closeTransportPromise ??= telegramTransport.close();
    return closeTransportPromise;
  };
  const botAbortController = new AbortController();
  const botFetchAbortSignal = opts.abortSignal
    ? AbortSignal.any([opts.abortSignal, botAbortController.signal])
    : botAbortController.signal;
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    fetchAbortSignal: botFetchAbortSignal,
    config: opts.config,
    accountId: opts.accountId,
    telegramTransport,
  });
  try {
    await initializeTelegramWebhookBot({
      bot,
      runtime,
      abortSignal: opts.abortSignal,
      retryPolicy: webhookRegistrationRetryPolicy,
    });
  } catch (err) {
    botAbortController.abort();
    await bot.stop();
    await closeTransportOnce();
    throw err;
  }
  const telegramWebhookRateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(opts.config);
  }

  const log = (line: string) => runtime.log?.(line);
  let drainActive = false;
  let drainRequested = false;
  let webhookIngressDrain: ReturnType<typeof createTelegramTransportIngressDrain> | undefined;
  const drainWebhookSpool = async (): Promise<void> => {
    if (shutDown || opts.abortSignal?.aborted) {
      return;
    }
    if (drainActive) {
      drainRequested = true;
      return;
    }
    drainActive = true;
    drainRequested = false;
    try {
      // Shutdown must abort in-flight drain work (tombstone retries), not just
      // stop the next claim; the composed signal carries webhook stop + caller abort.
      const webhookAbortSignal = opts.abortSignal
        ? AbortSignal.any([shutdownAbortController.signal, opts.abortSignal])
        : shutdownAbortController.signal;
      webhookIngressDrain ??= createTelegramTransportIngressDrain({
        spoolDir,
        bot,
        cfg: opts.config ?? {},
        accountId: opts.accountId ?? "default",
        // Pre-migration product default: 25m claim→adoption stall for webhook.
        adoptionStallTimeoutMs: 25 * 60_000,
        abortSignal: webhookAbortSignal,
        onLog: (message) => log(`webhook ${message}`),
      });
      await webhookIngressDrain.drainOnce({
        shouldStop: () => shutDown || webhookAbortSignal.aborted,
      });
    } catch (err) {
      log(`[telegram][diag] webhook spool drain failed: ${formatErrorMessage(err)}`);
    } finally {
      drainActive = false;
      if (drainRequested && !shutDown && !opts.abortSignal?.aborted) {
        drainRequested = false;
        void Promise.resolve().then(drainWebhookSpool);
      }
    }
  };
  const requestWebhookSpoolDrain = () => {
    void drainWebhookSpool();
  };
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  const startWebhookSpoolDrain = () => {
    if (drainTimer) {
      return;
    }
    requestWebhookSpoolDrain();
    drainTimer = setInterval(requestWebhookSpoolDrain, TELEGRAM_WEBHOOK_SPOOLED_DRAIN_INTERVAL_MS);
    drainTimer.unref?.();
  };

  const server = createServer((req, res) => {
    const respondText = (statusCode: number, text = "") => {
      if (res.headersSent || res.writableEnded) {
        return;
      }
      res.writeHead(statusCode, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(text);
    };

    if (req.url === healthPath) {
      res.writeHead(200);
      res.end("ok");
      return;
    }
    if (req.url !== path || req.method !== "POST") {
      res.writeHead(404);
      res.end();
      return;
    }
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }
    const secretHeader = resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]);
    if (!hasValidTelegramWebhookSecret(secretHeader, secret)) {
      // Authenticated Telegram delivery must not consume the abuse budget. Only
      // failed secret guesses are rate-limited, before the body is read.
      if (
        !applyBasicWebhookRequestGuards({
          req,
          res,
          rateLimiter: telegramWebhookRateLimiter,
          rateLimitKey: resolveTelegramWebhookRateLimitKey(req, path, opts.config),
        })
      ) {
        return;
      }
      res.shouldKeepAlive = false;
      res.setHeader("Connection", "close");
      respondText(401, "unauthorized");
      return;
    }
    void (async () => {
      const body = await readJsonBodyWithLimit(req, {
        maxBytes: TELEGRAM_WEBHOOK_MAX_BODY_BYTES,
        timeoutMs: TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS,
        emptyObjectOnEmpty: false,
      });
      if (!body.ok) {
        if (body.code === "PAYLOAD_TOO_LARGE") {
          respondText(413, body.error);
          return;
        }
        if (body.code === "REQUEST_BODY_TIMEOUT") {
          respondText(408, body.error);
          return;
        }
        if (body.code === "CONNECTION_CLOSED") {
          respondText(400, body.error);
          return;
        }
        respondText(400, body.error);
        return;
      }

      // Telegram sees 200 only after the update is durable. If SQLite rejects
      // the enqueue, this path returns non-200 so Telegram redelivers.
      await writeTelegramSpooledUpdate({
        spoolDir,
        update: body.value,
        laneKey: resolveWebhookSpooledUpdateLaneKey(body.value),
      });
      // Enqueue duplicate detection makes Telegram webhook retries idempotent:
      // re-posted update_ids map to the same spool row and still ack fast.
      res.setHeader(TELEGRAM_WEBHOOK_ACCEPTED_HEADER, TELEGRAM_WEBHOOK_ACCEPTED_VALUE);
      respondText(200);
      status.noteWebhookUpdateReceived();
      requestWebhookSpoolDrain();
      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    })().catch((err: unknown) => {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook request failed: ${errMsg}`);
      respondText(500);
    });
  });

  await listenHttpServer({
    server,
    port,
    host,
  });
  const boundAddress = server.address();
  const boundPort = boundAddress && typeof boundAddress !== "string" ? boundAddress.port : port;

  const publicUrl = resolveWebhookPublicUrl({
    configuredPublicUrl: opts.publicUrl,
    server,
    path,
    host,
    port,
  });

  let webhookAdvertised = false;
  const shutdown = async () => {
    if (shutDown) {
      return;
    }
    botAbortController.abort();
    shutDown = true;
    shutdownAbortController.abort();
    if (drainTimer) {
      clearInterval(drainTimer);
    }
    webhookIngressDrain?.dispose();
    webhookIngressDrain = undefined;
    server.close();
    await bot.stop();
    // The webhook owns this transport because it resolved and injected it into
    // createTelegramBot; close once so abort/startup-failure paths cannot leak sockets.
    await closeTransportOnce();
    status.noteWebhookStop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal?.aborted) {
    void shutdown();
  } else if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", () => void shutdown(), { once: true });
  }

  const advertiseWebhook = async (): Promise<void> => {
    if (shutDown || opts.abortSignal?.aborted) {
      return;
    }
    try {
      await withTelegramApiErrorLogging({
        operation: "setWebhook",
        runtime,
        fn: () =>
          bot.api.setWebhook(publicUrl, {
            secret_token: secret,
            allowed_updates: resolveTelegramAllowedUpdates(),
            certificate: opts.webhookCertPath ? new InputFile(opts.webhookCertPath) : undefined,
          }),
      });
    } catch (err) {
      status.noteWebhookRegistrationFailure(formatErrorMessage(err));
      throw err;
    }
    if (shutDown) {
      return;
    }
    webhookAdvertised = true;
    status.noteWebhookAdvertised();
    runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);
  };
  const shouldRetryWebhookRegistration = (err: unknown): boolean =>
    isRetryableTelegramApiError(err, { context: "webhook" });
  const retryWebhookRegistration = async (firstAttempt: number): Promise<void> => {
    let attempt = firstAttempt;
    while (true) {
      if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) {
        return;
      }
      const delayMs = computeBackoff(webhookRegistrationRetryPolicy, attempt);
      runtime.log?.(
        `telegram setWebhook retry ${attempt} scheduled in ${formatDurationPrecise(delayMs)}`,
      );
      try {
        await sleepWithAbort(delayMs, opts.abortSignal);
      } catch {
        return;
      }
      if (shutDown || opts.abortSignal?.aborted || webhookAdvertised) {
        return;
      }
      try {
        await advertiseWebhook();
        return;
      } catch (err) {
        if (!shouldRetryWebhookRegistration(err)) {
          runtime.error?.(
            `telegram setWebhook retry stopped after non-recoverable error: ${formatErrorMessage(err)}`,
          );
          await shutdown();
          return;
        }
      }
      attempt += 1;
    }
  };

  runtime.log?.(`webhook local listener on http://${host}:${boundPort}${path}`);

  if (!shutDown) {
    try {
      await advertiseWebhook();
    } catch (err) {
      if (!shouldRetryWebhookRegistration(err)) {
        await shutdown();
        throw err;
      }
      void retryWebhookRegistration(1);
    }
  }
  // Drain only after registration succeeds or after the retrying startup path
  // is ready to return a stop handle; failed startup must not claim durable work.
  if (!shutDown) {
    startWebhookSpoolDrain();
  }

  return { server, bot, stop: shutdown };
}
