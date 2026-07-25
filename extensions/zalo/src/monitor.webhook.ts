// Zalo plugin module implements monitor.webhook behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/security-runtime";
import { readWebhookBodyOrReject } from "openclaw/plugin-sdk/webhook-request-guards";
import type { ResolvedZaloAccount } from "./accounts.js";
import type { ZaloRuntimeEnv } from "./monitor.types.js";
import {
  createFixedWindowRateLimiter,
  createWebhookAnomalyTracker,
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
import { ZaloWebhookPayloadError } from "./webhook-spool.js";

type ZaloWebhookTarget = {
  account: ResolvedZaloAccount;
  config: OpenClawConfig;
  runtime: ZaloRuntimeEnv;
  secret: string;
  path: string;
  acceptWebhook: (rawEvent: string) => Promise<void>;
};

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

function clearZaloWebhookSecurityStateForTest(): void {
  webhookRateLimiter.clear();
  webhookAnomalyTracker.clear();
}

function getZaloWebhookRateLimitStateSizeForTest(): number {
  return webhookRateLimiter.size();
}

function getZaloWebhookStatusCounterSizeForTest(): number {
  return webhookAnomalyTracker.size();
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

function registerZaloWebhookTarget(
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

async function handleZaloWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
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
      const body = await readWebhookBodyOrReject({
        req,
        res,
        maxBytes: 1024 * 1024,
        timeoutMs: 30_000,
        invalidBodyMessage: "Bad Request",
      });
      if (!body.ok) {
        recordWebhookStatus(target.runtime, path, res.statusCode);
        return true;
      }
      try {
        // Ack only after the raw envelope is durably appended. The spool reserves
        // detached drain work before this request's admission root is released.
        await target.acceptWebhook(body.value);
      } catch (error) {
        res.statusCode = error instanceof ZaloWebhookPayloadError ? 400 : 500;
        res.end(res.statusCode === 400 ? "Bad Request" : "Internal Server Error");
        recordWebhookStatus(target.runtime, path, res.statusCode);
        target.runtime.error?.(
          `[${target.account.accountId}] Zalo webhook admission failed: ${String(error)}`,
        );
        return true;
      }

      res.statusCode = 200;
      res.end("ok");
      return true;
    },
  });
}

export const zaloWebhookRuntime = {
  clearZaloWebhookSecurityStateForTest,
  getZaloWebhookRateLimitStateSizeForTest,
  getZaloWebhookStatusCounterSizeForTest,
  handleZaloWebhookRequest,
  registerZaloWebhookTarget,
};
