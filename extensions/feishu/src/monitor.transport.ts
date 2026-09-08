// Feishu plugin module implements monitor.transport behavior.
import crypto from "node:crypto";
import * as http from "node:http";
import * as Lark from "@larksuiteoapi/node-sdk";
import { channelBlockedPatch, channelReadyPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForAbortableDelay } from "./async.js";
import { createFeishuWSClient } from "./client.js";
import type { FeishuWebhookInvoker } from "./feishu-ingress.js";
import { buildFeishuWebhookRateLimitKey } from "./monitor-rate-limit-key.js";
import {
  applyBasicWebhookRequestGuards,
  installRequestBodyLimitGuard,
  readWebhookBodyOrReject,
  resolveRequestClientIp,
  safeEqualSecret,
  type RuntimeEnv,
} from "./monitor-transport-runtime-api.js";
import type { FeishuStatusSink } from "./monitor.js";
import {
  clearFeishuBotIdentityState,
  closeTrackedFeishuHttpServer,
  FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
  FEISHU_WEBHOOK_MAX_BODY_BYTES,
  feishuWebhookRateLimiter,
  httpServers,
  recordWebhookStatus,
  wsClients,
} from "./monitor.state.js";
import type { ResolvedFeishuAccount } from "./types.js";
import { DEFAULT_FEISHU_WEBHOOK_PATH, normalizeFeishuWebhookPath } from "./webhook-path.js";

type MonitorTransportParams = {
  account: ResolvedFeishuAccount;
  accountId: string;
  runtime?: RuntimeEnv;
  abortSignal?: AbortSignal;
  eventDispatcher: Lark.EventDispatcher;
  invokeWebhookEvent?: FeishuWebhookInvoker;
  setSocketTerminator?: (terminate: (() => void) | undefined) => void;
  /**
   * Optional status sink for Feishu health tracking. Lifecycle callbacks
   * publish connected state; validated inbound webhook requests publish
   * transport activity.
   */
  statusSink?: FeishuStatusSink;
};

const FEISHU_WEBHOOK_ACCEPTED_HEADER = "x-openclaw-delivery-accepted";
const FEISHU_WEBHOOK_ACCEPTED_VALUE = "durable";
const FEISHU_WS_RECONNECT_INITIAL_DELAY_MS = 1_000;
const FEISHU_WS_RECONNECT_MAX_DELAY_MS = 30_000;
const FEISHU_WS_LOG_ERROR_MAX_LENGTH = 500;
const FEISHU_WS_RECONNECT_EXHAUSTED_RE = /^WebSocket reconnect exhausted after \d+ attempts?/;
const FEISHU_WS_AUTORECONNECT_DISABLED_ERROR =
  "WebSocket connect failed and autoReconnect is disabled";

function isFeishuWebhookPayload(value: unknown): value is Record<string, unknown> {
  return isRecord(value);
}

const BLOCKED_FEISHU_WEBHOOK_PAYLOAD_KEYS = new Set([
  "__proto__",
  "prototype",
  "constructor",
  "headers",
]);

function buildFeishuWebhookEnvelope(
  req: http.IncomingMessage,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  // Lark's adapter exposes trusted request headers through this prototype.
  // Preserve that SDK envelope while preventing payload keys from shadowing it.
  const envelope = Object.create({ headers: req.headers }) as Record<string, unknown>;
  for (const [key, value] of Object.entries(payload)) {
    if (!BLOCKED_FEISHU_WEBHOOK_PAYLOAD_KEYS.has(key)) {
      envelope[key] = value;
    }
  }
  return envelope;
}

function parseFeishuWebhookPayload(rawBody: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(rawBody) as unknown;
    return isFeishuWebhookPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isFeishuWebhookSignatureValid(params: {
  headers: http.IncomingHttpHeaders;
  rawBody: string;
  encryptKey?: string;
}): boolean {
  const encryptKey = params.encryptKey?.trim();
  if (!encryptKey) {
    return false;
  }

  const timestampHeader = params.headers["x-lark-request-timestamp"];
  const nonceHeader = params.headers["x-lark-request-nonce"];
  const signatureHeader = params.headers["x-lark-signature"];
  const timestamp = Array.isArray(timestampHeader) ? timestampHeader[0] : timestampHeader;
  const nonce = Array.isArray(nonceHeader) ? nonceHeader[0] : nonceHeader;
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
  if (!timestamp || !nonce || !signature) {
    return false;
  }

  const computedSignature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + encryptKey + params.rawBody)
    .digest("hex");
  return safeEqualSecret(computedSignature, signature);
}

function respondText(res: http.ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(body);
}

function getFeishuWsReconnectDelayMs(attempt: number): number {
  return Math.min(
    FEISHU_WS_RECONNECT_INITIAL_DELAY_MS * 2 ** Math.max(0, attempt - 1),
    FEISHU_WS_RECONNECT_MAX_DELAY_MS,
  );
}

function formatFeishuWsErrorForLog(err: unknown): string {
  const raw = err instanceof Error ? err.message || err.name : String(err);
  const singleLine = Array.from(raw, (char) => {
    const code = char.charCodeAt(0);
    return code <= 31 || code === 127 ? " " : char;
  }).join("");
  const redacted = singleLine
    .replace(/:\/\/[^:@/\s]+:[^@/\s]+@/g, "://[redacted]@")
    .replace(/\b(authorization\s*[:=]\s*Bearer\s+)[^\s,;]+/gi, "$1[redacted]")
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/-]+=*/g, "$1[redacted]")
    .replace(
      /\b((?:app[_-]?secret|tenant[_-]?access[_-]?token|access[_-]?token|refresh[_-]?token|token|secret|password)\s*[:=]\s*)[^\s&;,]+/gi,
      "$1[redacted]",
    )
    .replace(/\s+/g, " ")
    .trim();

  if (!redacted) {
    return "unknown error";
  }
  if (redacted.length <= FEISHU_WS_LOG_ERROR_MAX_LENGTH) {
    return redacted;
  }
  return `${truncateUtf16Safe(redacted, FEISHU_WS_LOG_ERROR_MAX_LENGTH)}...`;
}

function isFeishuWsTerminalError(err: Error): boolean {
  const message = err.message.trim();
  return (
    FEISHU_WS_RECONNECT_EXHAUSTED_RE.test(message) ||
    message.startsWith(FEISHU_WS_AUTORECONNECT_DISABLED_ERROR)
  );
}

function cleanupFeishuWsClient(params: {
  accountId: string;
  wsClient?: Lark.WSClient;
  error: (message: string) => void;
  clearIdentity: boolean;
}): void {
  const { accountId, wsClient, error, clearIdentity } = params;
  if (wsClient) {
    try {
      wsClient.close();
    } catch (err) {
      error(
        `feishu[${accountId}]: error closing WebSocket client: ${formatFeishuWsErrorForLog(err)}`,
      );
    }
  }
  wsClients.delete(accountId);
  if (clearIdentity) {
    clearFeishuBotIdentityState(accountId);
  }
}

function waitForFeishuWsCycleEnd(params: {
  abortSignal?: AbortSignal;
  terminalError: Promise<Error>;
}): Promise<"abort" | Error> {
  if (params.abortSignal?.aborted) {
    return Promise.resolve("abort");
  }

  return new Promise((resolve) => {
    let settled = false;

    const finish = (result: "abort" | Error) => {
      if (settled) {
        return;
      }
      settled = true;
      if (handleAbort) {
        params.abortSignal?.removeEventListener("abort", handleAbort);
      }
      resolve(result);
    };

    const handleAbort: (() => void) | undefined = () => finish("abort");
    params.abortSignal?.addEventListener("abort", handleAbort, { once: true });
    if (params.abortSignal?.aborted) {
      finish("abort");
      return;
    }

    void params.terminalError.then(finish);
  });
}

export async function monitorWebSocket({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
  setSocketTerminator,
  statusSink,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;

  let attempt = 0;
  while (true) {
    if (abortSignal?.aborted) {
      break;
    }

    let wsClient: Lark.WSClient | undefined;
    try {
      let reportTerminalError: (err: Error) => void = () => {};
      const terminalError = new Promise<Error>((resolve) => {
        reportTerminalError = resolve;
      });
      const handleWsError = (err: Error) => {
        if (isFeishuWsTerminalError(err)) {
          reportTerminalError(err);
          return;
        }

        error(
          `feishu[${accountId}]: WebSocket SDK reported recoverable error: ${formatFeishuWsErrorForLog(err)}`,
        );
      };
      const publishWsConnected = () => {
        const connectedAt = Date.now();
        statusSink?.(
          channelReadyPatch({
            lastConnectedAt: connectedAt,
            lastEventAt: connectedAt,
          }),
        );
      };
      const publishWsReconnecting = () => {
        const reconnectingAt = Date.now();
        statusSink?.({
          connected: false,
          lifecycle: "recovering",
          lastEventAt: reconnectingAt,
        });
      };
      log(`feishu[${accountId}]: starting WebSocket connection...`);
      wsClient = await createFeishuWSClient(account, {
        onError: handleWsError,
        onReady: publishWsConnected,
        onReconnected: publishWsConnected,
        onReconnecting: publishWsReconnecting,
      });
      setSocketTerminator?.(() => wsClient?.close({ force: true }));
      if (abortSignal?.aborted) {
        cleanupFeishuWsClient({ accountId, wsClient, error, clearIdentity: true });
        break;
      }
      wsClients.set(accountId, wsClient);
      await wsClient.start({ eventDispatcher });
      attempt = 0;
      log(`feishu[${accountId}]: WebSocket client started`);
      const cycleEnd = await waitForFeishuWsCycleEnd({ abortSignal, terminalError });
      if (cycleEnd === "abort") {
        log(`feishu[${accountId}]: abort signal received, stopping`);
        cleanupFeishuWsClient({ accountId, wsClient, error, clearIdentity: true });
        setSocketTerminator?.(undefined);
        return;
      }

      cleanupFeishuWsClient({ accountId, wsClient, error, clearIdentity: false });
      setSocketTerminator?.(undefined);
      if (abortSignal?.aborted) {
        break;
      }

      // WS cycle ended via terminal error (not abort) — publish disconnected
      // so the health monitor can flag the channel before the next reconnect.
      const disconnectedAt = Date.now();
      statusSink?.(
        channelBlockedPatch(formatFeishuWsErrorForLog(cycleEnd), {
          connected: false,
          lastEventAt: disconnectedAt,
        }),
      );

      attempt += 1;
      const delayMs = getFeishuWsReconnectDelayMs(attempt);
      error(
        `feishu[${accountId}]: WebSocket connection ended, recreating client in ${delayMs}ms: ${formatFeishuWsErrorForLog(cycleEnd)}`,
      );
      const shouldRetry = await waitForAbortableDelay(delayMs, abortSignal);
      if (!shouldRetry) {
        break;
      }
    } catch (err) {
      cleanupFeishuWsClient({ accountId, wsClient, error, clearIdentity: false });
      setSocketTerminator?.(undefined);
      if (abortSignal?.aborted) {
        break;
      }

      // WS start failed (e.g. handshake / auth) — publish disconnected.
      const failedAt = Date.now();
      // The SDK classifier is the only terminal contract here. App-secret/auth refinement is
      // deferred until Feishu exposes a structured authentication failure at this boundary.
      const terminal = err instanceof Error && isFeishuWsTerminalError(err);
      statusSink?.({
        connected: false,
        lifecycle: terminal ? "blocked" : "recovering",
        ...(terminal ? { terminalDisconnect: true } : {}),
        lastEventAt: failedAt,
        lastError: formatFeishuWsErrorForLog(err),
      });

      attempt += 1;
      const delayMs = getFeishuWsReconnectDelayMs(attempt);
      error(
        `feishu[${accountId}]: WebSocket start failed, retrying in ${delayMs}ms: ${formatFeishuWsErrorForLog(err)}`,
      );
      const shouldRetry = await waitForAbortableDelay(delayMs, abortSignal);
      if (!shouldRetry) {
        break;
      }
    }
  }
  cleanupFeishuWsClient({ accountId, wsClient: undefined, error, clearIdentity: true });
  setSocketTerminator?.(undefined);
}

export async function monitorWebhook({
  account,
  accountId,
  runtime,
  abortSignal,
  eventDispatcher,
  invokeWebhookEvent,
  statusSink,
}: MonitorTransportParams): Promise<void> {
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const encryptKey = account.encryptKey?.trim();
  if (!encryptKey) {
    throw new Error(`Feishu account "${accountId}" webhook mode requires encryptKey`);
  }

  const port = account.config.webhookPort ?? 3000;
  const path = account.config.webhookPath ?? DEFAULT_FEISHU_WEBHOOK_PATH;
  if (normalizeFeishuWebhookPath(path) !== path) {
    throw new Error(
      `Feishu account "${accountId}" webhookPath must be a canonical HTTP request path; ` +
        'run "openclaw doctor --fix" to repair it',
    );
  }
  const host = account.config.webhookHost ?? "127.0.0.1";

  log(`feishu[${accountId}]: starting Webhook server on ${host}:${port}, path ${path}...`);

  const server = http.createServer();

  server.on("request", (req, res) => {
    const requestUrl = req.url ?? "/";
    const requestPath = requestUrl.split("?", 1)[0];
    // Explicit query routes retain Lark's exact raw-target contract; path-only
    // routes accept queries without normalizing attacker-controlled targets.
    const requestRoute = path.includes("?") ? requestUrl : requestPath;
    if (!requestPath?.startsWith("/") || requestUrl.includes("#") || requestRoute !== path) {
      respondText(res, 404, "Not Found");
      return;
    }

    // Transport-owned rejections close without finish. Anomaly counts describe
    // selected error outcomes, not successful delivery to the client.
    res.once("close", () => {
      recordWebhookStatus(runtime, accountId, path, res.statusCode);
    });
    res.once("finish", () => {
      // Refresh lastEventAt / lastTransportActivityAt on every successful 2xx
      // response so the gateway health monitor sees inbound activity. Non-2xx
      // (e.g. 401 invalid signature, 400 invalid JSON, 429 rate-limited) is
      // intentionally NOT counted as transport activity.
      if (res.statusCode >= 200 && res.statusCode < 300) {
        const inboundAt = Date.now();
        statusSink?.({
          lastEventAt: inboundAt,
          lastTransportActivityAt: inboundAt,
        });
      }
    });

    const rateLimitKey = buildFeishuWebhookRateLimitKey({
      accountId,
      path,
      clientIp: resolveRequestClientIp(req),
    });
    if (
      !applyBasicWebhookRequestGuards({
        req,
        res,
        allowMethods: ["POST"],
        rateLimiter: feishuWebhookRateLimiter,
        rateLimitKey,
        nowMs: Date.now(),
        requireJsonContentType: true,
      })
    ) {
      return;
    }

    const guard = installRequestBodyLimitGuard(req, res, {
      maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
      timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
      responseFormat: "text",
    });
    if (guard.isTripped()) {
      return;
    }

    void (async () => {
      try {
        const body = await readWebhookBodyOrReject({
          req,
          res,
          maxBytes: FEISHU_WEBHOOK_MAX_BODY_BYTES,
          timeoutMs: FEISHU_WEBHOOK_BODY_TIMEOUT_MS,
          profile: "pre-auth",
        });
        if (!body.ok || res.writableEnded) {
          return;
        }
        if (guard.isTripped()) {
          return;
        }
        const rawBody = body.value;

        // Reject invalid signatures before any JSON parsing to keep the auth boundary strict.
        if (
          !isFeishuWebhookSignatureValid({
            headers: req.headers,
            rawBody,
            encryptKey,
          })
        ) {
          respondText(res, 401, "Invalid signature");
          return;
        }

        const payload = parseFeishuWebhookPayload(rawBody);
        if (!payload) {
          respondText(res, 400, "Invalid JSON");
          return;
        }

        const { isChallenge, challenge } = Lark.generateChallenge(payload, {
          encryptKey,
        });
        if (isChallenge) {
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(challenge));
          return;
        }

        const envelope = buildFeishuWebhookEnvelope(req, payload);
        const invocation = invokeWebhookEvent
          ? await invokeWebhookEvent(envelope, { needCheck: false })
          : {
              kind: "non-durable" as const,
              value: await eventDispatcher.invoke(envelope, { needCheck: false }),
            };
        if (!res.headersSent) {
          if (invocation.kind === "durable") {
            // The ingress owner records this fact at admission; challenges and
            // non-durable event types ack without claiming durable acceptance.
            res.setHeader(FEISHU_WEBHOOK_ACCEPTED_HEADER, FEISHU_WEBHOOK_ACCEPTED_VALUE);
          }
          res.statusCode = 200;
          res.setHeader("Content-Type", "application/json; charset=utf-8");
          res.end(JSON.stringify(invocation.value));
        }
      } catch (err) {
        error(`feishu[${accountId}]: webhook handler error: ${String(err)}`);
        if (!res.headersSent) {
          respondText(res, 500, "Internal Server Error");
        }
      } finally {
        guard.dispose();
      }
    })();
  });

  httpServers.set(accountId, server);

  return await new Promise<void>((resolve, reject) => {
    let cleanupStarted = false;
    const cleanup = async () => {
      if (cleanupStarted) {
        return;
      }
      cleanupStarted = true;
      await closeTrackedFeishuHttpServer(accountId, server);
    };

    const handleAbort = () => {
      log(`feishu[${accountId}]: abort signal received, stopping Webhook server`);
      cleanup().then(resolve, reject);
    };

    if (abortSignal?.aborted) {
      cleanup().then(resolve, reject);
      return;
    }

    abortSignal?.addEventListener("abort", handleAbort, { once: true });

    server.listen(port, host, () => {
      log(`feishu[${accountId}]: Webhook server listening on ${host}:${port}`);
      // Publish connected + lastEventAt once the server is listening. Without
      // this, the gateway health monitor has no transport signal for webhook
      // mode and will not detect a server crash. See PROPOSAL.md.
      const webhookConnectedAt = Date.now();
      statusSink?.(
        channelReadyPatch({
          lastConnectedAt: webhookConnectedAt,
          lastEventAt: webhookConnectedAt,
        }),
      );
    });

    server.on("error", (err) => {
      error(`feishu[${accountId}]: Webhook server error: ${err}`);
      statusSink?.({
        connected: false,
        lifecycle: "recovering",
        lastError: formatFeishuWsErrorForLog(err),
      });
      abortSignal?.removeEventListener("abort", handleAbort);
      reject(err);
    });
  });
}
