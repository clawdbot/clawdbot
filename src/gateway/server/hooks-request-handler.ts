import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveHookExternalContentSource as resolveHookExternalContentSourceFromSession } from "../../security/external-content.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
} from "../auth-rate-limit.js";
import { applyHookMappings } from "../hooks-mapping.js";
import {
  extractHookToken,
  getHookAgentPolicyError,
  getHookChannelError,
  getHookSessionKeyPrefixError,
  type HookAgentDispatchPayload,
  type HooksConfigResolved,
  isHookAgentAllowed,
  isSessionKeyAllowedByPrefix,
  normalizeAgentPayload,
  normalizeHookDispatchSessionKey,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveHookChannel,
  resolveHookDeliver,
  resolveHookIdempotencyKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
} from "../hooks.js";
import { resolveRequestClientIp } from "../net.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

export type HookClientIpConfig = Readonly<{
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}>;

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

type HookReplayEntry = {
  ts: number;
  runId: string;
};

type HookReplayScope = {
  pathKey: string;
  token: string | undefined;
  idempotencyKey?: string;
  dispatchScope: Record<string, unknown>;
};

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function resolveMappedHookExternalContentSource(params: {
  subPath: string;
  payload: Record<string, unknown>;
  sessionKey: string;
}) {
  const payloadSource =
    typeof params.payload.source === "string" ? params.payload.source.trim().toLowerCase() : "";
  if (params.subPath === "gmail" || payloadSource === "gmail") {
    return "gmail" as const;
  }
  return resolveHookExternalContentSourceFromSession(params.sessionKey) ?? "webhook";
}

export function createHooksRequestHandler(
  opts: {
    getHooksConfig: () => HooksConfigResolved | null;
    bindHost: string;
    port: number;
    logHooks: SubsystemLogger;
    getClientIpConfig?: () => HookClientIpConfig;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
  const hookReplayCache = new Map<string, HookReplayEntry>();
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    const clientIpConfig = getClientIpConfig?.();
    const clientIp =
      resolveRequestClientIp(
        req,
        clientIpConfig?.trustedProxies,
        clientIpConfig?.allowRealIpFallback === true,
      ) ?? req.socket?.remoteAddress;
    return normalizeRateLimitClientIp(clientIp);
  };

  const pruneHookReplayCache = (now: number) => {
    const cutoff = now - DEDUPE_TTL_MS;
    for (const [key, entry] of hookReplayCache) {
      if (entry.ts < cutoff) {
        hookReplayCache.delete(key);
      }
    }
    while (hookReplayCache.size > DEDUPE_MAX) {
      const oldestKey = hookReplayCache.keys().next().value;
      if (!oldestKey) {
        break;
      }
      hookReplayCache.delete(oldestKey);
    }
  };

  const buildHookReplayCacheKey = (params: HookReplayScope): string | undefined => {
    const idem = params.idempotencyKey?.trim();
    if (!idem) {
      return undefined;
    }
    const tokenFingerprint = createHash("sha256")
      .update(params.token ?? "", "utf8")
      .digest("hex");
    const idempotencyFingerprint = createHash("sha256").update(idem, "utf8").digest("hex");
    const scopeFingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          pathKey: params.pathKey,
          dispatchScope: params.dispatchScope,
        }),
        "utf8",
      )
      .digest("hex");
    return `${tokenFingerprint}:${scopeFingerprint}:${idempotencyFingerprint}`;
  };

  const resolveCachedHookRunId = (key: string | undefined, now: number): string | undefined => {
    if (!key) {
      return undefined;
    }
    pruneHookReplayCache(now);
    const cached = hookReplayCache.get(key);
    if (!cached) {
      return undefined;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, cached);
    return cached.runId;
  };

  const rememberHookRunId = (key: string | undefined, runId: string, now: number) => {
    if (!key) {
      return;
    }
    hookReplayCache.delete(key);
    hookReplayCache.set(key, { ts: now, runId });
    pruneHookReplayCache(now);
  };

  return async (req, res) => {
    const hooksConfig = getHooksConfig();
    if (!hooksConfig) {
      return false;
    }
    // Only pathname/search are used here; keep the base host fixed so bind-host
    // representation (e.g. IPv6 wildcards) cannot break request parsing.
    const url = new URL(req.url ?? "/", "http://localhost");
    const basePath = hooksConfig.basePath;
    if (url.pathname !== basePath && !url.pathname.startsWith(`${basePath}/`)) {
      return false;
    }

    if (url.searchParams.has("token")) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end(
        "Hook token must be provided via Authorization: Bearer <token> or X-OpenClaw-Token header (query parameters are not allowed).",
      );
      return true;
    }

    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Allow", "POST");
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Method Not Allowed");
      return true;
    }

    const token = extractHookToken(req);
    const clientKey = resolveHookClientKey(req);
    if (!safeEqualSecret(token, hooksConfig.token)) {
      const throttle = hookAuthLimiter.check(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      if (!throttle.allowed) {
        const retryAfter = throttle.retryAfterMs > 0 ? Math.ceil(throttle.retryAfterMs / 1000) : 1;
        res.statusCode = 429;
        res.setHeader("Retry-After", String(retryAfter));
        res.setHeader("Content-Type", "text/plain; charset=utf-8");
        res.end("Too Many Requests");
        logHooks.warn(`hook auth throttled for ${clientKey}; retry-after=${retryAfter}s`);
        return true;
      }
      hookAuthLimiter.recordFailure(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);
      res.statusCode = 401;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Unauthorized");
      return true;
    }
    hookAuthLimiter.reset(clientKey, AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH);

    const subPath = url.pathname.slice(basePath.length).replace(/^\/+/, "");
    if (!subPath) {
      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
      return true;
    }

    const body = await readJsonBody(req, hooksConfig.maxBodyBytes);
    if (!body.ok) {
      const status =
        body.error === "payload too large"
          ? 413
          : body.error === "request body timeout"
            ? 408
            : 400;
      sendJson(res, status, { ok: false, error: body.error });
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);
    const idempotencyKey = resolveHookIdempotencyKey({
      payload: payload as Record<string, unknown>,
      headers,
    });
    const now = Date.now();

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      dispatchWakeHook(normalized.value);
      sendJson(res, 200, { ok: true, mode: normalized.value.mode });
      return true;
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      if (!isHookAgentAllowed(hooksConfig, normalized.value.agentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return true;
      }
      const sessionKey = resolveHookSessionKey({
        hooksConfig,
        source: "request",
        sessionKey: normalized.value.sessionKey,
      });
      if (!sessionKey.ok) {
        sendJson(res, 400, { ok: false, error: sessionKey.error });
        return true;
      }
      const targetAgentId = resolveHookTargetAgentId(hooksConfig, normalized.value.agentId);
      const replayKey = buildHookReplayCacheKey({
        pathKey: "agent",
        token,
        idempotencyKey,
        dispatchScope: {
          agentId: targetAgentId ?? null,
          sessionKey:
            normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
          message: normalized.value.message,
          name: normalized.value.name,
          wakeMode: normalized.value.wakeMode,
          deliver: normalized.value.deliver,
          channel: normalized.value.channel,
          to: normalized.value.to ?? null,
          model: normalized.value.model ?? null,
          thinking: normalized.value.thinking ?? null,
          timeoutSeconds: normalized.value.timeoutSeconds ?? null,
        },
      });
      const cachedRunId = resolveCachedHookRunId(replayKey, now);
      if (cachedRunId) {
        sendJson(res, 200, { ok: true, runId: cachedRunId });
        return true;
      }
      const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
        sessionKey: sessionKey.value,
        targetAgentId,
      });
      const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
      if (
        allowedPrefixes &&
        !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
      ) {
        sendJson(res, 400, { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) });
        return true;
      }
      const runId = dispatchAgentHook({
        ...normalized.value,
        idempotencyKey,
        sessionKey: normalizedDispatchSessionKey,
        agentId: targetAgentId,
        externalContentSource: "webhook",
      });
      rememberHookRunId(replayKey, runId, now);
      sendJson(res, 200, { ok: true, runId });
      return true;
    }

    if (hooksConfig.mappings.length > 0) {
      try {
        const mapped = await applyHookMappings(hooksConfig.mappings, {
          payload: payload as Record<string, unknown>,
          headers,
          url,
          path: subPath,
        });
        if (mapped) {
          if (!mapped.ok) {
            sendJson(res, 400, { ok: false, error: mapped.error });
            return true;
          }
          if (mapped.action === null) {
            res.statusCode = 204;
            res.end();
            return true;
          }
          if (mapped.action.kind === "wake") {
            dispatchWakeHook({
              text: mapped.action.text,
              mode: mapped.action.mode,
            });
            sendJson(res, 200, { ok: true, mode: mapped.action.mode });
            return true;
          }
          const channel = resolveHookChannel(mapped.action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          if (!isHookAgentAllowed(hooksConfig, mapped.action.agentId)) {
            sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source:
              mapped.action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
            sessionKey: mapped.action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const targetAgentId = resolveHookTargetAgentId(hooksConfig, mapped.action.agentId);
          const normalizedDispatchSessionKey = normalizeHookDispatchSessionKey({
            sessionKey: sessionKey.value,
            targetAgentId,
          });
          const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
          if (
            allowedPrefixes &&
            !isSessionKeyAllowedByPrefix(normalizedDispatchSessionKey, allowedPrefixes)
          ) {
            sendJson(res, 400, { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) });
            return true;
          }
          const replayKey = buildHookReplayCacheKey({
            pathKey: subPath || "mapping",
            token,
            idempotencyKey,
            dispatchScope: {
              agentId: targetAgentId ?? null,
              sessionKey:
                mapped.action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
              message: mapped.action.message,
              name: mapped.action.name ?? "Hook",
              wakeMode: mapped.action.wakeMode,
              deliver: resolveHookDeliver(mapped.action.deliver),
              channel,
              to: mapped.action.to ?? null,
              model: mapped.action.model ?? null,
              thinking: mapped.action.thinking ?? null,
              timeoutSeconds: mapped.action.timeoutSeconds ?? null,
            },
          });
          const cachedRunId = resolveCachedHookRunId(replayKey, now);
          if (cachedRunId) {
            sendJson(res, 200, { ok: true, runId: cachedRunId });
            return true;
          }
          const runId = dispatchAgentHook({
            message: mapped.action.message,
            name: mapped.action.name ?? "Hook",
            idempotencyKey,
            agentId: targetAgentId,
            wakeMode: mapped.action.wakeMode,
            sessionKey: normalizedDispatchSessionKey,
            deliver: resolveHookDeliver(mapped.action.deliver),
            channel,
            to: mapped.action.to,
            model: mapped.action.model,
            thinking: mapped.action.thinking,
            timeoutSeconds: mapped.action.timeoutSeconds,
            allowUnsafeExternalContent: mapped.action.allowUnsafeExternalContent,
            externalContentSource: resolveMappedHookExternalContentSource({
              subPath,
              payload: payload as Record<string, unknown>,
              sessionKey: sessionKey.value,
            }),
          });
          rememberHookRunId(replayKey, runId, now);
          sendJson(res, 200, { ok: true, runId });
          return true;
        }
      } catch (err) {
        logHooks.warn(`hook mapping failed: ${String(err)}`);
        sendJson(res, 500, { ok: false, error: "hook mapping failed" });
        return true;
      }
    }

    res.statusCode = 404;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Not Found");
    return true;
  };
}
