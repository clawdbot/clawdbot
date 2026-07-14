// Static-file serving for approved custom widgets, under the `auth:"plugin"`
// HTTP route. The authenticated gateway first mints a path-scoped capability,
// bound to the widget and approved-file snapshot; every asset request validates
// it before touching the registry or disk. Every rejection returns 404
// (never 403) so the route never leaks whether a widget or file exists.
//
// The path jail combines strict logical-path normalization with the shared
// race-safe rooted reader, which rejects symlinks, hardlinks, and escapes.

import fs from "node:fs/promises";
import type { ServerResponse } from "node:http";
import path from "node:path";
import { root as fsRoot } from "openclaw/plugin-sdk/security-runtime";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import {
  CUSTOM_WIDGET_NAME_PATTERN,
  matchesApprovedFile,
  MAX_WIDGET_FILE_BYTES,
  resolveWidgetDir,
  WIDGET_CONTENT_TYPES,
} from "./manifest.js";
import type { WorkspaceStore } from "./store.js";

export const WIDGETS_ROUTE_PREFIX = "/plugins/workspaces/widgets";

// Spec §Server side: strict CSP on every widget response. `connect-src 'none'`
// blocks script networking and `frame-ancestors 'self'` keeps the frame embeddable
// only by the Control UI. Custom code receives only static workspace values: a
// sandboxed child can navigate itself, so privileged RPC/file data stays in the
// trusted built-in renderers.
export const WIDGET_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'self' 'unsafe-inline'; " +
  "style-src 'self' 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'self'";

type WidgetServeDeps = {
  store: WorkspaceStore;
  stateDir?: string;
};

type WidgetServeRequest = {
  method: string | undefined;
  /** URL pathname (no query/hash), already URL-decoded per segment by the caller. */
  pathname: string;
};

const BRIDGE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{20,100}$/;

/**
 * Runs before approved widget bytes and creates a MessagePort owned by that exact
 * document. WindowProxy identity survives navigation; a port does not, so a
 * replacement page can never inherit the parent bridge.
 */
function injectBridgeBootstrap(data: Buffer, bridgeToken: string | undefined): Buffer {
  if (!bridgeToken || !BRIDGE_TOKEN_PATTERN.test(bridgeToken)) {
    return data;
  }
  const bootstrap = `<script>(()=>{const channel=new MessageChannel();const listeners=new Set();const port=channel.port1;port.onmessage=(event)=>{for(const listener of listeners)listener(event)};port.start();Object.defineProperty(window,"openclawWorkspaceBridge",{configurable:false,writable:false,value:Object.freeze({postMessage:(message)=>port.postMessage(message),addEventListener:(type,listener)=>{if(type==="message")listeners.add(listener)},removeEventListener:(type,listener)=>{if(type==="message")listeners.delete(listener)}})});window.parent.postMessage({v:1,type:"workspace:bridge:init",token:"${bridgeToken}"},"*",[channel.port2])})();</script>`;
  const html = data.toString("utf8");
  const doctype = html.match(/^\uFEFF?(?:\s|<!--[\s\S]*?-->)*<!doctype[^>]*>/i)?.[0] ?? "";
  return Buffer.from(`${doctype}${bootstrap}${html.slice(doctype.length)}`);
}

/** Copy of the canvas logical-path normalizer (documents.ts:79). */
function normalizeLogicalPath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  const parts = normalized.split("/").filter(Boolean);
  if (
    parts.length === 0 ||
    parts.some(
      (part) => part === "." || part === ".." || part.includes(":") || hasControlCharacter(part),
    )
  ) {
    throw new Error("widget logical path invalid");
  }
  return parts.join("/");
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/** True when the pathname is under this route's prefix (so the route owns it). */
function isWidgetRoutePath(pathname: string): boolean {
  return pathname === WIDGETS_ROUTE_PREFIX || pathname.startsWith(`${WIDGETS_ROUTE_PREFIX}/`);
}

/**
 * Splits a request pathname under the widgets prefix into `{ name, logicalPath }`.
 * Returns null when the pathname is not under the prefix or is malformed. Each
 * segment is URL-decoded; a decode failure yields null (→ 404).
 */
export function parseWidgetRequestPath(
  pathname: string,
): { frameToken: string; name: string; logicalPath: string } | null {
  const prefix = `${WIDGETS_ROUTE_PREFIX}/`;
  if (!pathname.startsWith(prefix)) {
    return null;
  }
  const rest = pathname.slice(prefix.length);
  const rawSegments = rest.split("/");
  const segments: string[] = [];
  for (const segment of rawSegments) {
    if (!segment) {
      // A trailing/duplicated slash collapses; an empty leading segment is dropped.
      continue;
    }
    try {
      segments.push(decodeURIComponent(segment));
    } catch {
      return null;
    }
  }
  if (segments.length < 3) {
    return null;
  }
  const [frameToken, name, ...entry] = segments;
  if (!frameToken || !name) {
    return null;
  }
  if (!BRIDGE_TOKEN_PATTERN.test(frameToken)) {
    return null;
  }
  // The charset pattern permits dots, so `.`/`..` slip through it — reject the
  // traversal names explicitly (mirrors normalizeCanvasDocumentId, documents.ts:107).
  if (name === "." || name === ".." || !CUSTOM_WIDGET_NAME_PATTERN.test(name)) {
    return null;
  }
  let logicalPath: string;
  try {
    logicalPath = normalizeLogicalPath(entry.join("/"));
  } catch {
    return null;
  }
  return { frameToken, name, logicalPath };
}

/**
 * Content type for a logical path, or null when the extension is not servable.
 * The table lives in `manifest.ts` because approval hashes exactly this file set.
 */
function extensionContentType(logicalPath: string): string | null {
  const extension = path.extname(logicalPath).toLowerCase();
  return WIDGET_CONTENT_TYPES[extension] ?? null;
}

/**
 * The strict security headers EVERY widget-route response must carry — 200 and
 * 404 alike. A 404 is still an attacker-influenced response served from the
 * widget origin, so it needs the same `connect-src 'none'` lockdown. Shared here
 * so the two response paths can never drift apart again. Content-Type is set
 * per-path (it differs) and is intentionally not included.
 */
function setSecurityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", WIDGET_CSP);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function notFound(res: ServerResponse): true {
  res.statusCode = 404;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  setSecurityHeaders(res);
  res.end("not found");
  return true;
}

/**
 * Resolves and serves a static asset for an approved custom widget, writing the
 * response directly. Returns true when the request was under this route (handled),
 * false when the pathname is not a widget path (caller may fall through).
 *
 * Every failure mode (wrong method, unknown/pending/rejected widget, jail
 * violation, disallowed extension, missing file) is a 404 — never 403 — so the
 * unauthenticated route reveals nothing about what exists on disk.
 */
export async function serveWidgetAsset(
  req: WidgetServeRequest,
  res: ServerResponse,
  deps: WidgetServeDeps,
): Promise<boolean> {
  // A pathname NOT under this route falls through (returns false); a pathname
  // under the route but malformed (traversal, bad charset, encoded escape) is
  // OWNED by this route and answered with 404 — never fall-through, never 403.
  if (!isWidgetRoutePath(req.pathname)) {
    return false;
  }
  const parsed = parseWidgetRequestPath(req.pathname);
  if (!parsed) {
    return notFound(res);
  }
  // Non-GET is not merely rejected — it is indistinguishable from a miss (404).
  if (req.method !== "GET" && req.method !== "HEAD") {
    return notFound(res);
  }

  const contentType = extensionContentType(parsed.logicalPath);
  if (!contentType) {
    return notFound(res);
  }

  // Reject guessed/expired tokens before even consulting the registry or disk.
  if (!deps.store.assetTokens.isIssued(parsed.frameToken, parsed.name)) {
    return notFound(res);
  }

  // Serving gate: only `status === "approved"` widgets are served AT ALL. This is
  // belt-and-braces with the UI render gate (the UI never builds an iframe for a
  // pending/rejected widget, and the server refuses its assets regardless).
  let approvedFiles: Record<string, string> | undefined;
  try {
    const entry = deps.store.widgetEntry(parsed.name);
    if (entry?.status !== "approved") {
      return notFound(res);
    }
    approvedFiles = entry.approvedFiles;
    if (
      !approvedFiles ||
      !deps.store.assetTokens.allows(parsed.frameToken, parsed.name, approvedFiles)
    ) {
      return notFound(res);
    }
  } catch {
    return notFound(res);
  }

  const stateDir = path.resolve(deps.stateDir ?? resolveStateDir());
  let widgetDir: string;
  try {
    widgetDir = resolveWidgetDir(parsed.name, stateDir);
  } catch {
    return notFound(res);
  }
  let data: Buffer;
  try {
    // Widget files stay writable after approval. Pin and validate the opened file
    // so post-approval symlink, hardlink, and oversized swaps all fail closed.
    const widgetRoot = await fsRoot(stateDir, {
      hardlinks: "reject",
      maxBytes: MAX_WIDGET_FILE_BYTES,
      nonBlockingRead: true,
      symlinks: "reject",
    });
    const widgetStat = await fs.lstat(widgetDir);
    const widgetReal = await fs.realpath(widgetDir);
    const expectedWidgetReal = path.join(widgetRoot.rootReal, "workspaces", "widgets", parsed.name);
    if (
      widgetStat.isSymbolicLink() ||
      !widgetStat.isDirectory() ||
      widgetReal !== expectedWidgetReal
    ) {
      return notFound(res);
    }
    const read = await widgetRoot.read(
      path.posix.join("workspaces", "widgets", parsed.name, parsed.logicalPath),
      {
        hardlinks: "reject",
        maxBytes: MAX_WIDGET_FILE_BYTES,
        nonBlockingRead: true,
        symlinks: "reject",
      },
    );
    if (read.realPath !== widgetReal && !read.realPath.startsWith(`${widgetReal}${path.sep}`)) {
      return notFound(res);
    }
    data = read.buffer;
  } catch {
    return notFound(res);
  }

  // The operator approved these exact bytes. A file edited or added after
  // approval has no matching digest and is indistinguishable from a miss.
  if (!matchesApprovedFile(approvedFiles, parsed.logicalPath, data)) {
    return notFound(res);
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", contentType);
  setSecurityHeaders(res);
  if (req.method === "HEAD") {
    res.end();
  } else {
    const body = contentType.startsWith("text/html")
      ? injectBridgeBootstrap(data, parsed.frameToken)
      : data;
    res.end(body);
  }
  return true;
}
