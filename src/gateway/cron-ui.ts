/**
 * Cron UI HTTP handler — serves built assets from dist/cron-ui/
 * Follows the same pattern as control-ui.ts
 */

import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UI_BASE_PATH = "/ui/cron";

function resolveCronUiRoot(): string | null {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    // From dist: dist/gateway/cron-ui.js -> dist/cron-ui
    path.resolve(here, "../cron-ui"),
    // From source: src/gateway/cron-ui.ts -> dist/cron-ui
    path.resolve(here, "../../dist/cron-ui"),
    // Fallback to cwd
    path.resolve(process.cwd(), "dist", "cron-ui"),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, "index.html"))) return dir;
  }
  return null;
}

function contentType(ext: string): string {
  switch (ext) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
      return "application/javascript; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".json":
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".ico":
      return "image/x-icon";
    default:
      return "application/octet-stream";
  }
}

function isSafePath(relPath: string): boolean {
  if (!relPath) return false;
  const normalized = path.posix.normalize(relPath);
  if (normalized.startsWith("../") || normalized === "..") return false;
  if (normalized.includes("\0")) return false;
  return true;
}

export function handleCronUiHttpRequest(req: IncomingMessage, res: ServerResponse): boolean {
  const urlRaw = req.url;
  if (!urlRaw) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const url = new URL(urlRaw, "http://localhost");
  const pathname = url.pathname;

  // Redirect /ui/cron to /ui/cron/
  if (pathname === UI_BASE_PATH) {
    res.statusCode = 302;
    res.setHeader("Location", `${UI_BASE_PATH}/${url.search}`);
    res.end();
    return true;
  }

  if (!pathname.startsWith(`${UI_BASE_PATH}/`)) return false;

  const root = resolveCronUiRoot();
  if (!root) {
    res.statusCode = 503;
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    res.end("Cron UI not built. Run: pnpm ui:cron:build");
    return true;
  }

  const subPath = pathname.slice(UI_BASE_PATH.length + 1);
  const fileRel = subPath && !subPath.endsWith("/") ? subPath : "index.html";

  if (!isSafePath(fileRel)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  const filePath = path.join(root, fileRel);
  if (!filePath.startsWith(root)) {
    res.statusCode = 404;
    res.end("Not Found");
    return true;
  }

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath).toLowerCase();
    res.setHeader("Content-Type", contentType(ext));
    res.setHeader(
      "Cache-Control",
      ext === ".html" ? "no-cache" : "public, max-age=31536000, immutable",
    );
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(fs.readFileSync(filePath));
    }
    return true;
  }

  // SPA fallback: serve index.html
  const indexPath = path.join(root, "index.html");
  if (fs.existsSync(indexPath)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.end(fs.readFileSync(indexPath));
    return true;
  }

  res.statusCode = 404;
  res.end("Not Found");
  return true;
}
