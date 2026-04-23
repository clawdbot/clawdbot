import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import net from "node:net";
import * as grammy from "grammy";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { isDiagnosticsEnabled } from "openclaw/plugin-sdk/diagnostic-runtime";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { defaultRuntime } from "openclaw/plugin-sdk/runtime-env";
import { formatErrorMessage } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  logWebhookError,
  logWebhookProcessed,
  logWebhookReceived,
  normalizeOptionalString,
  startDiagnosticHeartbeat,
  stopDiagnosticHeartbeat,
} from "openclaw/plugin-sdk/text-runtime";
import {
  applyBasicWebhookRequestGuards,
  createFixedWindowRateLimiter,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
} from "openclaw/plugin-sdk/webhook-ingress";
import { readJsonBodyWithLimit } from "openclaw/plugin-sdk/webhook-request-guards";
import { resolveTelegramAllowedUpdates } from "./allowed-updates.js";
import { withTelegramApiErrorLogging } from "./api-logging.js";
import { createTelegramBot } from "./bot.js";

const TELEGRAM_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const TELEGRAM_WEBHOOK_BODY_TIMEOUT_MS = 30_000;
// Keep below Telegram/proxy read timeouts; grammY returns early while the handler continues.
const TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS = 5_000;
const InputFileCtor: typeof grammy.InputFile =
  typeof grammy.InputFile === "function"
    ? grammy.InputFile
    : (class InputFileFallback {
        constructor(public readonly path: string) {}
      } as unknown as typeof grammy.InputFile);

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

async function initializeTelegramWebhookBot(params: {
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
      const parsedPrefix = Number.parseInt(prefix ?? "", 10);
      const family = net.isIP(address);
      if (
        family === 4 &&
        Number.isInteger(parsedPrefix) &&
        parsedPrefix >= 0 &&
        parsedPrefix <= 32
      ) {
        blockList.addSubnet(address, parsedPrefix, "ipv4");
      }
      if (
        family === 6 &&
        Number.isInteger(parsedPrefix) &&
        parsedPrefix >= 0 &&
        parsedPrefix <= 128
      ) {
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
  const diagnosticsEnabled = isDiagnosticsEnabled(opts.config);
  const bot = createTelegramBot({
    token: opts.token,
    runtime,
    proxyFetch: opts.fetch,
    config: opts.config,
    accountId: opts.accountId,
  });
  await initializeTelegramWebhookBot({
    bot,
    runtime,
    abortSignal: opts.abortSignal,
  });
  const telegramWebhookRateLimiter = createFixedWindowRateLimiter({
    windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
    maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
    maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
  });
  const handler = grammy.webhookCallback(bot, "callback", {
    secretToken: secret,
    onTimeout: "return",
    timeoutMilliseconds: TELEGRAM_WEBHOOK_CALLBACK_TIMEOUT_MS,
  });

  if (diagnosticsEnabled) {
    startDiagnosticHeartbeat(opts.config);
  }

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
    // Apply the per-source limit before auth so invalid secret guesses consume budget
    // in the same window as any later request from that source.
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
    const startTime = Date.now();
    if (diagnosticsEnabled) {
      logWebhookReceived({ channel: "telegram", updateType: "telegram-post" });
    }
    const secretHeader = resolveSingleHeaderValue(req.headers["x-telegram-bot-api-secret-token"]);
    if (!hasValidTelegramWebhookSecret(secretHeader, secret)) {
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

      let replied = false;
      const reply = async (json: string) => {
        if (replied) {
          return;
        }
        replied = true;
        if (res.headersSent || res.writableEnded) {
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(json);
      };
      const unauthorized = async () => {
        if (replied) {
          return;
        }
        replied = true;
        respondText(401, "unauthorized");
      };

      await handler(body.value, reply, secretHeader, unauthorized);
      if (!replied) {
        respondText(200);
      }

      if (diagnosticsEnabled) {
        logWebhookProcessed({
          channel: "telegram",
          updateType: "telegram-post",
          durationMs: Date.now() - startTime,
        });
      }
    })().catch((err) => {
      const errMsg = formatErrorMessage(err);
      if (diagnosticsEnabled) {
        logWebhookError({
          channel: "telegram",
          updateType: "telegram-post",
          error: errMsg,
        });
      }
      runtime.log?.(`webhook handler failed: ${errMsg}`);
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

  try {
    await withTelegramApiErrorLogging({
      operation: "setWebhook",
      runtime,
      fn: () =>
        bot.api.setWebhook(publicUrl, {
          secret_token: secret,
          allowed_updates: resolveTelegramAllowedUpdates(),
          certificate: opts.webhookCertPath ? new InputFileCtor(opts.webhookCertPath) : undefined,
        }),
    });
  } catch (err) {
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
    throw err;
  }

  runtime.log?.(`webhook local listener on http://${host}:${boundPort}${path}`);
  runtime.log?.(`webhook advertised to telegram on ${publicUrl}`);

  let shutDown = false;
  const shutdown = () => {
    if (shutDown) {
      return;
    }
    shutDown = true;
    void withTelegramApiErrorLogging({
      operation: "deleteWebhook",
      runtime,
      fn: () => bot.api.deleteWebhook({ drop_pending_updates: false }),
    }).catch(() => {
      // withTelegramApiErrorLogging has already emitted the failure.
    });
    server.close();
    void bot.stop();
    if (diagnosticsEnabled) {
      stopDiagnosticHeartbeat();
    }
  };
  if (opts.abortSignal) {
    opts.abortSignal.addEventListener("abort", shutdown, { once: true });
  }

  return { server, bot, stop: shutdown };
}
