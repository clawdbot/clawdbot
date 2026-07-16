// Zalo plugin module implements monitor.webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { createChannelReplayGuard } from "openclaw/plugin-sdk/persistent-dedupe";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { runDetachedWebhookWork } from "openclaw/plugin-sdk/webhook-request-guards";
import type { ResolvedZaloAccount } from "./accounts.js";
import type { ZaloFetch, ZaloUpdate } from "./api.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
  readJsonWebhookBodyOrReject,
  applyBasicWebhookRequestGuards,
  registerWebhookTargetWithPluginRoute,
  type RegisterWebhookTargetOptions,
  type RegisterWebhookPluginRouteOptions,
  registerWebhookTarget,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
  WEBHOOK_ANOMALY_COUNTER_DEFAULTS,
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  resolveClientIp,
  type OpenClawConfig,
} from "./runtime-api.js";

const ZALO_WEBHOOK_REPLAY_WINDOW_MS = 5 * 60_000;

type ZaloWebhookTarget = {
  token: string;
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  core: unknown;
  secret: string;
  path: string;
  webhookUrl: string;
  webhookPath: string;
  mediaMaxMb: number;
  canHostMedia: boolean;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  fetcher?: ZaloFetch;
};

export type ZaloWebhookProcessUpdate = (params: {
  update: ZaloUpdate;
  target: ZaloWebhookTarget;
}) => Promise<void>;

const webhookTargets = new Map<string, ZaloWebhookTarget[]>();
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});
const webhookAnomalyTracker = createWebhookAnomalyTracker({
  maxTrackedKeys: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.maxTrackedKeys,
  ttlMs: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.ttlMs,
  logEvery: WEBHOOK_ANOMALY_COUNTER_DEFAULTS.logEvery,
});

export function clearZaloWebhookSecurityStateForTest(): void {
  webhookRateLimiter.clear();
  recentWebhookEvents.clearMemory();
  webhookAnomalyTracker.clear();
}

export function getZaloWebhookRateLimitStateSizeForTest(): number {
  return webhookRateLimiter.size();
}

export function getZaloWebhookStatusCounterSizeForTest(): number {
  return webhookAnomalyTracker.size();
}

function buildReplayEventCacheKey(target: ZaloWebhookTarget, update: ZaloUpdate): string | null {
  const messageId = update.message?.message_id;
  if (!messageId) {
    return null;
  }
  const chatId = update.message?.chat?.id ?? "";
  const senderId = update.message?.from?.id ?? "";
  return JSON.stringify([
    target.path,
    target.account.accountId,
    update.event_name,
    chatId,
    senderId,
    messageId,
  ]);
}

const recentWebhookEvents = createChannelReplayGuard<{
  target: ZaloWebhookTarget;
  update: ZaloUpdate;
}>({
  dedupe: {
    ttlMs: ZALO_WEBHOOK_REPLAY_WINDOW_MS,
    memoryMaxSize: 5000,
  },
  buildReplayKey: ({ target, update }) => buildReplayEventCacheKey(target, update),
});

export class ZaloRetryableWebhookError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ZaloRetryableWebhookError";
  }
}

async function processZaloReplayGuardedUpdate(params: {
  target: ZaloWebhookTarget;
  update: ZaloUpdate;
  processUpdate: ZaloWebhookProcessUpdate;
  nowMs?: number;
}): Promise<"processed" | "duplicate"> {
  const event = { target: params.target, update: params.update };
  const result = await recentWebhookEvents.processGuarded(
    event,
    async () => {
      params.target.statusSink?.({ lastInboundAt: Date.now() });
      await params.processUpdate(event);
    },
    {
      dedupe: { now: params.nowMs },
      onError: (error) => (error instanceof ZaloRetryableWebhookError ? "release" : "commit"),
    },
  );
  return result.kind === "processed" ? "processed" : "duplicate";
}

function recordWebhookStatus(
  runtime: ZaloRuntimeEnv | undefined,
  path: string,
  statusCode: number,
): void {
  webhookAnomalyTracker.record({
    key: `${path}:${statusCode}`,
    statusCode,
    log: runtime?.log,
    message: (count) =>
      `[zalo] webhook anomaly path=${path} status=${statusCode} count=${String(count)}`,
  });
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function registerZaloWebhookTarget(
  target: ZaloWebhookTarget,
  opts?: {
    route?: RegisterWebhookPluginRouteOptions;
  } & Pick<
    RegisterWebhookTargetOptions<ZaloWebhookTarget>,
    "onFirstPathTarget" | "onLastPathTargetRemoved"
  >,
): () => void {
  if (opts?.route) {
    return registerWebhookTargetWithPluginRoute({
      targetsByPath: webhookTargets,
      target,
      route: opts.route,
      onLastPathTargetRemoved: opts.onLastPathTargetRemoved,
    }).unregister;
  }
  return registerWebhookTarget(webhookTargets, target, opts).unregister;
}

export async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
  processUpdate: ZaloWebhookProcessUpdate,
): Promise<boolean> {
  return await withResolvedWebhookRequestPipeline({
    req,
    res,
    targetsByPath: webhookTargets,
    allowMethods: ["POST"],
    handle: async ({ targets, path }) => {
      const trustedProxies = targets[0]?.config.gateway?.trustedProxies;
      const allowRealIpFallback = targets[0]?.config.gateway?.allowRealIpFallback === true;
      const clientIp =
        resolveClientIp({
          remoteAddr: req.socket.remoteAddress,
          forwardedFor: headerValue(req.headers["x-forwarded-for"]),
          realIp: headerValue(req.headers["x-real-ip"]),
          trustedProxies,
          allowRealIpFallback,
        }) ??
        req.socket.remoteAddress ??
        "unknown";
      const rateLimitKey = `${path}:${clientIp}`;
      const nowMs = Date.now();
      if (
        !applyBasicWebhookRequestGuards({
          req,
          res,
          rateLimiter: webhookRateLimiter,
          rateLimitKey,
          nowMs,
        })
      ) {
        recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
        return true;
      }

      const headerToken = String(req.headers["x-bot-api-secret-token"] ?? "");
      const target = resolveWebhookTargetWithAuthOrRejectSync({
        targets,
        res,
        isMatch: (entry) => safeEqualSecret(entry.secret, headerToken),
      });
      if (!target) {
        recordWebhookStatus(targets[0]?.runtime, path, res.statusCode);
        return true;
      }
      // Preserve the historical 401-before-415 ordering for invalid secrets while still
      // consuming rate-limit budget on unauthenticated guesses.
      if (
        !applyBasicWebhookRequestGuards({
          req,
          res,
          requireJsonContentType: true,
        })
      ) {
        recordWebhookStatus(target.runtime, path, res.statusCode);
        return true;
      }
      const body = await readJsonWebhookBodyOrReject({
        req,
        res,
        maxBytes: 1024 * 1024,
        timeoutMs: 30_000,
        emptyObjectOnEmpty: false,
        invalidJsonMessage: "Bad Request",
      });
      if (!body.ok) {
        recordWebhookStatus(target.runtime, path, res.statusCode);
        return true;
      }
      const raw = body.value;

      // Zalo sends updates directly as { event_name, message, ... }, not wrapped in { ok, result }.
      const record = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null;
      const update: ZaloUpdate | undefined =
        record && record.ok === true && record.result
          ? (record.result as ZaloUpdate)
          : ((record as ZaloUpdate | null) ?? undefined);

      if (!update?.event_name) {
        res.statusCode = 400;
        res.end("Bad Request");
        recordWebhookStatus(target.runtime, path, res.statusCode);
        return true;
      }

      // Reserve the detached task before the HTTP admission is released;
      // otherwise later queue work inherits a released admission root.
      void runDetachedWebhookWork(() =>
        processZaloReplayGuardedUpdate({
          target,
          update,
          processUpdate,
          nowMs,
        }),
      ).catch((err: unknown) => {
        target.runtime.error?.(`[${target.account.accountId}] Zalo webhook failed: ${String(err)}`);
      });

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });
}
