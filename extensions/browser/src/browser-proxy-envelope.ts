import { asNullableRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ResolvedBrowserProfile } from "./browser/config.js";
/**
 * Browser node-proxy response envelope shared by the node host and Gateway.
 */
import { parseBrowserErrorPayload, type BrowserErrorPayload } from "./browser/errors.js";

/** Additive opt-in for structured browser route errors over node.invoke. */
export const BROWSER_PROXY_ERROR_ENVELOPE = "browser-v1" as const;
/** Additive request envelope for Gateway-owned files sent to a browser node. */
export const BROWSER_PROXY_UPLOAD_ENVELOPE = "browser-upload-v1" as const;
/** Private node-host operation; unknown older nodes reject it before closing anything. */
export const BROWSER_PROXY_OWNED_TAB_CLOSE_PATH = "/__openclaw/session-tab/close-owned";

export const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;
// 16 MiB expands to about 21.4 MiB in base64, leaving JSON/result headroom
// below the Gateway's 25 MiB WebSocket frame limit.
const BROWSER_PROXY_MAX_TOTAL_FILE_BYTES = 16 * 1024 * 1024;
const BROWSER_PROXY_MAX_FILES = 256;

/** Bound filesystem work even when one action emits many tiny downloads. */
export function assertBrowserProxyFileCountWithinLimit(
  fileCount: number,
  direction: "request" | "response" = "response",
): void {
  if (fileCount > BROWSER_PROXY_MAX_FILES) {
    throw new Error(`browser proxy ${direction} exceeds 256 file limit`);
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

export type BrowserProxyUploadFile = {
  name: string;
  contentBase64: string;
};

export type BrowserProxyUploadV1 = {
  envelope: typeof BROWSER_PROXY_UPLOAD_ENVELOPE;
  files: BrowserProxyUploadFile[];
};

export type BrowserProxyRoute =
  | {
      status: "resolved";
      profile: string;
      driver: ResolvedBrowserProfile["driver"];
    }
  | { status: "unavailable" }
  | { status: "host-fallback" };

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

type BrowserProxyErrorBody = BrowserErrorPayload;

export type BrowserProxySuccess = {
  result: unknown;
  files?: BrowserProxyFile[];
  route?: BrowserProxyRoute;
};

type BrowserProxyFailure = {
  error: {
    status: number;
    body: BrowserProxyErrorBody;
  };
  route?: BrowserProxyRoute;
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
export function createBrowserProxyFailure(
  status: number,
  body: unknown,
  route?: BrowserProxyRoute,
): BrowserProxyFailure {
  return {
    error: {
      status,
      body: normalizeBrowserProxyErrorBody(body, `HTTP ${status}`) ?? { error: `HTTP ${status}` },
    },
    ...(route ? { route } : {}),
  };
}

export function parseBrowserProxyRoute(value: unknown): BrowserProxyRoute | undefined {
  const route = asNullableRecord(asNullableRecord(value)?.route);
  if (!route) {
    return undefined;
  }
  if (route.status === "unavailable") {
    return { status: "unavailable" };
  }
  if (route.status === "host-fallback") {
    return { status: "host-fallback" };
  }
  if (
    route.status !== "resolved" ||
    typeof route.profile !== "string" ||
    !route.profile.trim() ||
    (route.driver !== "openclaw" &&
      route.driver !== "existing-session" &&
      route.driver !== "extension")
  ) {
    return undefined;
  }
  return {
    status: "resolved",
    profile: route.profile.trim(),
    driver: route.driver,
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
  const route = parseBrowserProxyRoute(value);
  return {
    error: { status: candidate.status as number, body },
    ...(route ? { route } : {}),
  };
}
