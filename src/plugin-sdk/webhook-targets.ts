// Webhook target helpers resolve and validate plugin webhook destinations.
import type { IncomingMessage, ServerResponse } from "node:http";
import { registerPluginHttpRoute } from "../plugins/http-registry.js";
import type { FixedWindowRateLimiter } from "./webhook-memory-guards.js";
import { normalizeWebhookPath } from "./webhook-path.js";
import {
  beginWebhookRequestPipelineOrReject,
  type WebhookInFlightLimiter,
} from "./webhook-request-guards.js";

/** Registration handle returned for one live webhook target. */
export type RegisteredWebhookTarget<T> = {
  /** Normalized target stored in the caller-owned path registry. */
  target: T;
  /** Idempotently remove this target and run path teardown when it was the last target. */
  unregister: () => void;
};

/** Lifecycle hooks for path-level webhook target registration. */
export type RegisterWebhookTargetOptions<T extends { path: string }> = {
  /** Called before the first target for a normalized path is stored; may return path teardown. */
  onFirstPathTarget?: (params: { path: string; target: T }) => void | (() => void);
  /** Called after the last target for a normalized path has been removed. */
  onLastPathTargetRemoved?: (params: { path: string }) => void;
};

type RegisterPluginHttpRouteParams = Parameters<typeof registerPluginHttpRoute>[0];

export { registerPluginHttpRoute };

/** Plugin HTTP route options supplied when webhook paths are registered lazily. */
export type RegisterWebhookPluginRouteOptions = Omit<
  RegisterPluginHttpRouteParams,
  "path" | "fallbackPath"
>;

/** Register a webhook target and lazily install the matching plugin HTTP route on first use. */
export function registerWebhookTargetWithPluginRoute<T extends { path: string }>(params: {
  /** Caller-owned normalized path registry shared by all targets for this plugin/runtime. */
  targetsByPath: Map<string, T[]>;
  /** Target to normalize, store, and later return from the registration handle. */
  target: T;
  /** Plugin HTTP route configuration used when the first target for a path is registered. */
  route: RegisterWebhookPluginRouteOptions;
  /** Optional last-target hook forwarded to `registerWebhookTarget`. */
  onLastPathTargetRemoved?: RegisterWebhookTargetOptions<T>["onLastPathTargetRemoved"];
}): RegisteredWebhookTarget<T> {
  return registerWebhookTarget(params.targetsByPath, params.target, {
    onFirstPathTarget: ({ path }) =>
      registerPluginHttpRoute({
        ...params.route,
        path,
        // Webhook targets own this path while registered; default replacement lets
        // plugin reload/setup refresh the handler without accumulating stale routes.
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
  // Teardown is scoped to the caller-owned registry map so independent plugins using the same
  // path do not unregister each other's HTTP routes.
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
  /** Incoming HTTP request whose pathname selects the target bucket. */
  req: IncomingMessage;
  /** HTTP response used by guard failures before handler dispatch. */
  res: ServerResponse;
  /** Caller-owned target registry keyed by normalized webhook path. */
  targetsByPath: Map<string, T[]>;
  /** Allowed methods for the common request guard. */
  allowMethods?: readonly string[];
  /** Optional per-key fixed-window limiter shared across requests. */
  rateLimiter?: FixedWindowRateLimiter;
  /** Explicit rate-limit key; defaults are owned by the request guard. */
  rateLimitKey?: string;
  /** Clock override for deterministic limiter tests. */
  nowMs?: number;
  /** Require JSON content type before dispatching to the webhook handler. */
  requireJsonContentType?: boolean;
  /** Optional in-flight limiter to cap concurrent handling for a key. */
  inFlightLimiter?: WebhookInFlightLimiter;
  /** Explicit or derived key for concurrent request limiting. */
  inFlightKey?: string | ((args: { req: IncomingMessage; path: string; targets: T[] }) => string);
  /** Status code returned when the in-flight guard rejects. */
  inFlightLimitStatusCode?: number;
  /** Response body returned when the in-flight guard rejects. */
  inFlightLimitMessage?: string;
  /** Handler invoked only after target resolution and common guards succeed. */
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
    // Release even when the handler throws; otherwise one failed webhook can pin the in-flight
    // slot and permanently reject later deliveries for the same key.
    requestLifecycle.release();
  }
}

/** Result of matching a request against zero, one, or multiple webhook targets. */
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
    // Stop at the second match so auth callers can reject ambiguous secrets without inspecting
    // or accidentally selecting a later target.
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
  /** Candidate targets for the already-resolved webhook path. */
  targets: readonly T[];
  /** HTTP response used to send unauthorized or ambiguous failures. */
  res: ServerResponse;
  /** Auth or routing predicate; exactly one target must match. */
  isMatch: (target: T) => boolean | Promise<boolean>;
  /** Status code for no matching target. Defaults to 401. */
  unauthorizedStatusCode?: number;
  /** Response body for no matching target. */
  unauthorizedMessage?: string;
  /** Status code for multiple matching targets. Defaults to 401. */
  ambiguousStatusCode?: number;
  /** Response body for multiple matching targets. */
  ambiguousMessage?: string;
}): Promise<T | null> {
  const match = await resolveSingleWebhookTargetAsync(params.targets, async (target) =>
    params.isMatch(target),
  );
  return resolveWebhookTargetMatchOrReject(params, match);
}

/** Synchronous variant of webhook auth resolution for cheap in-memory match checks. */
export function resolveWebhookTargetWithAuthOrRejectSync<T>(params: {
  /** Candidate targets for the already-resolved webhook path. */
  targets: readonly T[];
  /** HTTP response used to send unauthorized or ambiguous failures. */
  res: ServerResponse;
  /** Synchronous auth or routing predicate; exactly one target must match. */
  isMatch: (target: T) => boolean;
  /** Status code for no matching target. Defaults to 401. */
  unauthorizedStatusCode?: number;
  /** Response body for no matching target. */
  unauthorizedMessage?: string;
  /** Status code for multiple matching targets. Defaults to 401. */
  ambiguousStatusCode?: number;
  /** Response body for multiple matching targets. */
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
