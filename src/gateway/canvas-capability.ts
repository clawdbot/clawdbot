import { randomBytes } from "node:crypto";

export const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";
const CANVAS_CAPABILITY_QUERY_PARAM = "oc_cap";
export const CANVAS_CAPABILITY_TTL_MS = 10 * 60_000;

type NormalizedCanvasScopedUrl = {
  pathname: string;
  capability?: string;
  rewrittenUrl?: string;
  scopedPath: boolean;
  malformedScopedPath: boolean;
};

function normalizeCapability(raw: string | null | undefined): string | undefined {
  const trimmed = raw?.trim();
  return trimmed ? trimmed : undefined;
}

export function mintCanvasCapabilityToken(): string {
  return randomBytes(18).toString("base64url");
}

export function buildCanvasScopedHostUrl(baseUrl: string, capability: string): string | undefined {
  const normalizedCapability = normalizeCapability(capability);
  if (!normalizedCapability) {
    return undefined;
  }
  try {
    const url = new URL(baseUrl);
    const trimmedPath = url.pathname.replace(/\/+$/, "");
    const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/${encodeURIComponent(normalizedCapability)}`;
    url.pathname = `${trimmedPath}${prefix}`;
    url.search = "";
    url.hash = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

export function normalizeCanvasScopedUrl(rawUrl: string): NormalizedCanvasScopedUrl {
  const url = new URL(rawUrl, "http://localhost");
  const prefix = `${CANVAS_CAPABILITY_PATH_PREFIX}/`;
  let scopedPath = false;
  let malformedScopedPath = false;
  let capabilityFromPath: string | undefined;
  let rewrittenUrl: string | undefined;

  if (url.pathname.startsWith(prefix)) {
    scopedPath = true;
    const remainder = url.pathname.slice(prefix.length);
    const slashIndex = remainder.indexOf("/");
    if (slashIndex <= 0) {
      malformedScopedPath = true;
    } else {
      const encodedCapability = remainder.slice(0, slashIndex);
      const canonicalPath = remainder.slice(slashIndex) || "/";
      let decoded: string | undefined;
      try {
        decoded = decodeURIComponent(encodedCapability);
      } catch {
        malformedScopedPath = true;
      }
      capabilityFromPath = normalizeCapability(decoded);
      if (!capabilityFromPath || !canonicalPath.startsWith("/")) {
        malformedScopedPath = true;
      } else {
        url.pathname = canonicalPath;
        if (!url.searchParams.has(CANVAS_CAPABILITY_QUERY_PARAM)) {
          url.searchParams.set(CANVAS_CAPABILITY_QUERY_PARAM, capabilityFromPath);
        }
        rewrittenUrl = `${url.pathname}${url.search}`;
      }
    }
  }

  const capability =
    capabilityFromPath ?? normalizeCapability(url.searchParams.get(CANVAS_CAPABILITY_QUERY_PARAM));
  return {
    pathname: url.pathname,
    capability,
    rewrittenUrl,
    scopedPath,
    malformedScopedPath,
  };
}
