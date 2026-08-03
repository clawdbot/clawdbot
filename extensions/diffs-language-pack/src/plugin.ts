// Diffs Language Pack plugin module implements plugin behavior.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawPluginApi } from "../api.js";
import { VIEWER_ASSET_PREFIX, VIEWER_RUNTIME_PATH, getServedViewerAsset } from "./viewer-assets.js";

const IMMUTABLE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable";

export function registerDiffsLanguagePackPlugin(api: OpenClawPluginApi): void {
  api.registerHttpRoute({
    path: "/plugins/diffs-language-pack",
    auth: "plugin",
    match: "prefix",
    handler: createDiffsLanguagePackHttpHandler(),
  });
}

function createDiffsLanguagePackHttpHandler() {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const parsed = parseRequestUrl(req.url);
    if (!parsed?.pathname.startsWith(VIEWER_ASSET_PREFIX)) {
      return false;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      respondText(res, 405, "Method not allowed");
      return true;
    }

    const asset = await getServedViewerAsset(parsed.pathname);
    if (!asset) {
      respondText(res, 404, "Asset not found");
      return true;
    }

    res.statusCode = 200;
    setSharedHeaders(
      res,
      asset.contentType,
      parsed.pathname === VIEWER_RUNTIME_PATH ? IMMUTABLE_ASSET_CACHE_CONTROL : undefined,
    );
    if (req.method === "HEAD") {
      res.end();
    } else {
      res.end(asset.body);
    }
    return true;
  };
}

function parseRequestUrl(rawUrl?: string): URL | null {
  if (!rawUrl) {
    return null;
  }
  try {
    return new URL(rawUrl, "http://127.0.0.1");
  } catch {
    return null;
  }
}

function respondText(res: ServerResponse, statusCode: number, body: string): void {
  res.statusCode = statusCode;
  setSharedHeaders(res, "text/plain; charset=utf-8");
  res.end(body);
}

function setSharedHeaders(
  res: ServerResponse,
  contentType: string,
  cacheControl = "no-store, max-age=0",
): void {
  res.setHeader("cache-control", cacheControl);
  res.setHeader("content-type", contentType);
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
}
