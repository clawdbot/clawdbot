import type { IncomingMessage, ServerResponse } from "node:http";
import { safeEqualSecret } from "openclaw/plugin-sdk/browser-security-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { resolveBlueBubblesEffectiveAllowPrivateNetwork } from "./accounts.js";
import { createBlueBubblesDebounceRegistry } from "./monitor-debounce.js";
import {
  asRecord,
  normalizeWebhookMessage,
  normalizeWebhookReaction,
} from "./monitor-normalize.js";
import { logVerbose, processMessage, processReaction } from "./monitor-processing.js";
import {
  _resetBlueBubblesShortIdState,
  resolveBlueBubblesMessageId,
} from "./monitor-reply-cache.js";
import {
  DEFAULT_WEBHOOK_PATH,
  normalizeWebhookPath,
  resolveWebhookPathFromConfig,
  type BlueBubblesMonitorOptions,
  type WebhookTarget,
} from "./monitor-shared.js";
import { fetchBlueBubblesServerInfo } from "./probe.js";
import { getBlueBubblesRuntime } from "./runtime.js";
import {
  WEBHOOK_RATE_LIMIT_DEFAULTS,
  createFixedWindowRateLimiter,
  createWebhookInFlightLimiter,
  registerWebhookTargetWithPluginRoute,
  readWebhookBodyOrReject,
  resolveRequestClientIp,
  resolveWebhookTargetWithAuthOrRejectSync,
  withResolvedWebhookRequestPipeline,
} from "./webhook-ingress.js";

const webhookTargets = new Map<string, WebhookTarget[]>();
const webhookRateLimiter = createFixedWindowRateLimiter({
  windowMs: WEBHOOK_RATE_LIMIT_DEFAULTS.windowMs,
  maxRequests: WEBHOOK_RATE_LIMIT_DEFAULTS.maxRequests,
  maxTrackedKeys: WEBHOOK_RATE_LIMIT_DEFAULTS.maxTrackedKeys,
});
const webhookInFlightLimiter = createWebhookInFlightLimiter();
const debounceRegistry = createBlueBubblesDebounceRegistry({ processMessage });

export function clearBlueBubblesWebhookSecurityStateForTest(): void {
  webhookRateLimiter.clear();
  webhookInFlightLimiter.clear();
}

export function registerBlueBubblesWebhookTarget(target: WebhookTarget): () => void {
  const registered = registerWebhookTargetWithPluginRoute({
    targetsByPath: webhookTargets,
    target,
    route: {
      auth: "plugin",
      match: "exact",
      pluginId: "bluebubbles",
      source: "bluebubbles-webhook",
      accountId: target.account.accountId,
      log: target.runtime.log,
      handler: async (req, res) => {
        const handled = await handleBlueBubblesWebhookRequest(req, res);
        if (!handled && !res.headersSent) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "text/plain; charset=utf-8");
          res.end("Not Found");
        }
      },
    },
  });
  return () => {
    registered.unregister();
    // Clean up debouncer when target is unregistered
    debounceRegistry.removeDebouncer(registered.target);
  };
}

function parseBlueBubblesWebhookPayload(
  rawBody: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = rawBody.trim();
  if (!trimmed) {
    return { ok: false, error: "empty payload" };
  }
  try {
    return { ok: true, value: JSON.parse(trimmed) as unknown };
  } catch {
    const params = new URLSearchParams(rawBody);
    const payload = params.get("payload") ?? params.get("data") ?? params.get("message");
    if (!payload) {
      return { ok: false, error: "invalid json" };
    }
    try {
      return { ok: true, value: JSON.parse(payload) as unknown };
    } catch (error) {
      return { ok: false, error: formatErrorMessage(error) };
    }
  }
}

function maskSecret(value: string): string {
  if (value.length <= 6) {
    return "***";
  }
  return `${value.slice(0, 2)}***${value.slice(-2)}`;
}

function normalizeAuthToken(raw: string): string {
  const value = raw.trim();
  if (!value) {
    return "";
  }
  if (normalizeLowercaseStringOrEmpty(value).startsWith("bearer ")) {
    return value.slice("bearer ".length).trim();
  }
  return value;
}

function safeEqualAuthToken(aRaw: string, bRaw: string): boolean {
  const a = normalizeAuthToken(aRaw);
  const b = normalizeAuthToken(bRaw);
  if (!a || !b) {
    return false;
  }
  return safeEqualSecret(a, b);
}

function collectTrustedProxies(targets: readonly WebhookTarget[]): string[] {
  const proxies = new Set<string>();
  for (const target of targets) {
    for (const proxy of target.config.gateway?.trustedProxies ?? []) {
      const normalized = proxy.trim();
      if (normalized) {
        proxies.add(normalized);
      }
    }
  }
  return [...proxies];
}

function resolveWebhookAllowRealIpFallback(targets: readonly WebhookTarget[]): boolean {
  return targets.some((target) => target.config.gateway?.allowRealIpFallback === true);
}

function resolveWebhookClientIp(
  req: IncomingMessage,
  trustedProxies: readonly string[],
  allowRealIpFallback: boolean,
): string {
  if (!req.headers["x-forwarded-for"] && !(allowRealIpFallback && req.headers["x-real-ip"])) {
    return req.socket.remoteAddress ?? "unknown";
  }

  // Mirror gateway client-IP trust rules so limiter buckets follow configured proxy hops.
  return (
    resolveRequestClientIp(req, [...trustedProxies], allowRealIpFallback) ??
    req.socket.remoteAddress ??
    "unknown"
  );
}

export async function handleBlueBubblesWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const requestUrl = new URL(req.url ?? "/", "http://localhost");
  const normalizedPath = normalizeWebhookPath(requestUrl.pathname);
  const pathTargets = webhookTargets.get(normalizedPath) ?? [];
  const trustedProxies = collectTrustedProxies(pathTargets);
  const allowRealIpFallback = resolveWebhookAllowRealIpFallback(pathTargets);
  const clientIp = resolveWebhookClientIp(req, trustedProxies, allowRealIpFallback);
  const rateLimitKey = `${normalizedPath}:${clientIp}`;
  return await withResolvedWebhookRequestPipeline({
    req,
    res,
    targetsByPath: webhookTargets,
    allowMethods: ["POST"],
    rateLimiter: webhookRateLimiter,
    rateLimitKey,
    inFlightLimiter: webhookInFlightLimiter,
    inFlightKey: `${normalizedPath}:${clientIp}`,
    handle: async ({ path, targets }) => {
      const url = requestUrl;
      const guidParam = url.searchParams.get("guid") ?? url.searchParams.get("password");
      const headerToken =
        req.headers["x-guid"] ??
        req.headers["x-password"] ??
        req.headers["x-bluebubbles-guid"] ??
        req.headers["authorization"];
      const guid = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? guidParam ?? "";
      const target = resolveWebhookTargetWithAuthOrRejectSync({
        targets,
        res,
        isMatch: (target) => {
          const token = target.account.config.password?.trim() ?? "";
          return safeEqualAuthToken(guid, token);
        },
      });
      if (!target) {
        console.warn(
          `[bluebubbles] webhook rejected: status=${res.statusCode} path=${path} guid=${maskSecret(url.searchParams.get("guid") ?? url.searchParams.get("password") ?? "")}`,
        );
        return true;
      }
      const body = await readWebhookBodyOrReject({
        req,
        res,
        profile: "post-auth",
        invalidBodyMessage: "invalid payload",
      });
      if (!body.ok) {
        console.warn(`[bluebubbles] webhook rejected: status=${res.statusCode}`);
        return true;
      }

      const parsed = parseBlueBubblesWebhookPayload(body.value);
      if (!parsed.ok) {
        res.statusCode = 400;
        res.end(parsed.error);
        console.warn(`[bluebubbles] webhook rejected: ${parsed.error}`);
        return true;
      }

      const payload = asRecord(parsed.value) ?? {};
      const firstTarget = targets[0];
      if (firstTarget) {
        logVerbose(
          firstTarget.core,
          firstTarget.runtime,
          `webhook received path=${path} keys=${Object.keys(payload).join(",") || "none"}`,
        );
      }
      const eventTypeRaw = payload.type;
      const eventType = typeof eventTypeRaw === "string" ? eventTypeRaw.trim() : "";
      const allowedEventTypes = new Set([
        "new-message",
        "updated-message",
        "message-reaction",
        "reaction",
      ]);
      if (eventType && !allowedEventTypes.has(eventType)) {
        res.statusCode = 200;
        res.end("ok");
        if (firstTarget) {
          logVerbose(firstTarget.core, firstTarget.runtime, `webhook ignored type=${eventType}`);
        }
        return true;
      }
      const reaction = normalizeWebhookReaction(payload);
      // Normalize the webhook message early so the attachment-update detection
      // below sees attachments under any supported wrapper format (`payload.data`,
      // `payload.message`, `payload.data.message`, JSON-string payloads), not just
      // raw `payload.data.attachments`. (#65430, #67510)
      const message = reaction ? null : normalizeWebhookMessage(payload, { eventType });
      // BlueBubbles fires `updated-message` when attachments are indexed after the
      // initial `new-message` (which may arrive with attachments: []). Let those
      // through so the agent can ingest the image. (#65430)
      const isAttachmentUpdate =
        eventType === "updated-message" && (message?.attachments?.length ?? 0) > 0;
      if (
        (eventType === "updated-message" ||
          eventType === "message-reaction" ||
          eventType === "reaction") &&
        !reaction &&
        !isAttachmentUpdate
      ) {
        res.statusCode = 200;
        res.end("ok");
        if (firstTarget) {
          logVerbose(
            firstTarget.core,
            firstTarget.runtime,
            `webhook ignored ${eventType || "event"} (no reaction or attachment update)`,
          );
        }
        return true;
      }
      if (!message && !reaction) {
        res.statusCode = 400;
        res.end("invalid payload");
        console.warn("[bluebubbles] webhook rejected: unable to parse message payload");
        return true;
      }

      target.statusSink?.({ lastInboundAt: Date.now() });
      if (reaction) {
        processReaction(reaction, target).catch((err) => {
          target.runtime.error?.(
            `[${target.account.accountId}] BlueBubbles reaction failed: ${String(err)}`,
          );
        });
      } else if (message) {
        // Route messages through debouncer to coalesce rapid-fire events
        // (e.g., text message + URL balloon arriving as separate webhooks)
        const debouncer = debounceRegistry.getOrCreateDebouncer(target);
        debouncer.enqueue({ message, target }).catch((err) => {
          target.runtime.error?.(
            `[${target.account.accountId}] BlueBubbles webhook failed: ${String(err)}`,
          );
        });
      }

      res.statusCode = 200;
      res.end("ok");
      if (reaction) {
        if (firstTarget) {
          logVerbose(
            firstTarget.core,
            firstTarget.runtime,
            `webhook accepted reaction sender=${reaction.senderId} msg=${reaction.messageId} action=${reaction.action}`,
          );
        }
      } else if (message) {
        if (firstTarget) {
          logVerbose(
            firstTarget.core,
            firstTarget.runtime,
            `webhook accepted sender=${message.senderId} group=${message.isGroup} chatGuid=${message.chatGuid ?? ""} chatId=${message.chatId ?? ""}`,
          );
        }
      }
      return true;
    },
  });
}

export async function monitorBlueBubblesProvider(
  options: BlueBubblesMonitorOptions,
): Promise<void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getBlueBubblesRuntime();
  const path = options.webhookPath?.trim() || DEFAULT_WEBHOOK_PATH;
  const allowPrivateNetwork = resolveBlueBubblesEffectiveAllowPrivateNetwork({
    baseUrl: account.baseUrl,
    config: account.config,
  });

  // Fetch and cache server info (for macOS version detection in action gating)
  const serverInfo = await fetchBlueBubblesServerInfo({
    baseUrl: account.baseUrl,
    password: account.config.password,
    accountId: account.accountId,
    timeoutMs: 5000,
    allowPrivateNetwork,
  }).catch(() => null);
  if (serverInfo?.os_version) {
    runtime.log?.(`[${account.accountId}] BlueBubbles server macOS ${serverInfo.os_version}`);
  }
  if (typeof serverInfo?.private_api === "boolean") {
    runtime.log?.(
      `[${account.accountId}] BlueBubbles Private API ${serverInfo.private_api ? "enabled" : "disabled"}`,
    );
  }

  const target: WebhookTarget = {
    account,
    config,
    runtime,
    core,
    path,
    statusSink,
  };
  const unregister = registerBlueBubblesWebhookTarget(target);

  return await new Promise((resolve) => {
    const stop = () => {
      unregister();
      resolve();
    };

    if (abortSignal?.aborted) {
      stop();
      return;
    }

    abortSignal?.addEventListener("abort", stop, { once: true });
    runtime.log?.(
      `[${account.accountId}] BlueBubbles webhook listening on ${normalizeWebhookPath(path)}`,
    );

    // Kick off a catchup pass for messages delivered while the webhook
    // target wasn't reachable. Fire-and-forget; the catchup runs through the
    // same processMessage path webhooks use, and #66230's inbound dedupe
    // drops any GUID that was already handled, so this is safe even if a
    // live webhook raced the startup replay. See #66721.
    import("./catchup.js")
      .then(({ runBlueBubblesCatchup }) => runBlueBubblesCatchup(target))
      .catch((err) => {
        runtime.error?.(
          `[${account.accountId}] BlueBubbles catchup: unexpected failure: ${String(err)}`,
        );
      });
  });
}

export { _resetBlueBubblesShortIdState, resolveBlueBubblesMessageId, resolveWebhookPathFromConfig };
