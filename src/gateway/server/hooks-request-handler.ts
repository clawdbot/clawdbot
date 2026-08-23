// Hook request handler validates hook tokens, applies mappings, dedupes requests, and dispatches wake or agent work.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { closeRequestAfterResponse } from "../../infra/http-body.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
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
  type HookSessionKeySource,
  type HookTargetAgentResolution,
  type HooksConfigResolved,
  isHookAgentAllowed,
  isSessionKeyAllowedByPrefix,
  normalizeAgentPayload,
  normalizeHookDispatchSessionKey,
  normalizeHookHeaders,
  normalizeWakePayload,
  readJsonBody,
  resolveEffectiveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
  resolveHookIdempotencyKey,
  resolveHookSessionKey,
} from "../hooks.js";
import { sendJson } from "../http-common.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
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
  dispatchWakeHook: (
    value: { text: string; mode: "now" | "next-heartbeat"; sessionKey?: string },
    agentId: string,
  ) => void;
  dispatchAgentHook: (
    value: HookAgentDispatchPayload,
  ) => HookAgentDispatchResult | Promise<HookAgentDispatchResult>;
};

export type HookAgentDispatchResult =
  | { ok: true; runId: string }
  | { ok: false; statusCode: 400 | 409 | 502 | 503; error: string; runId?: string };

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

function resolveMappedHookExternalContentSource(params: { subPath: string; sessionKey: string }) {
  if (params.subPath === "gmail") {
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
  const pendingHookReplays = new Map<string, Promise<HookAgentDispatchResult>>();
  const hookAuthLimiter = createAuthRateLimiter({
    maxAttempts: HOOK_AUTH_FAILURE_LIMIT,
    windowMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    lockoutMs: HOOK_AUTH_FAILURE_WINDOW_MS,
    exemptLoopback: false,
    // Handler lifetimes are tied to gateway runtime/tests; skip background timer fanout.
    pruneIntervalMs: 0,
  });

  const resolveHookClientKey = (req: IncomingMessage): string => {
    const attribution = readPreparedGatewayIngressAttribution(req);
    if (attribution && attribution.kind !== "unattributable-proxy") {
      return normalizeRateLimitClientIp(attribution.rateLimit.subject.key);
    }
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
    pruneMapToMaxSize(hookReplayCache, DEDUPE_MAX);
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

  const resolveHookReplay = (
    key: string | undefined,
    now: number,
  ): HookAgentDispatchResult | Promise<HookAgentDispatchResult> | undefined => {
    if (!key) {
      return undefined;
    }
    const cachedRunId = resolveCachedHookRunId(key, now);
    if (cachedRunId) {
      return { ok: true, runId: cachedRunId };
    }
    return pendingHookReplays.get(key);
  };

  const dispatchAgentHookWithReplay = (
    key: string | undefined,
    now: number,
    dispatch: () => HookAgentDispatchResult | Promise<HookAgentDispatchResult>,
  ): HookAgentDispatchResult | Promise<HookAgentDispatchResult> => {
    if (!key) {
      return dispatch();
    }
    const existing = resolveHookReplay(key, now);
    if (existing) {
      return existing;
    }
    const pending = Promise.resolve()
      .then(dispatch)
      .then((result) => {
        if (result.ok) {
          rememberHookRunId(key, result.runId, now);
        }
        return result;
      })
      .finally(() => {
        // Failed admission stays retryable; identity guards against deleting a newer replay.
        if (pendingHookReplays.get(key) === pending) {
          pendingHookReplays.delete(key);
        }
      });
    pendingHookReplays.set(key, pending);
    return pending;
  };

  const sendAgentDispatchResult = (res: ServerResponse, result: HookAgentDispatchResult) => {
    if (result.ok) {
      sendJson(res, 200, { ok: true, runId: result.runId });
      return;
    }
    sendJson(res, result.statusCode, {
      ok: false,
      error: result.error,
      ...(result.runId ? { runId: result.runId } : {}),
    });
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
      if (status === 413 || status === 408) {
        closeRequestAfterResponse(req, res);
      }
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
    const resolveDispatchSessionKeyOrRespond = (
      sessionKeyValue: string,
      targetAgentId: string,
    ): string | null => {
      const dispatchSessionKey = normalizeHookDispatchSessionKey({
        sessionKey: sessionKeyValue,
        targetAgentId,
      });
      const allowedPrefixes = hooksConfig.sessionPolicy.allowedSessionKeyPrefixes;
      if (allowedPrefixes && !isSessionKeyAllowedByPrefix(dispatchSessionKey, allowedPrefixes)) {
        sendJson(res, 400, { ok: false, error: getHookSessionKeyPrefixError(allowedPrefixes) });
        return null;
      }
      return dispatchSessionKey;
    };
    const resolveTargetAgentOrRespond = (
      agentId: string | undefined,
      source: "request" | "mapping",
    ): Extract<HookTargetAgentResolution, { ok: true }> | null => {
      const resolution = resolveEffectiveHookTargetAgentId(hooksConfig, agentId, source);
      if (!resolution.ok) {
        sendJson(res, 400, { ok: false, error: resolution.error });
        return null;
      }
      if (!isHookAgentAllowed(hooksConfig, resolution.effectiveAgentId)) {
        sendJson(res, 400, { ok: false, error: getHookAgentPolicyError() });
        return null;
      }
      return resolution;
    };
    const dispatchWakeOrRespond = (
      value: Parameters<HookDispatchers["dispatchWakeHook"]>[0],
      targetAgentId: string,
      source: HookSessionKeySource,
    ): true => {
      let dispatchSessionKey: string | undefined;
      if (value.sessionKey) {
        const sessionKey = resolveHookSessionKey({
          hooksConfig,
          source,
          sessionKey: value.sessionKey,
        });
        if (!sessionKey.ok) {
          sendJson(res, 400, { ok: false, error: sessionKey.error });
          return true;
        }
        const resolvedSessionKey = resolveDispatchSessionKeyOrRespond(
          sessionKey.value,
          targetAgentId,
        );
        if (resolvedSessionKey === null) {
          return true;
        }
        dispatchSessionKey = resolvedSessionKey;
      }
      dispatchWakeHook(
        {
          text: value.text,
          mode: value.mode,
          ...(dispatchSessionKey ? { sessionKey: dispatchSessionKey } : {}),
        },
        targetAgentId,
      );
      sendJson(res, 200, { ok: true, mode: value.mode });
      return true;
    };

    if (subPath === "wake") {
      const normalized = normalizeWakePayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const target = resolveTargetAgentOrRespond(normalized.value.agentId, "request");
      if (!target) {
        return true;
      }
      return dispatchWakeOrRespond(normalized.value, target.effectiveAgentId, "request");
    }

    if (subPath === "agent") {
      const normalized = normalizeAgentPayload(payload as Record<string, unknown>);
      if (!normalized.ok) {
        sendJson(res, 400, { ok: false, error: normalized.error });
        return true;
      }
      const target = resolveTargetAgentOrRespond(normalized.value.agentId, "request");
      if (!target) {
        return true;
      }
      if (normalized.value.sessionMode === "persistent" && !normalized.value.sessionKey) {
        sendJson(res, 400, {
          ok: false,
          error: "sessionKey is required when sessionMode is persistent",
        });
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
      if (
        normalized.value.sessionMode === "persistent" &&
        !hooksConfig.sessionPolicy.allowedSessionKeyPrefixes?.length
      ) {
        sendJson(res, 400, {
          ok: false,
          error:
            "hooks.allowedSessionKeyPrefixes is required when direct hook sessionMode is persistent",
        });
        return true;
      }
      const replayKey = buildHookReplayCacheKey({
        pathKey: "agent",
        token,
        idempotencyKey,
        dispatchScope: {
          agentId: target.effectiveAgentId,
          sessionKey:
            normalized.value.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
          message: normalized.value.message,
          name: normalized.value.name,
          wakeMode: normalized.value.wakeMode,
          sessionMode: normalized.value.sessionMode,
          deliver: normalized.value.deliver,
          channel: normalized.value.channel,
          to: normalized.value.to ?? null,
          accountId: normalized.value.accountId ?? null,
          model: normalized.value.model ?? null,
          thinking: normalized.value.thinking ?? null,
          timeoutSeconds: normalized.value.timeoutSeconds ?? null,
        },
      });
      const replay = resolveHookReplay(replayKey, now);
      if (replay) {
        sendAgentDispatchResult(res, await replay);
        return true;
      }
      const dispatchSessionKey = resolveDispatchSessionKeyOrRespond(
        sessionKey.value,
        target.effectiveAgentId,
      );
      if (dispatchSessionKey === null) {
        return true;
      }
      const dispatched = await dispatchAgentHookWithReplay(replayKey, now, () =>
        dispatchAgentHook({
          ...normalized.value,
          effectiveAgentId: target.effectiveAgentId,
          idempotencyKey,
          sessionKey: dispatchSessionKey,
          sourcePath: `${basePath}/agent`,
          agentId: target.selectedAgentId,
          externalContentSource: "webhook",
        }),
      );
      sendAgentDispatchResult(res, dispatched);
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
            const action = mapped.action;
            const target = resolveTargetAgentOrRespond(action.agentId, "mapping");
            if (!target) {
              return true;
            }
            return dispatchWakeOrRespond(
              {
                text: action.text,
                mode: action.mode,
                sessionKey: action.sessionKey,
              },
              target.effectiveAgentId,
              action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
            );
          }
          const action = mapped.action;
          const channel = resolveHookChannel(action.channel);
          if (!channel) {
            sendJson(res, 400, { ok: false, error: getHookChannelError() });
            return true;
          }
          const deliver = resolveHookDeliver(action.deliver);
          const delivery = deliver
            ? {
                mode: "announce" as const,
                channel,
                to: action.to,
              }
            : { mode: "none" as const };
          const target = resolveTargetAgentOrRespond(action.agentId, "mapping");
          if (!target) {
            return true;
          }
          if (
            mapped.action.sessionMode === "persistent" &&
            !mapped.action.sessionKey &&
            !hooksConfig.sessionPolicy.defaultSessionKey
          ) {
            sendJson(res, 400, {
              ok: false,
              error:
                "sessionKey or hooks.defaultSessionKey is required when mapped hook sessionMode is persistent",
            });
            return true;
          }
          const sessionKey = resolveHookSessionKey({
            hooksConfig,
            source: action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
            sessionKey: action.sessionKey,
          });
          if (!sessionKey.ok) {
            sendJson(res, 400, { ok: false, error: sessionKey.error });
            return true;
          }
          const dispatchSessionKey = resolveDispatchSessionKeyOrRespond(
            sessionKey.value,
            target.effectiveAgentId,
          );
          if (dispatchSessionKey === null) {
            return true;
          }
          const replayKey = buildHookReplayCacheKey({
            pathKey: subPath || "mapping",
            token,
            idempotencyKey,
            dispatchScope: {
              agentId: target.effectiveAgentId,
              sessionKey: action.sessionKey ?? hooksConfig.sessionPolicy.defaultSessionKey ?? null,
              message: action.message,
              name: action.name ?? "Hook",
              wakeMode: action.wakeMode,
              sessionMode: action.sessionMode,
              deliver,
              channel,
              to: action.to ?? null,
              model: action.model ?? null,
              thinking: action.thinking ?? null,
              timeoutSeconds: action.timeoutSeconds ?? null,
            },
          });
          const replay = resolveHookReplay(replayKey, now);
          if (replay) {
            sendAgentDispatchResult(res, await replay);
            return true;
          }
          const dispatched = await dispatchAgentHookWithReplay(replayKey, now, () =>
            dispatchAgentHook({
              message: action.message,
              name: action.name ?? "Hook",
              idempotencyKey,
              agentId: target.selectedAgentId,
              effectiveAgentId: target.effectiveAgentId,
              wakeMode: action.wakeMode,
              sessionKey: dispatchSessionKey,
              sessionMode: action.sessionMode,
              sourcePath: `${basePath}/${subPath}`,
              deliver,
              channel,
              to: action.to,
              delivery,
              model: action.model,
              thinking: action.thinking,
              timeoutSeconds: action.timeoutSeconds,
              allowUnsafeExternalContent: action.allowUnsafeExternalContent,
              externalContentSource: resolveMappedHookExternalContentSource({
                subPath,
                sessionKey: sessionKey.value,
              }),
            }),
          );
          sendAgentDispatchResult(res, dispatched);
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
