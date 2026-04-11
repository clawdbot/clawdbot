import type { IncomingMessage, ServerResponse } from "node:http";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
import { normalizeWebhookPath } from "./webhook-path.js";
import {
  beginWebhookRequestPipelineOrReject,
  type WebhookInFlightLimiter,
} from "./webhook-request-guards.js";

export type RegisteredWebhookTarget<T> = {
  target: T;
  unregister: () => void;
};

export type RegisterWebhookTargetOptions<T extends { path: string }> = {
  onFirstPathTarget?: (params: { path: string; target: T }) => void | (() => void);
  onLastPathTargetRemoved?: (params: { path: string }) => void;
};

type RegisterPluginHttpRouteParams = Parameters<typeof registerPluginHttpRoute>[0];

export { registerPluginHttpRoute };

export type RegisterWebhookPluginRouteOptions = Omit<
  RegisterPluginHttpRouteParams,
  "path" | "fallbackPath"
>;

/** Register a webhook target and lazily install the matching plugin HTTP route on first use. */
export function registerWebhookTargetWithPluginRoute<T extends { path: string }>(params: {
  targetsByPath: Map<string, T[]>;
  target: T;
  route: RegisterWebhookPluginRouteOptions;
  onLastPathTargetRemoved?: RegisterWebhookTargetOptions<T>["onLastPathTargetRemoved"];
}): RegisteredWebhookTarget<T> {
  return registerWebhookTarget(params.targetsByPath, params.target, {
    onFirstPathTarget: ({ path }) =>
      registerPluginHttpRoute({
        ...params.route,
        path,
        replaceExisting: params.route.replaceExisting ?? true,
      }),
    onLastPathTargetRemoved: params.onLastPathTargetRemoved,
  });
}

const pathTeardownByTargetMap = new WeakMap<Map<string, unknown[]>, Map<string, () => void>>();

function getPathTeardownMap<T>(targetsByPath: Map<string, T[]>): Map<string, () => void> {
  const mapKey = targetsByPath as unknown as Map<string, unknown[]>;
  const existing = pathTeardownByTargetMap.get(mapKey);
  if (existing) {
    return existing;
  }
  const created = new Map<string, () => void>();
  pathTeardownByTargetMap.set(mapKey, created);
  return created;
}

/** Add a normalized target to a path bucket and clean up route state when the last target leaves. */
export function registerWebhookTarget<T extends { path: string }>(
  targetsByPath: Map<string, T[]>,
  target: T,
  opts?: RegisterWebhookTargetOptions<T>,
): RegisteredWebhookTarget<T> {
  const key = normalizeWebhookPath(target.path);
  const normalizedTarget = { ...target, path: key };
  const existing = targetsByPath.get(key) ?? [];

  if (existing.length === 0) {
    const onFirstPathResult = opts?.onFirstPathTarget?.({
      path: key,
      target: normalizedTarget,
    });
    if (typeof onFirstPathResult === "function") {
      getPathTeardownMap(targetsByPath).set(key, onFirstPathResult);
    }
  }

  targetsByPath.set(key, [...existing, normalizedTarget]);

  let isActive = true;
  const unregister = () => {
    if (!isActive) {
      return;
    }
    isActive = false;

    const updated = (targetsByPath.get(key) ?? []).filter((entry) => entry !== normalizedTarget);
    if (updated.length > 0) {
      targetsByPath.set(key, updated);
      return;
    }
    targetsByPath.delete(key);

    const teardown = getPathTeardownMap(targetsByPath).get(key);
    if (teardown) {
      getPathTeardownMap(targetsByPath).delete(key);
      teardown();
    }
    opts?.onLastPathTargetRemoved?.({ path: key });
  };
  return { target: normalizedTarget, unregister };
}

/** Resolve all registered webhook targets for the incoming request path. */
export function resolveWebhookTargets<T>(
  req: IncomingMessage,
  targetsByPath: Map<string, T[]>,
): { path: string; targets: T[] } | null {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = normalizeWebhookPath(url.pathname);
  const targets = targetsByPath.get(path);
  if (!targets || targets.length === 0) {
    return null;
  }
  return { path, targets };
}

/** Run common webhook guards, then dispatch only when the request path resolves to live targets. */
export async function withResolvedWebhookRequestPipeline<T>(params: {
  req: IncomingMessage;
  res: ServerResponse;
  targetsByPath: Map<string, T[]>;
  allowMethods?: readonly string[];
  rateLimiter?: FixedWindowRateLimiter;
  rateLimitKey?: string;
  nowMs?: number;
  requireJsonContentType?: boolean;
  inFlightLimiter?: WebhookInFlightLimiter;
  inFlightKey?: string | ((args: { req: IncomingMessage; path: string; targets: T[] }) => string);
  inFlightLimitStatusCode?: number;
  inFlightLimitMessage?: string;
  handle: (args: { path: string; targets: T[] }) => Promise<boolean | void> | boolean | void;
}): Promise<boolean> {
  const resolved = resolveWebhookTargets(params.req, params.targetsByPath);
  if (!resolved) {
    return false;
  }

  const inFlightKey =
    typeof params.inFlightKey === "function"
      ? params.inFlightKey({ req: params.req, path: resolved.path, targets: resolved.targets })
      : (params.inFlightKey ?? `${resolved.path}:${params.req.socket?.remoteAddress ?? "unknown"}`);
  const requestLifecycle = beginWebhookRequestPipelineOrReject({
    req: params.req,
    res: params.res,
    allowMethods: params.allowMethods,
    rateLimiter: params.rateLimiter,
    rateLimitKey: params.rateLimitKey,
    nowMs: params.nowMs,
    requireJsonContentType: params.requireJsonContentType,
    inFlightLimiter: params.inFlightLimiter,
    inFlightKey,
    inFlightLimitStatusCode: params.inFlightLimitStatusCode,
    inFlightLimitMessage: params.inFlightLimitMessage,
  });
  if (!requestLifecycle.ok) {
    return true;
  }

  try {
    await params.handle(resolved);
    return true;
  } finally {
    requestLifecycle.release();
  }
}

export type WebhookTargetMatchResult<T> =
  | { kind: "none" }
  | { kind: "single"; target: T }
  | { kind: "ambiguous" };

function updateMatchedWebhookTarget<T>(
  matched: T | undefined,
  target: T,
): { ok: true; matched: T } | { ok: false; result: WebhookTargetMatchResult<T> } {
  if (matched) {
    return { ok: false, result: { kind: "ambiguous" } };
  }
  return { ok: true, matched: target };
}

function finalizeMatchedWebhookTarget<T>(matched: T | undefined): WebhookTargetMatchResult<T> {
  if (!matched) {
    return { kind: "none" };
  }
  return { kind: "single", target: matched };
}

/** Match exactly one synchronous target or report whether resolution was empty or ambiguous. */
export function resolveSingleWebhookTarget<T>(
  targets: readonly T[],
  isMatch: (target: T) => boolean,
): WebhookTargetMatchResult<T> {
  let matched: T | undefined;
  for (const target of targets) {
    if (!isMatch(target)) {
      continue;
    }
    const updated = updateMatchedWebhookTarget(matched, target);
    if (!updated.ok) {
      return updated.result;
    }
    matched = updated.matched;
  }
  return finalizeMatchedWebhookTarget(matched);
}

/** Async variant of single-target resolution for auth checks that need I/O. */
export async function resolveSingleWebhookTargetAsync<T>(
  targets: readonly T[],
  isMatch: (target: T) => Promise<boolean>,
): Promise<WebhookTargetMatchResult<T>> {
  let matched: T | undefined;
  for (const target of targets) {
    if (!(await isMatch(target))) {
      continue;
    }
    const updated = updateMatchedWebhookTarget(matched, target);
    if (!updated.ok) {
      return updated.result;
    }
    matched = updated.matched;
  }
  return finalizeMatchedWebhookTarget(matched);
}

/** Resolve an authorized target and send the standard unauthorized or ambiguous response on failure. */
export async function resolveWebhookTargetWithAuthOrReject<T>(params: {
  targets: readonly T[];
  res: ServerResponse;
  isMatch: (target: T) => boolean | Promise<boolean>;
  unauthorizedStatusCode?: number;
  unauthorizedMessage?: string;
  ambiguousStatusCode?: number;
  ambiguousMessage?: string;
}): Promise<T | null> {
  const match = await resolveSingleWebhookTargetAsync(params.targets, async (target) =>
    params.isMatch(target),
  );
  return resolveWebhookTargetMatchOrReject(params, match);
}

/** Synchronous variant of webhook auth resolution for cheap in-memory match checks. */
export function resolveWebhookTargetWithAuthOrRejectSync<T>(params: {
  targets: readonly T[];
  res: ServerResponse;
  isMatch: (target: T) => boolean;
  unauthorizedStatusCode?: number;
  unauthorizedMessage?: string;
  ambiguousStatusCode?: number;
  ambiguousMessage?: string;
}): T | null {
  const match = resolveSingleWebhookTarget(params.targets, params.isMatch);
  return resolveWebhookTargetMatchOrReject(params, match);
}

function resolveWebhookTargetMatchOrReject<T>(
  params: {
    res: ServerResponse;
    unauthorizedStatusCode?: number;
    unauthorizedMessage?: string;
    ambiguousStatusCode?: number;
    ambiguousMessage?: string;
  },
  match: WebhookTargetMatchResult<T>,
): T | null {
  if (match.kind === "single") {
    return match.target;
  }
  if (match.kind === "ambiguous") {
    params.res.statusCode = params.ambiguousStatusCode ?? 401;
    params.res.end(params.ambiguousMessage ?? "ambiguous webhook target");
    return null;
  }
  params.res.statusCode = params.unauthorizedStatusCode ?? 401;
  params.res.end(params.unauthorizedMessage ?? "unauthorized");
  return null;
}

/** Reject non-POST webhook requests with the conventional Allow header. */
export function rejectNonPostWebhookRequest(req: IncomingMessage, res: ServerResponse): boolean {
  if (req.method === "POST") {
    return false;
  }
  res.statusCode = 405;
  res.setHeader("Allow", "POST");
  res.end("Method Not Allowed");
  return true;
}
