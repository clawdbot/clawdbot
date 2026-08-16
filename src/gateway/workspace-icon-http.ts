// Serves a workspace directory's own project icon so the Control UI can render
// real project identity instead of a generic folder glyph.
import { createHash } from "node:crypto";
import { close } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { fileTypeFromBuffer } from "file-type";
import {
  openRootFileFollowingParents,
  readFileDescriptorBounded,
} from "../infra/boundary-file-read.js";
import { pruneMapToMaxSize } from "../infra/map-size.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import { CONTROL_UI_WORKSPACE_ICON_PATH_PREFIX } from "./control-ui-contract.js";
import { respondNotFound } from "./control-ui-http-utils.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import { sendJson, sendMethodNotAllowed, sendMissingScopeForbidden } from "./http-common.js";
import { matchesHttpIfNoneMatch } from "./http-conditional.js";
import {
  authorizeGatewayHttpRequestOrReply,
  resolveOpenAiCompatibleHttpOperatorScopes,
  resolveOpenAiCompatibleHttpSenderIsOwner,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";

/**
 * Conventional project icon locations in deterministic product precedence.
 * Resolution stops at the first valid hit, so this fixed list is the whole
 * filesystem cost of opening a workspace and never becomes a recursive scan.
 */
const WORKSPACE_ICON_RELATIVE_PATHS = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/favicon-32.png",
  "public/apple-touch-icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "ui/public/favicon-32.png",
  "ui/public/favicon.svg",
  "ui/public/favicon.ico",
  "ui/public/favicon.png",
  "app/favicon.ico",
  "app/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/icon.ico",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
] as const;

/** Icons are small by construction; anything larger is not a favicon. */
export const WORKSPACE_ICON_MAX_BYTES = 512 * 1024;
/** Vector icons are markup the renderer must parse, so they get a tighter cap. */
export const SVG_ICON_MAX_BYTES = 64 * 1024;
const WORKSPACE_ICON_CACHE_MAX_ENTRIES = 32;
const SESSION_WORKSPACE_ICON_CACHE_MAX_ENTRIES = 128;
/**
 * An icon request and the `chat.startup` preparing its snapshot travel on
 * different transports, so the GET can win that race by a few milliseconds.
 * The route waits this long for the publish instead of reporting a miss.
 */
const SESSION_WORKSPACE_ICON_PUBLISH_WAIT_MS = 2_000;
/**
 * A waiting GET parks a held response, a timer, and a closure, so admission is
 * bounded on both axes: waiting sessions, and requests behind one session key.
 * Past either bound the route answers 503 at once instead of accumulating.
 */
const SESSION_WORKSPACE_ICON_MAX_WAITING_SESSIONS = 32;
const SESSION_WORKSPACE_ICON_MAX_WAITS_PER_SESSION = 4;
const SVG_MIME_TYPE = "image/svg+xml";
const ICO_MIME_TYPE = "image/x-icon";
const closeFileDescriptor = promisify(close);

/** Sniffable raster types the Control UI can render inside an <img> element. */
const ALLOWED_RASTER_ICON_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  ICO_MIME_TYPE,
]);

type WorkspaceIcon = {
  body: Buffer;
  contentType: string;
  etag: string;
};

/** `null` records a resolved absence so a workspace without an icon never re-scans. */
type WorkspaceIconResolution = WorkspaceIcon | null;

/**
 * The snapshot travels wrapped because a published absence resolves to `null`:
 * a bare promise handed to a waiter is adopted by `resolve`, flattening that
 * absence into the falsy value an expired wait produces, so a workspace with
 * no icon would answer 503 instead of its stable 404.
 */
type SessionWorkspaceIconWait =
  | { status: "published"; prepared: Promise<WorkspaceIconResolution> }
  | { status: "unavailable" };

/** Notified with the session's snapshot the moment preparation publishes it. */
type SessionWorkspaceIconWaiter = (wait: SessionWorkspaceIconWait) => void;

let workspaceIconCache = new Map<string, Promise<WorkspaceIconResolution>>();
let sessionWorkspaceIconCache = new Map<string, Promise<WorkspaceIconResolution>>();
const sessionWorkspaceIconWaiters = new Map<string, Set<SessionWorkspaceIconWaiter>>();

export function clearWorkspaceIconCacheForTest(): void {
  workspaceIconCache = new Map();
  sessionWorkspaceIconCache = new Map();
  sessionWorkspaceIconWaiters.clear();
}

/**
 * Bounds an SVG icon before it can reach a browser. `<img>` runs no script, so
 * this is about render cost and outbound references rather than execution: a
 * doctype or entity can expand, an external reference can make the renderer
 * fetch, and unbounded markup can stall a decode. Favicons are tiny, so a much
 * lower cap than the raster limit still accepts every realistic one while
 * leaving no room for a decode bomb.
 */
function isRenderableSvg(body: Buffer): boolean {
  if (body.byteLength > SVG_ICON_MAX_BYTES) {
    return false;
  }
  const text = body.toString("utf8");
  return (
    !text.includes("\0") &&
    !/<!doctype|<!entity/iu.test(text) &&
    !/<\s*(?:script|foreignObject|image|use|iframe)\b/iu.test(text) &&
    // Only self-contained artwork: no fetches, no cross-document references.
    !/\b(?:href|xlink:href|src)\s*=/iu.test(text) &&
    /^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg(?:\s|>)/iu.test(text)
  );
}

async function resolveIconContentType(
  relativePath: string,
  body: Buffer,
): Promise<string | undefined> {
  if (path.extname(relativePath) === ".svg") {
    return isRenderableSvg(body) ? SVG_MIME_TYPE : undefined;
  }
  const sniffed = (await fileTypeFromBuffer(body))?.mime;
  // file-type reports the legacy ICO media type under either spelling.
  const normalized = sniffed === "image/vnd.microsoft.icon" ? ICO_MIME_TYPE : sniffed;
  return normalized && ALLOWED_RASTER_ICON_MIME_TYPES.has(normalized) ? normalized : undefined;
}

async function readWorkspaceIconCandidate(
  workspaceRoot: string,
  relativePath: string,
): Promise<WorkspaceIcon | undefined> {
  const opened = await openRootFileFollowingParents({
    absolutePath: path.join(workspaceRoot, relativePath),
    rootPath: workspaceRoot,
    boundaryLabel: "workspace root",
    maxBytes: WORKSPACE_ICON_MAX_BYTES,
  });
  if (!opened.ok) {
    return undefined;
  }
  let body: Buffer;
  try {
    body = await readFileDescriptorBounded(opened.fd, WORKSPACE_ICON_MAX_BYTES);
  } catch {
    return undefined;
  } finally {
    await closeFileDescriptor(opened.fd);
  }
  if (body.byteLength === 0) {
    return undefined;
  }
  const contentType = await resolveIconContentType(relativePath, body);
  if (!contentType) {
    return undefined;
  }
  return {
    body,
    contentType,
    // Content-addressed validator: a restart that picks up different bytes also
    // invalidates every browser copy cached under the stable workspace URL.
    etag: `"${createHash("sha256").update(body).digest("base64url")}"`,
  };
}

async function scanWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  for (const relativePath of WORKSPACE_ICON_RELATIVE_PATHS) {
    const icon = await readWorkspaceIconCandidate(workspaceRoot, relativePath);
    if (icon) {
      return icon;
    }
  }
  return null;
}

/**
 * Resolves a workspace icon once per Gateway process. Project icons are
 * process-stable metadata like plugin manifests: a changed icon is picked up on
 * the next Gateway start, never by re-scanning the workspace on a hot path.
 */
export function resolveWorkspaceIcon(workspaceRoot: string): Promise<WorkspaceIconResolution> {
  const cacheKey = path.resolve(workspaceRoot);
  const cached = workspaceIconCache.get(cacheKey);
  if (cached) {
    workspaceIconCache.delete(cacheKey);
    workspaceIconCache.set(cacheKey, cached);
    return cached;
  }
  const pending = scanWorkspaceIcon(cacheKey);
  workspaceIconCache.set(cacheKey, pending);
  pruneMapToMaxSize(workspaceIconCache, WORKSPACE_ICON_CACHE_MAX_ENTRIES);
  return pending;
}

const getSessionsFilesModule = createLazyRuntimeModule(
  () => import("./server-methods/sessions-files.js"),
);

/**
 * Single point where a session's snapshot becomes visible: cache entry and
 * waiting requests move together, so a request that arrived before its
 * `chat.startup` is served by the publication that fills the cache.
 */
function publishSessionWorkspaceIcon(
  sessionKey: string,
  prepared: Promise<WorkspaceIconResolution>,
): void {
  sessionWorkspaceIconCache.delete(sessionKey);
  sessionWorkspaceIconCache.set(sessionKey, prepared);
  pruneMapToMaxSize(sessionWorkspaceIconCache, SESSION_WORKSPACE_ICON_CACHE_MAX_ENTRIES);
  const waiters = sessionWorkspaceIconWaiters.get(sessionKey);
  if (!waiters) {
    return;
  }
  sessionWorkspaceIconWaiters.delete(sessionKey);
  for (const waiter of waiters) {
    waiter({ status: "published", prepared });
  }
}

/**
 * Prepares the immutable icon snapshot while opening a chat. The HTTP asset
 * request only reads this map: no session-store or filesystem work is allowed
 * on that hot path, and icon changes become visible after Gateway restart.
 */
export async function prepareSessionWorkspaceIcon(params: {
  sessionKey: string;
  agentId?: string;
}): Promise<void> {
  const preparation = (async (): Promise<WorkspaceIconResolution> => {
    const workspaceRoot = (await getSessionsFilesModule()).resolveLocalSessionWorkspaceRoot(params);
    return workspaceRoot ? await resolveWorkspaceIcon(workspaceRoot) : null;
  })();
  // A failed optional preparation still becomes a stable fallback snapshot;
  // the returned promise rejects separately so chat.startup can record it.
  publishSessionWorkspaceIcon(
    params.sessionKey,
    preparation.catch(() => null),
  );
  await preparation;
}

/**
 * Waits for the producer to publish this session's snapshot, reporting
 * `unavailable` at the deadline, on client disconnect, or when admission is
 * saturated, so a key no `chat.startup` is preparing answers promptly instead
 * of holding the request open.
 */
function awaitSessionWorkspaceIconPublish(
  sessionKey: string,
  res: ServerResponse,
): Promise<SessionWorkspaceIconWait> {
  const existing = sessionWorkspaceIconWaiters.get(sessionKey);
  const saturated = existing
    ? existing.size >= SESSION_WORKSPACE_ICON_MAX_WAITS_PER_SESSION
    : sessionWorkspaceIconWaiters.size >= SESSION_WORKSPACE_ICON_MAX_WAITING_SESSIONS;
  if (saturated) {
    return Promise.resolve({ status: "unavailable" });
  }
  const waiters = existing ?? new Set<SessionWorkspaceIconWaiter>();
  sessionWorkspaceIconWaiters.set(sessionKey, waiters);
  return new Promise((resolve) => {
    // Every exit runs through here, so the timer, the disconnect listener, and
    // the admission slot this request holds are always released together.
    const settle: SessionWorkspaceIconWaiter = (wait) => {
      clearTimeout(deadline);
      res.off("close", abandon);
      waiters.delete(settle);
      // Only drop the bucket this waiter belongs to; a later request may have
      // installed a fresh one for the same session key.
      if (waiters.size === 0 && sessionWorkspaceIconWaiters.get(sessionKey) === waiters) {
        sessionWorkspaceIconWaiters.delete(sessionKey);
      }
      resolve(wait);
    };
    const abandon = () => settle({ status: "unavailable" });
    waiters.add(settle);
    res.once("close", abandon);
    const deadline = setTimeout(abandon, SESSION_WORKSPACE_ICON_PUBLISH_WAIT_MS);
    // A decorative icon request must never hold the Gateway process open.
    deadline.unref?.();
  });
}

function readPreparedSessionWorkspaceIcon(
  sessionKey: string,
): Promise<WorkspaceIconResolution> | undefined {
  const prepared = sessionWorkspaceIconCache.get(sessionKey);
  if (prepared) {
    sessionWorkspaceIconCache.delete(sessionKey);
    sessionWorkspaceIconCache.set(sessionKey, prepared);
  }
  return prepared;
}

/** `matched` claims the response so a malformed key 404s instead of reaching the SPA. */
type WorkspaceIconRequest = { matched: false } | { matched: true; sessionKey: string | null };

function parseWorkspaceIconRequest(
  urlRaw: string | undefined,
  basePath: string | undefined,
): WorkspaceIconRequest {
  if (!urlRaw) {
    return { matched: false };
  }
  const pathname = new URL(urlRaw, "http://localhost").pathname;
  const prefix = `${normalizeControlUiBasePath(basePath)}${CONTROL_UI_WORKSPACE_ICON_PATH_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return { matched: false };
  }
  const encoded = pathname.slice(prefix.length);
  if (!encoded || encoded.includes("/")) {
    return { matched: true, sessionKey: null };
  }
  try {
    return { matched: true, sessionKey: decodeURIComponent(encoded) || null };
  } catch {
    return { matched: true, sessionKey: null };
  }
}

/**
 * Serves the icon snapshot prepared when the chat opened. The request names a
 * session, never a path, and performs no filesystem or session-store work.
 */
export async function handleWorkspaceIconHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    auth: ResolvedGatewayAuth;
    basePath?: string;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const parsed = parseWorkspaceIconRequest(req.url, opts.basePath);
  if (!parsed.matched) {
    return false;
  }
  const method = req.method;
  if (method !== "GET" && method !== "HEAD") {
    sendMethodNotAllowed(res, "GET, HEAD");
    return true;
  }
  const requestAuth = await authorizeGatewayHttpRequestOrReply({
    req,
    res,
    auth: opts.auth,
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: opts.rateLimiter,
  });
  if (!requestAuth) {
    return true;
  }
  const scopeAuth = authorizeOperatorScopesForMethod(
    "sessions.list",
    resolveOpenAiCompatibleHttpOperatorScopes(req, requestAuth),
  );
  if (!scopeAuth.allowed) {
    sendMissingScopeForbidden(res, scopeAuth.missingScope);
    return true;
  }
  // The read scope alone is not the session's visibility decision: `sessions.list`
  // additionally hides incognito and non-owner draft sessions per client
  // (createSessionListEntryFilter). This route has no Gateway client to run that
  // filter against, so it takes the same owner gate the managed-media route uses
  // for session-scoped bytes — the identity for which that filter is a no-op.
  if (!resolveOpenAiCompatibleHttpSenderIsOwner(req, requestAuth)) {
    sendJson(res, 403, {
      ok: false,
      error: { message: "owner access required", type: "forbidden" },
    });
    return true;
  }

  if (!parsed.sessionKey) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }
  // The header can paint before this session's chat.startup lands, so a miss
  // waits for the producer instead of reporting one the browser cannot fix.
  // Read and registration share one tick: no publish can land between them.
  const cached = readPreparedSessionWorkspaceIcon(parsed.sessionKey);
  const wait: SessionWorkspaceIconWait = cached
    ? { status: "published", prepared: cached }
    : await awaitSessionWorkspaceIconPublish(parsed.sessionKey, res);
  if (wait.status === "unavailable") {
    // No snapshot arrived: never opened, aged out of the bounded cache until a
    // new chat.startup republishes it, or the wait pool was full. A published
    // absence 404s below instead. Uncacheable, so the folder fallback cannot
    // freeze into the workspace's answer.
    res.statusCode = 503;
    res.setHeader("cache-control", "no-store");
    res.setHeader("retry-after", "1");
    res.end("workspace icon snapshot is not ready");
    return true;
  }
  const icon = await wait.prepared;
  if (!icon) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  res.setHeader("etag", icon.etag);
  res.setHeader("cache-control", "private, max-age=3600");
  res.setHeader("cross-origin-resource-policy", "same-origin");
  res.setHeader("x-content-type-options", "nosniff");
  // Icons may be SVG. The UI only ever paints these bytes through an <img>,
  // which runs no script; the sandbox policy plus attachment disposition stop a
  // direct same-origin navigation from giving them a document context anyway.
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; sandbox",
  );
  res.setHeader("content-disposition", 'attachment; filename="workspace-icon"');
  if (matchesHttpIfNoneMatch(req.headers["if-none-match"], icon.etag)) {
    res.statusCode = 304;
    res.end();
    return true;
  }
  res.statusCode = 200;
  res.setHeader("content-type", icon.contentType);
  res.setHeader("content-length", String(icon.body.byteLength));
  res.end(method === "HEAD" ? undefined : icon.body);
  return true;
}
