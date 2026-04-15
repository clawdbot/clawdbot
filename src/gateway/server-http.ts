import { createHash } from "node:crypto";
import {
  createServer as createHttpServer,
  type Server as HttpServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { createServer as createHttpsServer } from "node:https";
import type { TlsOptions } from "node:tls";
import type { WebSocketServer } from "ws";
import { A2UI_PATH, CANVAS_WS_PATH, handleA2uiHttpRequest } from "../canvas-host/a2ui.js";
import type { CanvasHostHandler } from "../canvas-host/server.js";
import { loadConfig } from "../config/config.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { createSubsystemLogger } from "../logging/subsystem.js";
import { resolveHookExternalContentSource as resolveHookExternalContentSourceFromSession } from "../security/external-content.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { resolveAssistantIdentity } from "./assistant-identity.js";
import {
  AUTH_RATE_LIMIT_SCOPE_HOOK_AUTH,
  createAuthRateLimiter,
  normalizeRateLimitClientIp,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import {
  authorizeHttpGatewayConnect,
  isLocalDirectRequest,
  type GatewayAuthResult,
  type ResolvedGatewayAuth,
} from "./auth.js";
import { normalizeCanvasScopedUrl } from "./canvas-capability.js";
import type { ControlUiRootState } from "./control-ui.js";
import { applyHookMappings } from "./hooks-mapping.js";
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
  normalizeHookHeaders,
  resolveHookIdempotencyKey,
  normalizeWakePayload,
  readJsonBody,
  normalizeHookDispatchSessionKey,
  resolveHookSessionKey,
  resolveHookTargetAgentId,
  resolveHookChannel,
  resolveHookDeliver,
} from "./hooks.js";
import { sendGatewayAuthFailure, setDefaultSecurityHeaders } from "./http-common.js";
import {
  type AuthorizedGatewayHttpRequest,
  authorizeGatewayHttpRequestOrReply,
  getBearerToken,
  resolveHttpBrowserOriginPolicy,
} from "./http-utils.js";
import { resolveRequestClientIp } from "./net.js";
import { DEDUPE_MAX, DEDUPE_TTL_MS } from "./server-constants.js";
import { authorizeCanvasRequest, isCanvasPath } from "./server/http-auth.js";
import { resolvePluginRouteRuntimeOperatorScopes } from "./server/plugin-route-runtime-scopes.js";
import {
  isProtectedPluginRoutePathFromContext,
  resolvePluginRoutePathContext,
  type PluginHttpRequestHandler,
  type PluginRoutePathContext,
} from "./server/plugins-http.js";
import type { PreauthConnectionBudget } from "./server/preauth-connection-budget.js";
import type { ReadinessChecker } from "./server/readiness.js";
import type { GatewayWsClient } from "./server/ws-types.js";

type SubsystemLogger = ReturnType<typeof createSubsystemLogger>;

const HOOK_AUTH_FAILURE_LIMIT = 20;
const HOOK_AUTH_FAILURE_WINDOW_MS = 60_000;

let bundledChannelsModulePromise:
  | Promise<typeof import("../channels/plugins/bundled.js")>
  | undefined;
let identityAvatarModulePromise: Promise<typeof import("../agents/identity-avatar.js")> | undefined;
let controlUiModulePromise: Promise<typeof import("./control-ui.js")> | undefined;
let embeddingsHttpModulePromise: Promise<typeof import("./embeddings-http.js")> | undefined;
let modelsHttpModulePromise: Promise<typeof import("./models-http.js")> | undefined;
let openAiHttpModulePromise: Promise<typeof import("./openai-http.js")> | undefined;
let openResponsesHttpModulePromise: Promise<typeof import("./openresponses-http.js")> | undefined;
let sessionHistoryHttpModulePromise:
  | Promise<typeof import("./sessions-history-http.js")>
  | undefined;
let sessionKillHttpModulePromise: Promise<typeof import("./session-kill-http.js")> | undefined;
let toolsInvokeHttpModulePromise: Promise<typeof import("./tools-invoke-http.js")> | undefined;

function getBundledChannelsModule() {
  bundledChannelsModulePromise ??= import("../channels/plugins/bundled.js");
  return bundledChannelsModulePromise;
}

function getIdentityAvatarModule() {
  identityAvatarModulePromise ??= import("../agents/identity-avatar.js");
  return identityAvatarModulePromise;
}

function getControlUiModule() {
  controlUiModulePromise ??= import("./control-ui.js");
  return controlUiModulePromise;
}

function getEmbeddingsHttpModule() {
  embeddingsHttpModulePromise ??= import("./embeddings-http.js");
  return embeddingsHttpModulePromise;
}

function getModelsHttpModule() {
  modelsHttpModulePromise ??= import("./models-http.js");
  return modelsHttpModulePromise;
}

function getOpenAiHttpModule() {
  openAiHttpModulePromise ??= import("./openai-http.js");
  return openAiHttpModulePromise;
}

function getOpenResponsesHttpModule() {
  openResponsesHttpModulePromise ??= import("./openresponses-http.js");
  return openResponsesHttpModulePromise;
}

function getSessionHistoryHttpModule() {
  sessionHistoryHttpModulePromise ??= import("./sessions-history-http.js");
  return sessionHistoryHttpModulePromise;
}

function getSessionKillHttpModule() {
  sessionKillHttpModulePromise ??= import("./session-kill-http.js");
  return sessionKillHttpModulePromise;
}

function getToolsInvokeHttpModule() {
  toolsInvokeHttpModulePromise ??= import("./tools-invoke-http.js");
  return toolsInvokeHttpModulePromise;
}

type HookDispatchers = {
  dispatchWakeHook: (value: { text: string; mode: "now" | "next-heartbeat" }) => void;
  dispatchAgentHook: (value: HookAgentDispatchPayload) => string;
};

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

export type HookClientIpConfig = Readonly<{
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
}>;

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

const GATEWAY_PROBE_STATUS_BY_PATH = new Map<string, "live" | "ready">([
  ["/health", "live"],
  ["/healthz", "live"],
  ["/ready", "ready"],
  ["/readyz", "ready"],
]);
async function resolvePluginGatewayAuthBypassPaths(
  configSnapshot: OpenClawConfig,
): Promise<Set<string>> {
  const paths = new Set<string>();
  const { listBundledChannelPlugins } = await getBundledChannelsModule();
  for (const plugin of listBundledChannelPlugins()) {
    for (const path of plugin.gateway?.resolveGatewayAuthBypassPaths?.({ cfg: configSnapshot }) ??
      []) {
      if (typeof path === "string" && path.trim()) {
        paths.add(path.trim());
      }
    }
  }
  return paths;
}

function isOpenAiModelsPath(pathname: string): boolean {
  return pathname === "/v1/models" || pathname.startsWith("/v1/models/");
}

function isEmbeddingsPath(pathname: string): boolean {
  return pathname === "/v1/embeddings";
}

function isOpenAiChatCompletionsPath(pathname: string): boolean {
  return pathname === "/v1/chat/completions";
}

function isOpenResponsesPath(pathname: string): boolean {
  return pathname === "/v1/responses";
}

function isToolsInvokePath(pathname: string): boolean {
  return pathname === "/tools/invoke";
}

function isSessionKillPath(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/kill$/.test(pathname);
}

function isSessionHistoryPath(pathname: string): boolean {
  return /^\/sessions\/[^/]+\/history$/.test(pathname);
}

function isA2uiPath(pathname: string): boolean {
  return pathname === A2UI_PATH || pathname.startsWith(`${A2UI_PATH}/`);
}

function shouldEnforceDefaultPluginGatewayAuth(pathContext: PluginRoutePathContext): boolean {
  return (
    pathContext.malformedEncoding ||
    pathContext.decodePassLimitReached ||
    isProtectedPluginRoutePathFromContext(pathContext)
  );
}

async function canRevealReadinessDetails(params: {
  req: IncomingMessage;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
}): Promise<boolean> {
  if (isLocalDirectRequest(params.req, params.trustedProxies, params.allowRealIpFallback)) {
    return true;
  }
  if (params.resolvedAuth.mode === "none") {
    return false;
  }

  const bearerToken = getBearerToken(params.req);
  const authResult = await authorizeHttpGatewayConnect({
    auth: params.resolvedAuth,
    connectAuth: bearerToken ? { token: bearerToken, password: bearerToken } : null,
    req: params.req,
    trustedProxies: params.trustedProxies,
    allowRealIpFallback: params.allowRealIpFallback,
    browserOriginPolicy: resolveHttpBrowserOriginPolicy(params.req),
  });
  return authResult.ok;
}

async function handleGatewayProbeRequest(
  req: IncomingMessage,
  res: ServerResponse,
  requestPath: string,
  resolvedAuth: ResolvedGatewayAuth,
  trustedProxies: string[],
  allowRealIpFallback: boolean,
  getReadiness?: ReadinessChecker,
): Promise<boolean> {
  const status = GATEWAY_PROBE_STATUS_BY_PATH.get(requestPath);
  if (!status) {
    return false;
  }

  const method = (req.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.setHeader("Allow", "GET, HEAD");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Method Not Allowed");
    return true;
  }

  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");

  let statusCode: number;
  let body: string;
  if (status === "ready" && getReadiness) {
    const includeDetails = await canRevealReadinessDetails({
      req,
      resolvedAuth,
      trustedProxies,
      allowRealIpFallback,
    });
    try {
      const result = getReadiness();
      statusCode = result.ready ? 200 : 503;
      body = JSON.stringify(includeDetails ? result : { ready: result.ready });
    } catch {
      statusCode = 503;
      body = JSON.stringify(
        includeDetails ? { ready: false, failing: ["internal"], uptimeMs: 0 } : { ready: false },
      );
    }
  } else {
    statusCode = 200;
    body = JSON.stringify({ ok: true, status });
  }
  res.statusCode = statusCode;
  res.end(method === "HEAD" ? undefined : body);
  return true;
}

function writeUpgradeAuthFailure(
  socket: { write: (chunk: string) => void },
  auth: GatewayAuthResult,
) {
  if (auth.rateLimited) {
    const retryAfterSeconds =
      auth.retryAfterMs && auth.retryAfterMs > 0 ? Math.ceil(auth.retryAfterMs / 1000) : undefined;
    socket.write(
      [
        "HTTP/1.1 429 Too Many Requests",
        retryAfterSeconds ? `Retry-After: ${retryAfterSeconds}` : undefined,
        "Content-Type: application/json; charset=utf-8",
        "Connection: close",
        "",
        JSON.stringify({
          error: {
            message: "Too many failed authentication attempts. Please try again later.",
            type: "rate_limited",
          },
        }),
      ]
        .filter(Boolean)
        .join("\r\n"),
    );
    return;
  }
  socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
}

export type HooksRequestHandler = (req: IncomingMessage, res: ServerResponse) => Promise<boolean>;

type GatewayHttpRequestStage = {
  name: string;
  run: () => Promise<boolean> | boolean;
  continueOnError?: boolean;
};

export async function runGatewayHttpRequestStages(
  stages: readonly GatewayHttpRequestStage[],
): Promise<boolean> {
  for (const stage of stages) {
    try {
      if (await stage.run()) {
        return true;
      }
    } catch (err) {
      if (!stage.continueOnError) {
        throw err;
      }
      // Log and skip the failing stage so subsequent stages (control-ui,
      // gateway-probes, etc.) remain reachable. A common trigger is a
      // plugin-owned route/runtime code still failing to load an optional dependency.
      console.error(`[gateway-http] stage "${stage.name}" threw — skipping:`, err);
    }
  }
  return false;
}

function buildPluginRequestStages(params: {
  req: IncomingMessage;
  res: ServerResponse;
  requestPath: string;
  getGatewayAuthBypassPaths: () => Promise<ReadonlySet<string>>;
  pluginPathContext: PluginRoutePathContext | null;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  trustedProxies: string[];
  allowRealIpFallback: boolean;
  rateLimiter?: AuthRateLimiter;
}): GatewayHttpRequestStage[] {
  if (!params.handlePluginRequest) {
    return [];
  }
  let pluginGatewayAuthSatisfied = false;
  let pluginGatewayRequestAuth: AuthorizedGatewayHttpRequest | undefined;
  let pluginRequestOperatorScopes: string[] | undefined;
  return [
    {
      name: "plugin-auth",
      run: async () => {
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        if (
          !(params.shouldEnforcePluginGatewayAuth ?? shouldEnforceDefaultPluginGatewayAuth)(
            pathContext,
          )
        ) {
          return false;
        }
        if ((await params.getGatewayAuthBypassPaths()).has(params.requestPath)) {
          return false;
        }
        const requestAuth = await authorizeGatewayHttpRequestOrReply({
          req: params.req,
          res: params.res,
          auth: params.resolvedAuth,
          trustedProxies: params.trustedProxies,
          allowRealIpFallback: params.allowRealIpFallback,
          rateLimiter: params.rateLimiter,
        });
        if (!requestAuth) {
          return true;
        }
        pluginGatewayAuthSatisfied = true;
        pluginGatewayRequestAuth = requestAuth;
        pluginRequestOperatorScopes = resolvePluginRouteRuntimeOperatorScopes(
          params.req,
          requestAuth,
        );
        return false;
      },
    },
    {
      name: "plugin-http",
      continueOnError: true,
      run: () => {
        const pathContext =
          params.pluginPathContext ?? resolvePluginRoutePathContext(params.requestPath);
        return (
          params.handlePluginRequest?.(params.req, params.res, pathContext, {
            gatewayAuthSatisfied: pluginGatewayAuthSatisfied,
            gatewayRequestAuth: pluginGatewayRequestAuth,
            gatewayRequestOperatorScopes: pluginRequestOperatorScopes,
          }) ?? false
        );
      },
    },
  ];
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
            source: "mapping",
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

export function createGatewayHttpServer(opts: {
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  controlUiEnabled: boolean;
  controlUiBasePath: string;
  controlUiRoot?: ControlUiRootState;
  openAiChatCompletionsEnabled: boolean;
  openAiChatCompletionsConfig?: import("../config/types.gateway.js").GatewayHttpChatCompletionsConfig;
  openResponsesEnabled: boolean;
  openResponsesConfig?: import("../config/types.gateway.js").GatewayHttpResponsesConfig;
  strictTransportSecurityHeader?: string;
  handleHooksRequest: HooksRequestHandler;
  handlePluginRequest?: PluginHttpRequestHandler;
  shouldEnforcePluginGatewayAuth?: (pathContext: PluginRoutePathContext) => boolean;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
  getReadiness?: ReadinessChecker;
  tlsOptions?: TlsOptions;
}): HttpServer {
  const {
    canvasHost,
    clients,
    controlUiEnabled,
    controlUiBasePath,
    controlUiRoot,
    openAiChatCompletionsEnabled,
    openAiChatCompletionsConfig,
    openResponsesEnabled,
    openResponsesConfig,
    strictTransportSecurityHeader,
    handleHooksRequest,
    handlePluginRequest,
    shouldEnforcePluginGatewayAuth,
    resolvedAuth,
    rateLimiter,
    getReadiness,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  const openAiCompatEnabled = openAiChatCompletionsEnabled || openResponsesEnabled;
  const httpServer: HttpServer = opts.tlsOptions
    ? createHttpsServer(opts.tlsOptions, (req, res) => {
        void handleRequest(req, res);
      })
    : createHttpServer((req, res) => {
        void handleRequest(req, res);
      });

  async function handleRequest(req: IncomingMessage, res: ServerResponse) {
    setDefaultSecurityHeaders(res, {
      strictTransportSecurity: strictTransportSecurityHeader,
    });

    // Don't interfere with WebSocket upgrades; ws handles the 'upgrade' event.
    if ((req.headers.upgrade ?? "").toLowerCase() === "websocket") {
      return;
    }

    try {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        sendGatewayAuthFailure(res, { ok: false, reason: "unauthorized" });
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      const requestPath = new URL(req.url ?? "/", "http://localhost").pathname;
      const pluginPathContext = handlePluginRequest
        ? resolvePluginRoutePathContext(requestPath)
        : null;
      const resolvedAuth = getResolvedAuth();
      const requestStages: GatewayHttpRequestStage[] = [
        {
          name: "hooks",
          run: () => handleHooksRequest(req, res),
        },
      ];
      if (openAiCompatEnabled && isOpenAiModelsPath(requestPath)) {
        requestStages.push({
          name: "models",
          run: async () =>
            (await getModelsHttpModule()).handleOpenAiModelsHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openAiCompatEnabled && isEmbeddingsPath(requestPath)) {
        requestStages.push({
          name: "embeddings",
          run: async () =>
            (await getEmbeddingsHttpModule()).handleOpenAiEmbeddingsHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isToolsInvokePath(requestPath)) {
        requestStages.push({
          name: "tools-invoke",
          run: async () =>
            (await getToolsInvokeHttpModule()).handleToolsInvokeHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isSessionKillPath(requestPath)) {
        requestStages.push({
          name: "sessions-kill",
          run: async () =>
            (await getSessionKillHttpModule()).handleSessionKillHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (isSessionHistoryPath(requestPath)) {
        requestStages.push({
          name: "sessions-history",
          run: async () =>
            (await getSessionHistoryHttpModule()).handleSessionHistoryHttpRequest(req, res, {
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openResponsesEnabled && isOpenResponsesPath(requestPath)) {
        requestStages.push({
          name: "openresponses",
          run: async () =>
            (await getOpenResponsesHttpModule()).handleOpenResponsesHttpRequest(req, res, {
              auth: resolvedAuth,
              config: openResponsesConfig,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (openAiChatCompletionsEnabled && isOpenAiChatCompletionsPath(requestPath)) {
        requestStages.push({
          name: "openai",
          run: async () =>
            (await getOpenAiHttpModule()).handleOpenAiHttpRequest(req, res, {
              auth: resolvedAuth,
              config: openAiChatCompletionsConfig,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
      }
      if (canvasHost) {
        requestStages.push({
          name: "canvas-auth",
          run: async () => {
            if (!isCanvasPath(requestPath)) {
              return false;
            }
            const ok = await authorizeCanvasRequest({
              req,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              clients,
              canvasCapability: scopedCanvas.capability,
              malformedScopedPath: scopedCanvas.malformedScopedPath,
              rateLimiter,
            });
            if (!ok.ok) {
              sendGatewayAuthFailure(res, ok);
              return true;
            }
            return false;
          },
        });
        requestStages.push({
          name: "a2ui",
          run: () => (isA2uiPath(requestPath) ? handleA2uiHttpRequest(req, res) : false),
        });
        requestStages.push({
          name: "canvas-http",
          run: () => canvasHost.handleHttpRequest(req, res),
        });
      }
      // Plugin routes run before the Control UI SPA catch-all so explicitly
      // registered plugin endpoints stay reachable. Core built-in gateway
      // routes above still keep precedence on overlapping paths.
      requestStages.push(
        ...buildPluginRequestStages({
          req,
          res,
          requestPath,
          getGatewayAuthBypassPaths: () => resolvePluginGatewayAuthBypassPaths(configSnapshot),
          pluginPathContext,
          handlePluginRequest,
          shouldEnforcePluginGatewayAuth,
          resolvedAuth,
          trustedProxies,
          allowRealIpFallback,
          rateLimiter,
        }),
      );

      if (controlUiEnabled) {
        requestStages.push({
          name: "control-ui-assistant-media",
          run: async () =>
            (await getControlUiModule()).handleControlUiAssistantMediaRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
              auth: resolvedAuth,
              trustedProxies,
              allowRealIpFallback,
              rateLimiter,
            }),
        });
        requestStages.push({
          name: "control-ui-avatar",
          run: async () => {
            const { handleControlUiAvatarRequest } = await getControlUiModule();
            const { resolveAgentAvatar } = await getIdentityAvatarModule();
            return handleControlUiAvatarRequest(req, res, {
              basePath: controlUiBasePath,
              resolveAvatar: (agentId) =>
                resolveAgentAvatar(configSnapshot, agentId, { includeUiOverride: true }),
            });
          },
        });
        requestStages.push({
          name: "control-ui-http",
          run: async () =>
            (await getControlUiModule()).handleControlUiHttpRequest(req, res, {
              basePath: controlUiBasePath,
              config: configSnapshot,
              agentId: resolveAssistantIdentity({ cfg: configSnapshot }).agentId,
              root: controlUiRoot,
            }),
        });
      }

      requestStages.push({
        name: "gateway-probes",
        run: () =>
          handleGatewayProbeRequest(
            req,
            res,
            requestPath,
            resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            getReadiness,
          ),
      });

      if (await runGatewayHttpRequestStages(requestStages)) {
        return;
      }

      res.statusCode = 404;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Not Found");
    } catch (err) {
      console.error("[gateway-http] unhandled error in request handler:", err);
      res.statusCode = 500;
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
      res.end("Internal Server Error");
    }
  }

  return httpServer;
}

export function attachGatewayUpgradeHandler(opts: {
  httpServer: HttpServer;
  wss: WebSocketServer;
  canvasHost: CanvasHostHandler | null;
  clients: Set<GatewayWsClient>;
  preauthConnectionBudget: PreauthConnectionBudget;
  resolvedAuth: ResolvedGatewayAuth;
  getResolvedAuth?: () => ResolvedGatewayAuth;
  /** Optional rate limiter for auth brute-force protection. */
  rateLimiter?: AuthRateLimiter;
}) {
  const {
    httpServer,
    wss,
    canvasHost,
    clients,
    preauthConnectionBudget,
    resolvedAuth,
    rateLimiter,
  } = opts;
  const getResolvedAuth = opts.getResolvedAuth ?? (() => resolvedAuth);
  httpServer.on("upgrade", (req, socket, head) => {
    void (async () => {
      const configSnapshot = loadConfig();
      const trustedProxies = configSnapshot.gateway?.trustedProxies ?? [];
      const allowRealIpFallback = configSnapshot.gateway?.allowRealIpFallback === true;
      const scopedCanvas = normalizeCanvasScopedUrl(req.url ?? "/");
      if (scopedCanvas.malformedScopedPath) {
        writeUpgradeAuthFailure(socket, { ok: false, reason: "unauthorized" });
        socket.destroy();
        return;
      }
      if (scopedCanvas.rewrittenUrl) {
        req.url = scopedCanvas.rewrittenUrl;
      }
      const resolvedAuth = getResolvedAuth();
      if (canvasHost) {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname === CANVAS_WS_PATH) {
          const ok = await authorizeCanvasRequest({
            req,
            auth: resolvedAuth,
            trustedProxies,
            allowRealIpFallback,
            clients,
            canvasCapability: scopedCanvas.capability,
            malformedScopedPath: scopedCanvas.malformedScopedPath,
            rateLimiter,
          });
          if (!ok.ok) {
            writeUpgradeAuthFailure(socket, ok);
            socket.destroy();
            return;
          }
        }
        if (canvasHost.handleUpgrade(req, socket, head)) {
          return;
        }
      }
      const preauthBudgetKey = resolveRequestClientIp(req, trustedProxies, allowRealIpFallback);
      if (wss.listenerCount("connection") === 0) {
        const responseBody = "Gateway websocket handlers unavailable";
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `Content-Length: ${Buffer.byteLength(responseBody, "utf8")}\r\n` +
            "\r\n" +
            responseBody,
        );
        socket.destroy();
        return;
      }
      if (!preauthConnectionBudget.acquire(preauthBudgetKey)) {
        const responseBody = "Too many unauthenticated sockets";
        socket.write(
          "HTTP/1.1 503 Service Unavailable\r\n" +
            "Connection: close\r\n" +
            "Content-Type: text/plain; charset=utf-8\r\n" +
            `Content-Length: ${Buffer.byteLength(responseBody, "utf8")}\r\n` +
            "\r\n" +
            responseBody,
        );
        socket.destroy();
        return;
      }
      let budgetTransferred = false;
      const releaseUpgradeBudget = () => {
        if (budgetTransferred) {
          return;
        }
        budgetTransferred = true;
        preauthConnectionBudget.release(preauthBudgetKey);
      };
      socket.once("close", releaseUpgradeBudget);
      try {
        wss.handleUpgrade(req, socket, head, (ws) => {
          (
            ws as unknown as import("ws").WebSocket & {
              __openclawPreauthBudgetClaimed?: boolean;
              __openclawPreauthBudgetKey?: string;
            }
          ).__openclawPreauthBudgetKey = preauthBudgetKey;
          wss.emit("connection", ws, req);
          const budgetClaimed = Boolean(
            (
              ws as unknown as import("ws").WebSocket & {
                __openclawPreauthBudgetClaimed?: boolean;
              }
            ).__openclawPreauthBudgetClaimed,
          );
          if (budgetClaimed) {
            budgetTransferred = true;
            socket.off("close", releaseUpgradeBudget);
          }
        });
      } catch {
        socket.off("close", releaseUpgradeBudget);
        releaseUpgradeBudget();
        throw new Error("gateway websocket upgrade failed");
      }
    })().catch(() => {
      socket.destroy();
    });
  });
}
