import fsPromises from "node:fs/promises";
import { redactCdpUrl } from "../browser/cdp.helpers.js";
import { resolveBrowserConfig } from "../browser/config.js";
import {
  createBrowserControlContext,
  startBrowserControlServiceFromConfig,
} from "../browser/control-service.js";
import { createBrowserRouteDispatcher } from "../browser/routes/dispatcher.js";
import { loadConfig } from "../config/config.js";
import {
  browserClusterHealth,
  canProxyBrowserClusterPath,
  proxyBrowserCluster,
  shouldUseBrowserCluster,
} from "../integrations/browser-cluster-client.js";
import { detectMime } from "../media/mime.js";
import { withTimeout } from "./with-timeout.js";

type BrowserProxyParams = {
  method?: string;
  path?: string;
  query?: Record<string, string | number | boolean | null | undefined>;
  body?: unknown;
  timeoutMs?: number;
  profile?: string;
};

type BrowserProxyFile = {
  path: string;
  base64: string;
  mimeType?: string;
};

type BrowserProxyResult = {
  result: unknown;
  files?: BrowserProxyFile[];
};

const BROWSER_PROXY_MAX_FILE_BYTES = 10 * 1024 * 1024;
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 20_000;
const BROWSER_PROXY_STATUS_TIMEOUT_MS = 750;

function normalizeProfileAllowlist(raw?: string[]): string[] {
  return Array.isArray(raw) ? raw.map((entry) => entry.trim()).filter(Boolean) : [];
}

function resolveBrowserProxyConfig() {
  const cfg = loadConfig();
  const proxy = cfg.nodeHost?.browserProxy;
  const allowProfiles = normalizeProfileAllowlist(proxy?.allowProfiles);
  const enabled = proxy?.enabled !== false;
  return { enabled, allowProfiles };
}

let browserControlReady: Promise<void> | null = null;

async function ensureBrowserControlService(): Promise<void> {
  if (browserControlReady) {
    return browserControlReady;
  }
  browserControlReady = (async () => {
    const cfg = loadConfig();
    const resolved = resolveBrowserConfig(cfg.browser, cfg);
    if (!resolved.enabled) {
      throw new Error("browser control disabled");
    }
    const started = await startBrowserControlServiceFromConfig();
    if (!started) {
      throw new Error("browser control disabled");
    }
  })();
  return browserControlReady;
}

function isProfileAllowed(params: { allowProfiles: string[]; profile?: string | null }) {
  const { allowProfiles, profile } = params;
  if (!allowProfiles.length) {
    return true;
  }
  if (!profile) {
    return false;
  }
  return allowProfiles.includes(profile.trim());
}

function collectBrowserProxyPaths(payload: unknown): string[] {
  const paths = new Set<string>();
  const obj =
    typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  if (!obj) {
    return [];
  }
  if (typeof obj.path === "string" && obj.path.trim()) {
    paths.add(obj.path.trim());
  }
  if (typeof obj.imagePath === "string" && obj.imagePath.trim()) {
    paths.add(obj.imagePath.trim());
  }
  const download = obj.download;
  if (download && typeof download === "object") {
    const dlPath = (download as Record<string, unknown>).path;
    if (typeof dlPath === "string" && dlPath.trim()) {
      paths.add(dlPath.trim());
    }
  }
  return [...paths];
}

async function readBrowserProxyFile(filePath: string): Promise<BrowserProxyFile | null> {
  const stat = await fsPromises.stat(filePath).catch(() => null);
  if (!stat || !stat.isFile()) {
    return null;
  }
  if (stat.size > BROWSER_PROXY_MAX_FILE_BYTES) {
    throw new Error(
      `browser proxy file exceeds ${Math.round(BROWSER_PROXY_MAX_FILE_BYTES / (1024 * 1024))}MB`,
    );
  }
  const buffer = await fsPromises.readFile(filePath);
  const mimeType = await detectMime({ buffer, filePath });
  return { path: filePath, base64: buffer.toString("base64"), mimeType };
}

function decodeParams<T>(raw?: string | null): T {
  if (!raw) {
    throw new Error("INVALID_REQUEST: paramsJSON required");
  }
  return JSON.parse(raw) as T;
}

function resolveBrowserProxyTimeout(timeoutMs?: number): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? Math.max(1, Math.floor(timeoutMs))
    : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;
}

function isBrowserProxyTimeoutError(err: unknown): boolean {
  return String(err).includes("browser proxy request timed out");
}

function isWsBackedBrowserProxyPath(path: string): boolean {
  return (
    path === "/act" ||
    path === "/navigate" ||
    path === "/pdf" ||
    path === "/screenshot" ||
    path === "/snapshot"
  );
}

async function readBrowserProxyStatus(params: {
  dispatcher: ReturnType<typeof createBrowserRouteDispatcher>;
  profile?: string;
}): Promise<Record<string, unknown> | null> {
  const query = params.profile ? { profile: params.profile } : {};
  try {
    const response = await withTimeout(
      (signal) =>
        params.dispatcher.dispatch({
          method: "GET",
          path: "/",
          query,
          signal,
        }),
      BROWSER_PROXY_STATUS_TIMEOUT_MS,
      "browser proxy status",
    );
    if (response.status >= 400 || !response.body || typeof response.body !== "object") {
      return null;
    }
    const body = response.body as Record<string, unknown>;
    return {
      running: body.running,
      transport: body.transport,
      cdpHttp: body.cdpHttp,
      cdpReady: body.cdpReady,
      cdpUrl: body.cdpUrl,
    };
  } catch {
    return null;
  }
}

function formatBrowserProxyTimeoutMessage(params: {
  method: string;
  path: string;
  profile?: string;
  timeoutMs: number;
  wsBacked: boolean;
  status: Record<string, unknown> | null;
}): string {
  const parts = [
    `browser proxy timed out for ${params.method} ${params.path} after ${params.timeoutMs}ms`,
    params.wsBacked ? "ws-backed browser action" : "browser action",
  ];
  if (params.profile) {
    parts.push(`profile=${params.profile}`);
  }
  if (params.status) {
    const statusParts = [
      `running=${String(params.status.running)}`,
      `cdpHttp=${String(params.status.cdpHttp)}`,
      `cdpReady=${String(params.status.cdpReady)}`,
    ];
    if (typeof params.status.transport === "string" && params.status.transport.trim()) {
      statusParts.push(`transport=${params.status.transport}`);
    }
    if (typeof params.status.cdpUrl === "string" && params.status.cdpUrl.trim()) {
      statusParts.push(`cdpUrl=${redactCdpUrl(params.status.cdpUrl)}`);
    }
    parts.push(`status(${statusParts.join(", ")})`);
  }
  return parts.join("; ");
}

export async function runBrowserProxyCommand(paramsJSON?: string | null): Promise<string> {
  const params = decodeParams<BrowserProxyParams>(paramsJSON);
  const pathValue = typeof params.path === "string" ? params.path.trim() : "";
  if (!pathValue) {
    throw new Error("INVALID_REQUEST: path required");
  }
  const proxyConfig = resolveBrowserProxyConfig();
  if (!proxyConfig.enabled) {
    throw new Error("UNAVAILABLE: node browser proxy disabled");
  }

  const cfg = loadConfig();
  const resolved = resolveBrowserConfig(cfg.browser, cfg);
  const requestedProfile = typeof params.profile === "string" ? params.profile.trim() : "";
  const allowedProfiles = proxyConfig.allowProfiles;
  if (allowedProfiles.length > 0) {
    if (pathValue !== "/profiles") {
      const profileToCheck = requestedProfile || resolved.defaultProfile;
      if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: profileToCheck })) {
        throw new Error("INVALID_REQUEST: browser profile not allowed");
      }
    } else if (requestedProfile) {
      if (!isProfileAllowed({ allowProfiles: allowedProfiles, profile: requestedProfile })) {
        throw new Error("INVALID_REQUEST: browser profile not allowed");
      }
    }
  }

  const method = typeof params.method === "string" ? params.method.toUpperCase() : "GET";
  const path = pathValue.startsWith("/") ? pathValue : `/${pathValue}`;
  const body = params.body;
  const timeoutMs = resolveBrowserProxyTimeout(params.timeoutMs);
  const query: Record<string, unknown> = {};
  if (requestedProfile) {
    query.profile = requestedProfile;
  }
  const rawQuery = params.query ?? {};
  for (const [key, value] of Object.entries(rawQuery)) {
    if (value === undefined || value === null) {
      continue;
    }
    query[key] = typeof value === "string" ? value : String(value);
  }

  const useBrowserCluster =
    shouldUseBrowserCluster() && canProxyBrowserClusterPath(path, method, body);

  if (useBrowserCluster) {
    try {
      const health = await browserClusterHealth();
      if (health.ok) {
        const result = await proxyBrowserCluster({
          method,
          path,
          body,
          profile: requestedProfile || resolved.defaultProfile,
        });
        const payload: BrowserProxyResult = { result };
        return JSON.stringify(payload);
      }
    } catch {
      // Fall back to internal browser transport when browser-cluster is unavailable.
    }
  }

  await ensureBrowserControlService();
  const dispatcher = createBrowserRouteDispatcher(createBrowserControlContext());
  let response;
  try {
    response = await withTimeout(
      (signal) =>
        dispatcher.dispatch({
          method: method === "DELETE" ? "DELETE" : method === "POST" ? "POST" : "GET",
          path,
          query,
          body,
          signal,
        }),
      timeoutMs,
      "browser proxy request",
    );
  } catch (err) {
    if (!isBrowserProxyTimeoutError(err)) {
      throw err;
    }
    const profileForStatus = requestedProfile || resolved.defaultProfile;
    const status = await readBrowserProxyStatus({
      dispatcher,
      profile: path === "/profiles" ? undefined : profileForStatus,
    });
    throw new Error(
      formatBrowserProxyTimeoutMessage({
        method,
        path,
        profile: path === "/profiles" ? undefined : profileForStatus || undefined,
        timeoutMs,
        wsBacked: isWsBackedBrowserProxyPath(path),
        status,
      }),
      { cause: err },
    );
  }
  if (response.status >= 400) {
    const message =
      response.body && typeof response.body === "object" && "error" in response.body
        ? String((response.body as { error?: unknown }).error)
        : `HTTP ${response.status}`;
    throw new Error(message);
  }

  const result = response.body;
  if (allowedProfiles.length > 0 && path === "/profiles") {
    const obj =
      typeof result === "object" && result !== null ? (result as Record<string, unknown>) : {};
    const profiles = Array.isArray(obj.profiles) ? obj.profiles : [];
    obj.profiles = profiles.filter((entry) => {
      if (!entry || typeof entry !== "object") {
        return false;
      }
      const name = (entry as Record<string, unknown>).name;
      return typeof name === "string" && allowedProfiles.includes(name);
    });
  }

  let files: BrowserProxyFile[] | undefined;
  const paths = collectBrowserProxyPaths(result);
  if (paths.length > 0) {
    const loaded = await Promise.all(
      paths.map(async (p) => {
        try {
          const file = await readBrowserProxyFile(p);
          if (!file) {
            throw new Error("file not found");
          }
          return file;
        } catch (err) {
          throw new Error(`browser proxy file read failed for ${p}: ${String(err)}`, {
            cause: err,
          });
        }
      }),
    );
    if (loaded.length > 0) {
      files = loaded;
    }
  }

  const payload: BrowserProxyResult = files ? { result, files } : { result };
  return JSON.stringify(payload);
}
