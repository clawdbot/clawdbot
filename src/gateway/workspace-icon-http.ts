// Serves a workspace directory's own project icon so the Control UI can render
// real project identity instead of a generic folder glyph.
import { createHash } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
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
 * Conventional project icon locations, ordered by framework specificity and then
 * by rendering fidelity (vector before raster). Resolution stops at the first
 * hit, so this list is the whole filesystem cost of a workspace: keeping it
 * bounded is what makes icon lookup a one-time-per-workspace operation.
 */
const WORKSPACE_ICON_RELATIVE_PATHS = [
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "public/apple-touch-icon.png",
  "static/favicon.svg",
  "static/favicon.ico",
  "static/favicon.png",
  "app/icon.svg",
  "app/icon.png",
  "app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "src/app/favicon.ico",
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
] as const;

/** Icons are small by construction; anything larger is not a favicon. */
export const WORKSPACE_ICON_MAX_BYTES = 512 * 1024;
/** Vector icons are markup the renderer must parse, so they get a tighter cap. */
export const SVG_ICON_MAX_BYTES = 64 * 1024;
const WORKSPACE_ICON_CACHE_MAX_ENTRIES = 32;
const SVG_MIME_TYPE = "image/svg+xml";
const ICO_MIME_TYPE = "image/x-icon";

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

let workspaceIconCache = new Map<string, Promise<WorkspaceIconResolution>>();

export function clearWorkspaceIconCacheForTest(): void {
  workspaceIconCache = new Map();
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
    fs.closeSync(opened.fd);
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
 * Serves the icon of the workspace a session runs in. The request names a
 * session, never a path: the served file is whatever the process-cached
 * resolution already picked inside that session's own workspace root.
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

  const workspaceRoot = parsed.sessionKey
    ? (await getSessionsFilesModule()).resolveLocalSessionWorkspaceRoot({
        sessionKey: parsed.sessionKey,
      })
    : undefined;
  const icon = workspaceRoot ? await resolveWorkspaceIcon(workspaceRoot) : null;
  if (!icon) {
    // A workspace can gain an icon later, and this route has no revalidation
    // token for an absent one; caching the miss would hide it until expiry.
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
