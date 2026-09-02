// Hook request handler validates hook tokens, applies mappings, dedupes requests, and dispatches wake or agent work.
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { sendHttpRequestRejection } from "../../infra/http-request-lifecycle.js";
import { pruneMapToMaxSize } from "../../infra/map-size.js";
import type { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveHookExternalContentSource as resolveHookExternalContentSourceFromSession } from "../../security/external-content.js";
import { safeEqualSecret } from "../../security/secret-equal.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
} from "../auth-rate-limit.js";
import { applyHookMappings, HOOK_MAPPING_FAN_OUT_MAX_ITEMS } from "../hooks-mapping.js";
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
  resolveHookPathBodyLimit,
  resolveHookSessionKey,
} from "../hooks.js";
import { sendJson } from "../http-common.js";
import { readPreparedGatewayIngressAttribution } from "../ingress-attribution.js";
import { resolveRequestClientIp } from "../net.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "../server-constants.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

// gog's hook HTTP client aborts after 10 seconds (gogcli
// internal/cmd/gmail_watch_types.go defaultHookRequestTimeoutSec) and treats
// the abort as delivery failure, rewinding its history cursor. A fan-out batch
// must answer inside that window; items still admitting at the deadline are
// reported as pending (non-2xx) and finish in the background, where the replay
// cache reconciles them with the producer's redelivery.
const HOOK_FAN_OUT_RESPONSE_DEADLINE_MS = 8_000;
// Marker for replay keys derived from item content when the producer supplies
// no idempotency key; item identity lives in the dispatch-scope fingerprint.
const HOOK_FAN_OUT_DERIVED_IDEMPOTENCY = "hook-fanout-item";

const FAN_OUT_PENDING = Symbol("hook-fanout-pending");
type FanOutSettled = HookAgentDispatchResult | typeof FAN_OUT_PENDING;

async function settleFanOutDispatches(
  dispatches: Array<Promise<HookAgentDispatchResult>>,
  deadlineMs: number,
): Promise<FanOutSettled[]> {
  // Rejections must settle to failures even when the race already resolved
  // pending, or the detached dispatch promise rejects unhandled later.
  const guarded = dispatches.map((dispatch) =>
    dispatch.catch(
      (err: unknown): HookAgentDispatchResult => ({
        ok: false,
        statusCode: 502,
        error: String(err),
      }),
    ),
  );
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<typeof FAN_OUT_PENDING>((resolve) => {
    deadlineTimer = setTimeout(() => resolve(FAN_OUT_PENDING), deadlineMs);
    deadlineTimer.unref?.();
  });
  try {
    return await Promise.all(guarded.map((dispatch) => Promise.race([dispatch, deadline])));
  } finally {
    if (deadlineTimer) {
      clearTimeout(deadlineTimer);
    }
  }
}

function sendAgentResult(
  res: ServerResponse,
  result: HookAgentDispatchResult & Partial<WakeResult>,
) {
  if (result.ok) {
    sendJson(res, 200, result);
    return;
  }
  const { statusCode, ...body } = result;
  sendJson(res, statusCode, body);
}

function sendFanOutResult(res: ServerResponse, settled: FanOutSettled[], wake?: WakeResult) {
  const first = settled[0];
  if (settled.length === 1 && first !== undefined && first !== FAN_OUT_PENDING) {
    // Single-item batches keep the exact single-dispatch response shape.
    sendAgentResult(res, { ...first, ...wake });
    return;
  }
  const runIds: string[] = [];
  const failures: Array<Extract<HookAgentDispatchResult, { ok: false }>> = [];
  let pending = 0;
  for (const result of settled) {
    if (result === FAN_OUT_PENDING) {
      pending += 1;
    } else if (result.ok) {
      runIds.push(result.runId);
    } else {
      failures.push(result);
    }
  }
  if (failures.length === 0 && pending === 0) {
    const result = { ok: true, runId: runIds[0], runIds, dispatched: runIds.length };
    sendJson(res, 200, { ...result, ...wake });
    return;
  }
  // A non-2xx makes the producer redeliver the batch; already-dispatched items
  // then replay from the cache instead of running twice.
  const failure = failures[0];
  sendJson(res, failure ? failure.statusCode : 503, {
    ok: false,
    error: `hook fan-out incomplete: ${runIds.length}/${settled.length} dispatched, ${failures.length} failed, ${pending} pending`,
    runIds,
    ...(failures.length > 0 ? { errors: failures.slice(0, 5).map((entry) => entry.error) } : {}),
    ...wake,
  });
}

export type HookClientIpConfig = Readonly<{
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}>;

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type WakeResult = { eventOutcome: "queued" | "coalesced" };

type HookDispatchers = {
  dispatchWakeHook: (
    value: { text: string; mode: "now" | "next-heartbeat"; sessionKey?: string },
    agentId: string,
  ) => WakeResult;
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
    fanoutResponseDeadlineMs?: number;
  } & HookDispatchers,
): HooksRequestHandler {
  const { getHooksConfig, logHooks, dispatchAgentHook, dispatchWakeHook, getClientIpConfig } = opts;
  const fanoutResponseDeadlineMs =
    opts.fanoutResponseDeadlineMs ?? HOOK_FAN_OUT_RESPONSE_DEADLINE_MS;
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

    // gmail-path mappings carry a producer-derived bound (gog batch contract);
    // every other path keeps the shared default cap.
    const body = await readJsonBody(req, resolveHookPathBodyLimit(hooksConfig, subPath));
    if (!body.ok) {
      const error = { ok: false, error: body.error };
      if (body.error === "payload too large" || body.error === "request body timeout") {
        await sendHttpRequestRejection(
          req,
          res,
          body.error === "payload too large" ? 413 : 408,
          JSON.stringify(error),
          "application/json; charset=utf-8",
        );
      } else {
        sendJson(res, 400, error);
      }
      return true;
    }

    const payload = typeof body.value === "object" && body.value !== null ? body.value : {};
    const headers = normalizeHookHeaders(req);
    const idempotencyKey = resolveHookIdempotencyKey({
      payload: payload as Record<string, unknown>,
      headers,
    });
    const now = Date.now();
    // Later mapped validation errors must report any wake outcome that already occurred.
    let wakeResult: WakeResult | undefined;
    const sendHookError = (error: string) =>
      sendJson(res, 400, { ok: false, error, ...wakeResult });
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
        sendHookError(getHookSessionKeyPrefixError(allowedPrefixes));
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
        sendHookError(resolution.error);
        return null;
      }
      if (!isHookAgentAllowed(hooksConfig, resolution.effectiveAgentId)) {
        sendHookError(getHookAgentPolicyError());
        return null;
      }
      return resolution;
    };
    // Callers own the success response so mappings can dispatch several wakes first.
    const dispatchWake = (
      value: Parameters<HookDispatchers["dispatchWakeHook"]>[0],
      targetAgentId: string,
      source: HookSessionKeySource,
    ): WakeResult | null => {
      let dispatchSessionKey: string | undefined;
      if (value.sessionKey) {
        const sessionKey = resolveHookSessionKey({
          hooksConfig,
          source,
          sessionKey: value.sessionKey,
        });
        if (!sessionKey.ok) {
          sendHookError(sessionKey.error);
          return null;
        }
        const resolvedSessionKey = resolveDispatchSessionKeyOrRespond(
          sessionKey.value,
          targetAgentId,
        );
        if (resolvedSessionKey === null) {
          return null;
        }
        dispatchSessionKey = resolvedSessionKey;
      }
      const dispatchValue = { ...value, sessionKey: dispatchSessionKey };
      return dispatchWakeHook(dispatchValue, targetAgentId);
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
      const directWakeResult = dispatchWake(normalized.value, target.effectiveAgentId, "request");
      if (!directWakeResult) {
        return true;
      }
      sendJson(res, 200, { ok: true, mode: normalized.value.mode, ...directWakeResult });
      return true;
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
        sendAgentResult(res, await replay);
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
      sendAgentResult(res, dispatched);
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
          if (mapped.dropped > 0) {
            logHooks.warn(
              `hook mapping ${subPath} fan-out dropped ${mapped.dropped} items beyond the ${HOOK_MAPPING_FAN_OUT_MAX_ITEMS}-item cap`,
            );
          }
          if (mapped.actions.length === 0) {
            if (mapped.fanout) {
              logHooks.info(`hook mapping ${subPath} matched with no items to dispatch`);
            }
            res.statusCode = 204;
            res.end();
            return true;
          }
          // Within-batch duplicates: content identity alone would collapse two
          // identical rendered items into one dispatch while the response
          // claims both ran. Numbering repeated scopes keeps one replay entry
          // per occurrence, and identical redeliveries renumber identically.
          const fanOutScopeOccurrences = new Map<string, number>();
          // Resolves policy for one mapped agent action and returns its
          // dispatch closure; a null return means an error response was sent.
          const prepareMappedAgentDispatchOrRespond = (
            action: Extract<(typeof mapped.actions)[number], { kind: "agent" }>,
          ): (() => HookAgentDispatchResult | Promise<HookAgentDispatchResult>) | null => {
            const channel = resolveHookChannel(action.channel);
            if (!channel) {
              sendHookError(getHookChannelError());
              return null;
            }
            const deliver = resolveHookDeliver(action.deliver);
            const delivery = deliver
              ? { mode: "announce" as const, channel, to: action.to }
              : { mode: "none" as const };
            const target = resolveTargetAgentOrRespond(action.agentId, "mapping");
            if (!target) {
              return null;
            }
            if (
              action.sessionMode === "persistent" &&
              !action.sessionKey &&
              !hooksConfig.sessionPolicy.defaultSessionKey
            ) {
              sendHookError(
                "sessionKey or hooks.defaultSessionKey is required when mapped hook sessionMode is persistent",
              );
              return null;
            }
            const sessionKey = resolveHookSessionKey({
              hooksConfig,
              source: action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
              sessionKey: action.sessionKey,
            });
            if (!sessionKey.ok) {
              sendHookError(sessionKey.error);
              return null;
            }
            const dispatchSessionKey = resolveDispatchSessionKeyOrRespond(
              sessionKey.value,
              target.effectiveAgentId,
            );
            if (dispatchSessionKey === null) {
              return null;
            }
            const dispatchScope: Record<string, unknown> = {
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
            };
            if (mapped.fanout) {
              const fingerprint = JSON.stringify(dispatchScope);
              const occurrence = fanOutScopeOccurrences.get(fingerprint) ?? 0;
              fanOutScopeOccurrences.set(fingerprint, occurrence + 1);
              dispatchScope.occurrence = occurrence;
            }
            const replayKey = buildHookReplayCacheKey({
              pathKey: subPath || "mapping",
              token,
              // Fan-out producers (gog gmail) send no idempotency key, yet a
              // non-2xx batch response makes them redeliver the same batch.
              // Deriving item identity from the dispatch scope lets retries
              // replay already-dispatched items instead of duplicating them.
              idempotencyKey: mapped.fanout
                ? (idempotencyKey ?? HOOK_FAN_OUT_DERIVED_IDEMPOTENCY)
                : idempotencyKey,
              dispatchScope,
            });
            return () =>
              dispatchAgentHookWithReplay(replayKey, now, () =>
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
                  mappingId: action.mappingId,
                  allowUnsafeExternalContent: action.allowUnsafeExternalContent,
                  ...(mapped.fanout ? { admissionMode: "background" as const } : {}),
                  externalContentSource: resolveMappedHookExternalContentSource({
                    subPath,
                    sessionKey: sessionKey.value,
                  }),
                }),
              );
          };

          // One pass over every action so a per-item transform emitting mixed
          // kinds loses nothing: wakes dispatch immediately (no replay
          // identity — a producer retry after a partial agent failure
          // dispatches them again), agents collect for dispatch.
          const dispatches: Array<
            () => HookAgentDispatchResult | Promise<HookAgentDispatchResult>
          > = [];
          let wakeMode: "now" | "next-heartbeat" | undefined;
          for (const action of mapped.actions) {
            if (action.kind === "wake") {
              const target = resolveTargetAgentOrRespond(action.agentId, "mapping");
              if (!target) {
                return true;
              }
              const dispatched = dispatchWake(
                { text: action.text, mode: action.mode, sessionKey: action.sessionKey },
                target.effectiveAgentId,
                action.sessionKeySource === "static" ? "mapping-static" : "mapping-templated",
              );
              if (!dispatched) {
                return true;
              }
              if (!wakeResult || dispatched.eventOutcome === "queued") {
                wakeResult = dispatched;
              }
              wakeMode = action.mode;
              continue;
            }
            const prepared = prepareMappedAgentDispatchOrRespond(action);
            if (!prepared) {
              return true;
            }
            dispatches.push(prepared);
          }
          if (dispatches.length === 0) {
            sendJson(res, 200, { ok: true, mode: wakeMode ?? "now", ...wakeResult });
            return true;
          }
          if (!mapped.fanout) {
            // Non-fanout mappings produce exactly one action.
            const dispatched = await dispatches[0]!();
            sendAgentResult(res, { ...dispatched, ...wakeResult });
            return true;
          }
          const settled = await settleFanOutDispatches(
            dispatches.map((dispatch) => Promise.resolve(dispatch())),
            fanoutResponseDeadlineMs,
          );
          sendFanOutResult(res, settled, wakeResult);
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
