/**
 * Browser node-proxy response envelope shared by the node host and Gateway.
 */
import { parseBrowserErrorPayload, type BrowserNoDisplayErrorMetadata } from "./browser/errors.js";

/** Additive opt-in for structured browser route errors over node.invoke. */
export const BROWSER_PROXY_ERROR_ENVELOPE = "browser-v1" as const;

export const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;
// 16 MiB expands to about 21.4 MiB in base64, leaving JSON/result headroom
// below the Gateway's 25 MiB WebSocket frame limit.
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const BROWSER_PROXY_MAX_FILES = 256;

/** Bound filesystem work even when one action emits many tiny downloads. */
export function assertBrowserProxyFileCountWithinLimit(fileCount: number): void {
  if (fileCount > BROWSER_PROXY_MAX_FILES) {
    throw new Error("browser proxy response exceeds 256 file limit");
  }
}

/** Enforce the shared per-file and raw aggregate Browser proxy limits. */
export function assertBrowserProxyFileBytesWithinLimits(
  fileBytes: number,
  totalBytes: number,
): void {
  if (fileBytes > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error("browser proxy file exceeds 10 MiB limit");
  }
  if (totalBytes > BROWSER_PROXY_MAX_TOTAL_FILE_BYTES) {
    throw new Error("browser proxy files exceed 16 MiB aggregate limit");
  }
}

export type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

/** Visit the route-owned file paths that may cross the Browser node boundary. */
export function visitBrowserProxyFilePaths(
  result: unknown,
  visit: (filePath: string) => string | void,
): void {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return;
  }
  const root = result as Record<string, unknown>;
  const visitPath = (owner: Record<string, unknown>, key: "path" | "imagePath") => {
    const filePath = owner[key];
    if (typeof filePath !== "string" || !filePath.trim()) {
      return;
    }
    const replacement = visit(filePath);
    if (typeof replacement === "string") {
      owner[key] = replacement;
    }
  };

  visitPath(root, "path");
  visitPath(root, "imagePath");

  const download = root.download;
  if (download && typeof download === "object" && !Array.isArray(download)) {
    visitPath(download as Record<string, unknown>, "path");
  }

  // Stay shallow: evaluate results contain page-controlled objects whose
  // path-like fields must never become node filesystem reads.
  if (Array.isArray(root.downloads)) {
    for (const entry of root.downloads) {
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        visitPath(entry as Record<string, unknown>, "path");
      }
    }
  }
}

type BrowserProxyErrorBody =
  | { error: string }
  | ({ error: string } & BrowserNoDisplayErrorMetadata);

export type BrowserProxySuccess = {
  result: unknown;
  files?: BrowserProxyFile[];
};

type BrowserProxyFailure = {
  error: {
    status: number;
    body: BrowserProxyErrorBody;
  };
};

export type BrowserProxyEnvelope = BrowserProxySuccess | BrowserProxyFailure;

function normalizeBrowserProxyErrorBody(
  value: unknown,
  fallback?: string,
): BrowserProxyErrorBody | null {
  const parsed = parseBrowserErrorPayload(value);
  if (parsed) {
    return parsed;
  }
  return fallback ? { error: fallback } : null;
}

/** Build a route-failure envelope while allowing only closed Browser metadata. */
export function createBrowserProxyFailure(status: number, body: unknown): BrowserProxyFailure {
  return {
    error: {
      status,
      body: normalizeBrowserProxyErrorBody(body, `HTTP ${status}`) ?? { error: `HTTP ${status}` },
    },
  };
}

/** Parse an untrusted node response without forwarding arbitrary metadata. */
export function parseBrowserProxyFailure(value: unknown): BrowserProxyFailure | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const error = (value as { error?: unknown }).error;
  if (!error || typeof error !== "object" || Array.isArray(error)) {
    return null;
  }
  const candidate = error as { status?: unknown; body?: unknown };
  if (
    !Number.isInteger(candidate.status) ||
    (candidate.status as number) < 400 ||
    (candidate.status as number) > 599
  ) {
    return null;
  }
  const body = normalizeBrowserProxyErrorBody(candidate.body);
  if (!body) {
    return null;
  }
  return { error: { status: candidate.status as number, body } };
}
