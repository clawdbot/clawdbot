import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchBoundaryFileOpenFailure, openBoundaryFileSync } from "../infra/boundary-file-read.js";
import {
  isPackageProvenControlUiRootSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { listDevicePairing, verifyDeviceToken } from "../infra/device-pairing.js";
import { openLocalFileSafely, SafeOpenError } from "../infra/fs-safe.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { isWithinDir } from "../infra/path-safety.js";
import { openVerifiedFileSync } from "../infra/safe-open-sync.js";
import { assertLocalMediaAllowed, getDefaultLocalRoots } from "../media/local-media-access.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import { detectMime } from "../media/mime.js";
import { AVATAR_MAX_BYTES } from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  type ControlUiBootstrapConfig,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { classifyControlUiRequest } from "./control-ui-routing.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
  resolveAssistantAvatarUrl,
} from "./control-ui-shared.js";
import { sendGatewayAuthFailure } from "./http-common.js";
import {
  getBearerToken,
  resolveHttpBrowserOriginPolicy,
  resolveTrustedHttpOperatorScopes,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveRequestClientIp } from "./net.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSISTANT_MEDIA_PREFIX = "/__openclaw__/assistant-media";
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";
const CONTROL_UI_OPERATOR_ROLE = "operator";

export type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  agentId?: string;
  root?: ControlUiRootState;
  auth?: ResolvedGatewayAuth;
  trustedProxies?: string[];
  allowRealIpFallback?: boolean;
  rateLimiter?: AuthRateLimiter;
};

export type ControlUiRootState =
  | { kind: "bundled"; path: string }
  | { kind: "resolved"; path: string }
  | { kind: "invalid"; path: string }
  | { kind: "missing" };

function contentTypeForExt(ext: string): string {
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
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

/**
 * Extensions recognised as static assets.  Missing files with these extensions
 * return 404 instead of the SPA index.html fallback.  `.html` is intentionally
 * excluded — actual HTML files on disk are served earlier, and missing `.html`
 * paths should fall through to the SPA router (client-side routers may use
 * `.html`-suffixed routes).
 */
const STATIC_ASSET_EXTENSIONS = new Set([
  ".js",
  ".css",
  ".json",
  ".map",
  ".svg",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".ico",
  ".txt",
]);

export type ControlUiAvatarResolution =
  | { kind: "none"; reason: string }
  | { kind: "local"; filePath: string }
  | { kind: "remote"; url: string }
  | { kind: "data"; url: string };

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
};

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(JSON.stringify(body));
}

function respondControlUiAssetsUnavailable(
  res: ServerResponse,
  options?: { configuredRootPath?: string },
) {
  if (options?.configuredRootPath) {
    respondPlainText(
      res,
      503,
      `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`,
    );
    return;
  }
  respondPlainText(res, 503, CONTROL_UI_ASSETS_MISSING_MESSAGE);
}

function respondHeadForFile(req: IncomingMessage, res: ServerResponse, filePath: string): boolean {
  if (req.method !== "HEAD") {
    return false;
  }
  res.statusCode = 200;
  setStaticFileHeaders(res, filePath);
  res.end();
  return true;
}

function isValidAgentId(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

function normalizeAssistantMediaSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (trimmed.startsWith("file://")) {
    try {
      return safeFileURLToPath(trimmed);
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return resolveUserPath(trimmed);
  }
  return trimmed;
}

function resolveAssistantMediaRoutePath(basePath?: string): string {
  const normalizedBasePath =
    basePath && basePath !== "/" ? (basePath.endsWith("/") ? basePath.slice(0, -1) : basePath) : "";
  return `${normalizedBasePath}${CONTROL_UI_ASSISTANT_MEDIA_PREFIX}`;
}

function resolveAssistantMediaAuthToken(req: IncomingMessage): string | undefined {
  const bearer = getBearerToken(req);
  if (bearer) {
    return bearer;
  }
  const urlRaw = req.url;
  if (!urlRaw) {
    return undefined;
  }
  try {
    const url = new URL(urlRaw, "http://localhost");
    const token = url.searchParams.get("token")?.trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

function resolveControlUiReadAuthToken(
  req: IncomingMessage,
  opts?: { allowQueryToken?: boolean },
): string | undefined {
  const bearer = getBearerToken(req);
  if (bearer) {
    return bearer;
  }
  if (!opts?.allowQueryToken) {
    return undefined;
  }
  return resolveAssistantMediaAuthToken(req);
}

async function authorizeControlUiReadRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: {
    auth?: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
    allowQueryToken?: boolean;
  },
): Promise<boolean> {
  if (!opts?.auth) {
    return true;
  }

  const token = resolveControlUiReadAuthToken(req, {
    allowQueryToken: opts.allowQueryToken,
  });
  const clientIp =
    resolveRequestClientIp(req, opts.trustedProxies, opts.allowRealIpFallback === true) ??
    req.socket?.remoteAddress;
  const authResult = await authorizeHttpGatewayConnect({
    auth: opts.auth,
    connectAuth: token ? { token, password: token } : null,
    req,
    browserOriginPolicy: resolveHttpBrowserOriginPolicy(req),
    trustedProxies: opts.trustedProxies,
    allowRealIpFallback: opts.allowRealIpFallback,
    rateLimiter: token ? opts.rateLimiter : undefined,
    clientIp,
    rateLimitScope: AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  });
  let resolvedAuthResult = authResult;
  if (
    !resolvedAuthResult.ok &&
    token &&
    opts.auth.mode !== "trusted-proxy" &&
    opts.auth.mode !== "none"
  ) {
    const deviceRateCheck = opts.rateLimiter?.check(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
    if (deviceRateCheck && !deviceRateCheck.allowed) {
      resolvedAuthResult = {
        ok: false,
        reason: "rate_limited",
        rateLimited: true,
        retryAfterMs: deviceRateCheck.retryAfterMs,
      };
    } else {
      const deviceTokenOk = await authorizeControlUiDeviceReadToken(token);
      if (deviceTokenOk) {
        opts.rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
        opts.rateLimiter?.reset(clientIp, AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET);
        resolvedAuthResult = { ok: true, method: "device-token" };
      } else {
        opts.rateLimiter?.recordFailure(clientIp, AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN);
      }
    }
  }
  if (!resolvedAuthResult.ok) {
    sendGatewayAuthFailure(res, resolvedAuthResult);
    return false;
  }

  const trustDeclaredOperatorScopes = resolvedAuthResult.method === "trusted-proxy";
  if (!trustDeclaredOperatorScopes) {
    return true;
  }

  const requestedScopes = resolveTrustedHttpOperatorScopes(req, {
    trustDeclaredOperatorScopes,
  });
  const scopeAuth = authorizeOperatorScopesForMethod("assistant.media.get", requestedScopes);
  if (!scopeAuth.allowed) {
    sendJson(res, 403, {
      ok: false,
      error: {
        type: "forbidden",
        message: `missing scope: ${scopeAuth.missingScope}`,
      },
    });
    return false;
  }

  return true;
}

async function authorizeControlUiDeviceReadToken(token: string): Promise<boolean> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorToken = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (!operatorToken || operatorToken.revokedAtMs) {
      continue;
    }
    if (!verifyPairingToken(token, operatorToken.token)) {
      continue;
    }
    const verified = await verifyDeviceToken({
      deviceId: device.deviceId,
      token,
      role: CONTROL_UI_OPERATOR_ROLE,
      scopes: [CONTROL_UI_OPERATOR_READ_SCOPE],
    });
    if (verified.ok) {
      return true;
    }
  }
  return false;
}

type AssistantMediaAvailability =
  | { available: true }
  | { available: false; reason: string; code: string };

function classifyAssistantMediaError(err: unknown): AssistantMediaAvailability {
  if (err instanceof SafeOpenError) {
    switch (err.code) {
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      case "invalid-path":
      case "path-mismatch":
      case "symlink":
        return { available: false, code: "invalid-file", reason: "Invalid file" };
      default:
        return {
          available: false,
          code: "attachment-unavailable",
          reason: "Attachment unavailable",
        };
    }
  }
  if (err instanceof Error && "code" in err) {
    const errorCode = (err as { code?: unknown }).code;
    switch (typeof errorCode === "string" ? errorCode : "") {
      case "path-not-allowed":
        return {
          available: false,
          code: "outside-allowed-folders",
          reason: "Outside allowed folders",
        };
      case "invalid-file-url":
      case "invalid-path":
      case "unsafe-bypass":
      case "network-path-not-allowed":
      case "invalid-root":
        return { available: false, code: "blocked-local-file", reason: "Blocked local file" };
      case "not-found":
        return { available: false, code: "file-not-found", reason: "File not found" };
      case "not-file":
        return { available: false, code: "not-a-file", reason: "Not a file" };
      default:
        break;
    }
  }
  return { available: false, code: "attachment-unavailable", reason: "Attachment unavailable" };
}

async function resolveAssistantMediaAvailability(
  source: string,
  localRoots: readonly string[],
): Promise<AssistantMediaAvailability> {
  try {
    await assertLocalMediaAllowed(source, localRoots);
    const opened = await openLocalFileSafely({ filePath: source });
    await opened.handle.close();
    return { available: true };
  } catch (err) {
    return classifyAssistantMediaError(err);
  }
}

export async function handleControlUiAssistantMediaRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: {
    basePath?: string;
    config?: OpenClawConfig;
    agentId?: string;
    auth?: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw || !isReadHttpMethod(req.method)) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  if (url.pathname !== resolveAssistantMediaRoutePath(opts?.basePath)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);
  if (
    !(await authorizeControlUiReadRequest(req, res, {
      auth: opts?.auth,
      trustedProxies: opts?.trustedProxies,
      allowRealIpFallback: opts?.allowRealIpFallback,
      rateLimiter: opts?.rateLimiter,
      allowQueryToken: true,
    }))
  ) {
    return true;
  }
  const source = normalizeAssistantMediaSource(url.searchParams.get("source") ?? "");
  if (!source) {
    respondControlUiNotFound(res);
    return true;
  }
  const localRoots = opts?.config
    ? getAgentScopedMediaLocalRoots(opts.config, opts.agentId)
    : getDefaultLocalRoots();

  if (url.searchParams.get("meta") === "1") {
    const availability = await resolveAssistantMediaAvailability(source, localRoots);
    sendJson(res, 200, availability);
    return true;
  }

  let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | null = null;
  let handleClosed = false;
  const closeOpenedHandle = async () => {
    if (!opened || handleClosed) {
      return;
    }
    handleClosed = true;
    await opened.handle.close().catch(() => {});
  };
  try {
    await assertLocalMediaAllowed(source, localRoots);
    opened = await openLocalFileSafely({ filePath: source });
    const sniffLength = Math.min(opened.stat.size, 8192);
    const sniffBuffer = sniffLength > 0 ? Buffer.allocUnsafe(sniffLength) : undefined;
    const bytesRead =
      sniffBuffer && sniffLength > 0
        ? (await opened.handle.read(sniffBuffer, 0, sniffLength, 0)).bytesRead
        : 0;
    const mime = await detectMime({
      buffer: sniffBuffer?.subarray(0, bytesRead),
      filePath: source,
    });
    if (mime) {
      res.setHeader("Content-Type", mime);
    } else {
      res.setHeader("Content-Type", "application/octet-stream");
    }
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Length", String(opened.stat.size));
    const stream = opened.handle.createReadStream({ start: 0, autoClose: false });
    const finishClose = () => {
      void closeOpenedHandle();
    };
    stream.once("end", finishClose);
    stream.once("close", finishClose);
    stream.once("error", () => {
      void closeOpenedHandle();
      if (!res.headersSent) {
        respondControlUiNotFound(res);
      } else {
        res.destroy();
      }
    });
    res.once("close", finishClose);
    stream.pipe(res);
    return true;
  } catch {
    await closeOpenedHandle();
    respondControlUiNotFound(res);
    return true;
  }
}

export async function handleControlUiAvatarRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts: {
    basePath?: string;
    resolveAvatar: (agentId: string) => ControlUiAvatarResolution;
    auth?: ResolvedGatewayAuth;
    trustedProxies?: string[];
    allowRealIpFallback?: boolean;
    rateLimiter?: AuthRateLimiter;
  },
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  if (!isReadHttpMethod(req.method)) {
    return false;
  }

  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts.basePath);
  const pathname = url.pathname;
  const pathWithBase = basePath
    ? `${basePath}${CONTROL_UI_AVATAR_PREFIX}/`
    : `${CONTROL_UI_AVATAR_PREFIX}/`;
  if (!pathname.startsWith(pathWithBase)) {
    return false;
  }

  applyControlUiSecurityHeaders(res);
  if (
    !(await authorizeControlUiReadRequest(req, res, {
      auth: opts.auth,
      trustedProxies: opts.trustedProxies,
      allowRealIpFallback: opts.allowRealIpFallback,
      rateLimiter: opts.rateLimiter,
    }))
  ) {
    return true;
  }

  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  if (url.searchParams.get("meta") === "1") {
    const resolved = opts.resolveAvatar(agentId);
    const avatarUrl =
      resolved.kind === "local"
        ? buildControlUiAvatarUrl(basePath, agentId)
        : resolved.kind === "remote" || resolved.kind === "data"
          ? resolved.url
          : null;
    sendJson(res, 200, { avatarUrl } satisfies ControlUiAvatarMeta);
    return true;
  }

  const resolved = opts.resolveAvatar(agentId);
  if (resolved.kind !== "local") {
    respondControlUiNotFound(res);
    return true;
  }

  const safeAvatar = resolveSafeAvatarFile(resolved.filePath);
  if (!safeAvatar) {
    respondControlUiNotFound(res);
    return true;
  }
  try {
    if (respondHeadForFile(req, res, safeAvatar.path)) {
      return true;
    }

    serveResolvedFile(res, safeAvatar.path, fs.readFileSync(safeAvatar.fd));
    return true;
  } finally {
    fs.closeSync(safeAvatar.fd);
  }
}

function setStaticFileHeaders(res: ServerResponse, filePath: string) {
  const ext = path.extname(filePath).toLowerCase();
  res.setHeader("Content-Type", contentTypeForExt(ext));
  // Static UI should never be cached aggressively while iterating; allow the
  // browser to revalidate.
  res.setHeader("Cache-Control", "no-cache");
}

function serveResolvedFile(res: ServerResponse, filePath: string, body: Buffer) {
  setStaticFileHeaders(res, filePath);
  res.end(body);
}

function serveResolvedIndexHtml(res: ServerResponse, body: string) {
  const hashes = computeInlineScriptHashes(body);
  if (hashes.length > 0) {
    res.setHeader(
      "Content-Security-Policy",
      buildControlUiCspHeader({ inlineScriptHashes: hashes }),
    );
  }
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  res.end(body);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function resolveSafeAvatarFile(filePath: string): { path: string; fd: number } | null {
  const opened = openVerifiedFileSync({
    filePath,
    rejectPathSymlink: true,
    maxBytes: AVATAR_MAX_BYTES,
  });
  if (!opened.ok) {
    return null;
  }
  return { path: opened.path, fd: opened.fd };
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
  rejectHardlinks: boolean,
): { path: string; fd: number } | null {
  const opened = openBoundaryFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    rejectHardlinks,
  });
  if (!opened.ok) {
    return matchBoundaryFileOpenFailure(opened, {
      io: (failure) => {
        throw failure.error;
      },
      fallback: () => null,
    });
  }
  return { path: opened.path, fd: opened.fd };
}

function isSafeRelativePath(relPath: string) {
  if (!relPath) {
    return false;
  }
  const normalized = path.posix.normalize(relPath);
  if (path.posix.isAbsolute(normalized) || path.win32.isAbsolute(normalized)) {
    return false;
  }
  if (normalized.startsWith("../") || normalized === "..") {
    return false;
  }
  if (normalized.includes("\0")) {
    return false;
  }
  return true;
}

export async function handleControlUiHttpRequest(
  req: IncomingMessage,
  res: ServerResponse,
  opts?: ControlUiRequestOptions,
): Promise<boolean> {
  const urlRaw = req.url;
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  const basePath = normalizeControlUiBasePath(opts?.basePath);
  const pathname = url.pathname;
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
  });
  if (route.kind === "not-control-ui") {
    return false;
  }
  if (route.kind === "not-found") {
    applyControlUiSecurityHeaders(res);
    respondControlUiNotFound(res);
    return true;
  }
  if (route.kind === "redirect") {
    applyControlUiSecurityHeaders(res);
    res.statusCode = 302;
    res.setHeader("Location", route.location);
    res.end();
    return true;
  }

  applyControlUiSecurityHeaders(res);

  const bootstrapConfigPath = basePath
    ? `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`
    : CONTROL_UI_BOOTSTRAP_CONFIG_PATH;
  if (pathname === bootstrapConfigPath) {
    if (
      !(await authorizeControlUiReadRequest(req, res, {
        auth: opts?.auth,
        trustedProxies: opts?.trustedProxies,
        allowRealIpFallback: opts?.allowRealIpFallback,
        rateLimiter: opts?.rateLimiter,
      }))
    ) {
      return true;
    }
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarValue = resolveAssistantAvatarUrl({
      avatar: identity.avatar,
      agentId: identity.agentId,
      basePath,
    });
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarValue ?? identity.avatar,
      assistantAgentId: identity.agentId,
      serverVersion: resolveRuntimeServiceVersion(process.env),
      localMediaPreviewRoots: [...getAgentScopedMediaLocalRoots(config ?? {}, identity.agentId)],
      embedSandbox:
        config?.gateway?.controlUi?.embedSandbox === "trusted"
          ? "trusted"
          : config?.gateway?.controlUi?.embedSandbox === "strict"
            ? "strict"
            : "scripts",
      allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
    } satisfies ControlUiBootstrapConfig);
    return true;
  }

  const rootState = opts?.root;
  if (rootState?.kind === "invalid") {
    respondControlUiAssetsUnavailable(res, { configuredRootPath: rootState.path });
    return true;
  }
  if (rootState?.kind === "missing") {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const root =
    rootState?.kind === "resolved" || rootState?.kind === "bundled"
      ? rootState.path
      : resolveControlUiRootSync({
          moduleUrl: import.meta.url,
          argv1: process.argv[1],
          cwd: process.cwd(),
        });
  if (!root) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const rootReal = (() => {
    try {
      return fs.realpathSync(root);
    } catch (error) {
      if (isExpectedSafePathError(error)) {
        return null;
      }
      throw error;
    }
  })();
  if (!rootReal) {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const uiPath =
    basePath && pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : pathname;
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = rel && !rel.endsWith("/") ? rel : `${rel}index.html`;
  const fileRel = requested || "index.html";
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }

  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot =
    rootState?.kind === "bundled" ||
    (rootState === undefined &&
      isPackageProvenControlUiRootSync(root, {
        moduleUrl: import.meta.url,
        argv1: process.argv[1],
        cwd: process.cwd(),
      }));
  const rejectHardlinks = !isBundledRoot;
  const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (safeFile) {
    try {
      if (respondHeadForFile(req, res, safeFile.path)) {
        return true;
      }
      if (path.basename(safeFile.path) === "index.html") {
        serveResolvedIndexHtml(res, fs.readFileSync(safeFile.fd, "utf8"));
        return true;
      }
      serveResolvedFile(res, safeFile.path, fs.readFileSync(safeFile.fd));
      return true;
    } finally {
      fs.closeSync(safeFile.fd);
    }
  }

  // If the requested path looks like a static asset (known extension), return
  // 404 rather than falling through to the SPA index.html fallback.  We check
  // against the same set of extensions that contentTypeForExt() recognises so
  // that dotted SPA routes (e.g. /user/jane.doe, /v2.0) still get the
  // client-side router fallback.
  if (STATIC_ASSET_EXTENSIONS.has(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  const safeIndex = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
  if (safeIndex) {
    try {
      if (respondHeadForFile(req, res, safeIndex.path)) {
        return true;
      }
      serveResolvedIndexHtml(res, fs.readFileSync(safeIndex.fd, "utf8"));
      return true;
    } finally {
      fs.closeSync(safeIndex.fd);
    }
  }

  respondControlUiNotFound(res);
  return true;
}
