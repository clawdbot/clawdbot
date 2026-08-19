// Serves a workspace directory's own project icon so the Control UI can render
// real project identity instead of a generic folder glyph.
import { close } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
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
import {
  HTTP_IMAGE_MAX_BYTES,
  HTTP_SVG_MAX_BYTES,
  resolveHttpImageRepresentation,
  sendHttpImageResponse,
  type HttpImageRepresentation,
} from "./http-image-response.js";
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
export const WORKSPACE_ICON_MAX_BYTES = HTTP_IMAGE_MAX_BYTES;
/** Vector icons are markup the renderer must parse, so they get a tighter cap. */
export const SVG_ICON_MAX_BYTES = HTTP_SVG_MAX_BYTES;
const WORKSPACE_ICON_CACHE_MAX_ENTRIES = 32;
const SESSION_WORKSPACE_ICON_CACHE_MAX_ENTRIES = 128;
const closeFileDescriptor = promisify(close);
type WorkspaceIcon = HttpImageRepresentation;

/** `null` records a resolved absence so a workspace without an icon never re-scans. */
type WorkspaceIconResolution = WorkspaceIcon | null;

let workspaceIconCache = new Map<string, Promise<WorkspaceIconResolution>>();
let sessionWorkspaceIconCache = new Map<string, Promise<WorkspaceIconResolution>>();

export function clearWorkspaceIconCacheForTest(): void {
  workspaceIconCache = new Map();
  sessionWorkspaceIconCache = new Map();
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
  return await resolveHttpImageRepresentation(relativePath, body);
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
  sessionWorkspaceIconCache.delete(params.sessionKey);
  // A failed optional preparation still becomes a stable fallback snapshot;
  // the returned promise rejects separately so chat.startup can record it.
  sessionWorkspaceIconCache.set(
    params.sessionKey,
    preparation.catch(() => null),
  );
  pruneMapToMaxSize(sessionWorkspaceIconCache, SESSION_WORKSPACE_ICON_CACHE_MAX_ENTRIES);
  await preparation;
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
  const prepared = readPreparedSessionWorkspaceIcon(parsed.sessionKey);
  if (!prepared) {
    // The header can paint before chat.startup finishes. Keep this state
    // retryable so it cannot be cached as the workspace's resolved fallback.
    res.statusCode = 503;
    res.setHeader("cache-control", "no-store");
    res.setHeader("retry-after", "1");
    res.end("workspace icon snapshot is not ready");
    return true;
  }
  const icon = await prepared;
  if (!icon) {
    res.setHeader("cache-control", "no-store");
    respondNotFound(res);
    return true;
  }

  sendHttpImageResponse({ req, res, image: icon, filename: "workspace-icon" });
  return true;
}
