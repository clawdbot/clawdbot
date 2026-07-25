import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { detectMime } from "@openclaw/media-core/mime";
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import {
  type AgentAvatarResolution,
  resolvePublicAgentAvatarSource,
} from "../agents/identity-avatar.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { matchRootFileOpenFailure, openRootFileSync } from "../infra/boundary-file-read.js";
import { readFileDescriptorBounded } from "../infra/boundary-file-read.js";
import {
  isPackageProvenControlUiRootSync,
  resolveControlUiRootSync,
} from "../infra/control-ui-assets.js";
import { resolveDevInstallGitBranch } from "../infra/dev-install-branch.js";
import { listDevicePairing, verifyDeviceToken } from "../infra/device-pairing.js";
import { openLocalFileSafely, FsSafeError } from "../infra/fs-safe.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { verifyPairingToken } from "../infra/pairing-token.js";
import { isWithinDir } from "../infra/path-safety.js";
import { assertLocalMediaAllowed, getDefaultLocalRoots } from "../media/local-media-access.js";
import { getAgentScopedMediaLocalRoots } from "../media/local-roots.js";
import {
  resolveMediaReferenceLocalPath,
  resolveMediaReferenceLocalPathInfo,
} from "../media/media-reference.js";
import { extractOriginalFilename } from "../media/store.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceVersion } from "../version.js";
import { openGatewayAssistantAvatar, resolveGatewayAssistantAvatar } from "./assistant-avatar.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  AUTH_RATE_LIMIT_SCOPE_DEVICE_TOKEN,
  AUTH_RATE_LIMIT_SCOPE_SHARED_SECRET,
  type AuthRateLimiter,
} from "./auth-rate-limit.js";
import { authorizeHttpGatewayConnect, type ResolvedGatewayAuth } from "./auth.js";
import {
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  type ControlUiBootstrapConfig,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { classifyControlUiRequest, isControlUiApprovalDocumentPath } from "./control-ui-routing.js";
import {
  buildControlUiAvatarUrl,
  CONTROL_UI_AVATAR_PREFIX,
  normalizeControlUiBasePath,
} from "./control-ui-shared.js";
import {
  isControlUiPrecompressedAssetExtension,
  isControlUiStaticAssetExtension,
  readAndCloseControlUiFile,
  readAndCloseControlUiFileText,
  resolveControlUiHtmlEncoding,
  resolveOpenedControlUiRepresentation,
  respondControlUiNotAcceptable,
  respondHeadForControlUiFile,
  sendControlUiHtmlBody,
  serveControlUiAsset,
} from "./control-ui-static.js";
import { buildMissingScopeForbiddenBody, sendGatewayAuthFailure } from "./http-common.js";
import {
  getBearerToken,
  resolveHttpBrowserOriginPolicy,
  resolveTrustedHttpOperatorScopes,
  setControlUiPluginAuthCookieForRequest as setPluginAuthCookie,
} from "./http-utils.js";
import { authorizeOperatorScopesForMethod } from "./method-scopes.js";
import { resolveRequestClientIp } from "./net.js";
import { resolveSharedGatewaySessionGeneration } from "./server/ws-shared-generation.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSISTANT_MEDIA_PREFIX = "/__openclaw__/assistant-media";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE = "assistant-media";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
const CONTROL_UI_OPERATOR_READ_SCOPE = "operator.read";
const CONTROL_UI_OPERATOR_ROLE = "operator";
const controlUiAssistantMediaTicketSecret = randomBytes(32);

type ControlUiRequestOptions = {
  basePath?: string;
  config?: OpenClawConfig;
  terminalEnabled?: boolean;
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

const CONTROL_UI_NAMESPACE_PREFIX = "/__openclaw__/";
const CONTROL_UI_ROOT_PUBLIC_ASSETS = new Set([
  "apple-touch-icon.png",
  "favicon-32.png",
  "favicon.ico",
  "favicon.svg",
  "manifest.webmanifest",
  "sw.js",
]);

/** Rewrites root-absolute Control UI public asset hrefs for configured base paths. */
function rewriteControlUiIndexHtmlPublicAssetHrefs(html: string, basePath: string): string {
  const normalized = normalizeControlUiBasePath(basePath);
  if (!normalized) {
    return html;
  }
  let next = html;
  for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
    const rootHref = `href="/${asset}"`;
    const baseHref = `href="${normalized}/${asset}"`;
    next = next.split(rootHref).join(baseHref);
  }
  return next;
}

function escapeHtmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("'", "&#39;");
}

type ControlUiAvatarMeta = {
  avatarUrl: string | null;
  avatarSource: string | null;
  avatarStatus: AgentAvatarResolution["kind"] | null;
  avatarReason: string | null;
};

function controlUiAvatarResolutionMeta(resolved: AgentAvatarResolution | null): {
  avatarSource: string | null;
  avatarStatus: AgentAvatarResolution["kind"] | null;
  avatarReason: string | null;
} {
  if (!resolved) {
    return { avatarSource: null, avatarStatus: null, avatarReason: null };
  }
  return {
    avatarSource: resolvePublicAgentAvatarSource(resolved) ?? null,
    avatarStatus: resolved.kind,
    avatarReason: resolved.kind === "none" ? resolved.reason : null,
  };
}

function applyControlUiSecurityHeaders(res: ServerResponse) {
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Content-Security-Policy", buildControlUiCspHeader());
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  // Browser Talk is owned by this same-origin Control UI document. Keep camera
  // access here; the Gateway's default policy continues to deny it elsewhere.
  res.setHeader(
    "Permissions-Policy",
    "camera=(self), microphone=*, geolocation=*, clipboard-write=*",
  );
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
    requiredOperatorMethod?: string;
    onPluginFrameGrants?: (grants: readonly ControlUiPluginFrameGrantAck[]) => void;
  },
): Promise<boolean> {
  if (!opts?.auth) {
    opts?.onPluginFrameGrants?.([]);
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
  const sharedAuthGeneration = resolveSharedGatewaySessionGeneration(
    opts.auth,
    opts.trustedProxies,
  );
  let resolvedAuthResult = authResult;
  let verifiedDeviceScopes: string[] | undefined;
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
      const deviceTokenOk = await authorizeControlUiDeviceReadToken(token, sharedAuthGeneration);
      const deviceScopes = deviceTokenOk
        ? await resolveControlUiDeviceReadTokenScopes(token)
        : null;
      if (deviceScopes) {
        verifiedDeviceScopes = deviceScopes;
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

  const authMethod = resolvedAuthResult.method;
  const trustDeclaredOperatorScopes = authMethod === "trusted-proxy" || authMethod === "tailscale";
  if (opts.onPluginFrameGrants) {
    opts.onPluginFrameGrants(
      setPluginAuthCookie(
        req,
        res,
        authMethod,
        trustDeclaredOperatorScopes,
        sharedAuthGeneration,
        verifiedDeviceScopes,
      ),
    );
  }
  if (!trustDeclaredOperatorScopes) {
    return true;
  }

  const requestedScopes = resolveTrustedHttpOperatorScopes(req, {
    trustDeclaredOperatorScopes,
  });
  const scopeAuth = authorizeOperatorScopesForMethod(
    opts.requiredOperatorMethod ?? "assistant.media.get",
    requestedScopes,
  );
  if (!scopeAuth.allowed) {
    sendJson(res, 403, buildMissingScopeForbiddenBody(scopeAuth.missingScope));
    return false;
  }

  return true;
}

async function authorizeControlUiDeviceReadToken(
  token: string,
  requiredSharedGatewaySessionGeneration: string | undefined,
): Promise<boolean> {
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
      requiredSharedGatewaySessionGeneration,
    });
    if (verified.ok) {
      return true;
    }
  }
  return false;
}

async function resolveControlUiDeviceReadTokenScopes(token: string): Promise<string[] | null> {
  const pairing = await listDevicePairing();
  for (const device of pairing.paired) {
    const operatorBearer = device.tokens?.[CONTROL_UI_OPERATOR_ROLE];
    if (
      operatorBearer &&
      !operatorBearer.revokedAtMs &&
      verifyPairingToken(token, operatorBearer.token)
    ) {
      return operatorBearer.scopes;
    }
  }
  return null;
}

type AssistantMediaAvailability =
  | { available: true }
  | { available: false; reason: string; code: string };

type AssistantMediaTicketPayload = {
  scope: typeof CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE;
  source: string;
  exp: number;
};

function signAssistantMediaTicketPayload(encodedPayload: string): string {
  return createHmac("sha256", controlUiAssistantMediaTicketSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function createAssistantMediaTicket(source: string, nowMs = Date.now()) {
  const now = asDateTimestampMs(nowMs);
  if (now === undefined) {
    return {};
  }
  const exp = asDateTimestampMs(now + CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS);
  if (exp === undefined) {
    return {};
  }
  const payload: AssistantMediaTicketPayload = {
    scope: CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE,
    source,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signAssistantMediaTicketPayload(encodedPayload);
  return {
    mediaTicket: `v1.${encodedPayload}.${sig}`,
    mediaTicketExpiresAt: resolveTimestampMsToIsoString(exp),
  };
}

function verifyAssistantMediaTicket(ticket: string | null, source: string, nowMs = Date.now()) {
  const now = asDateTimestampMs(nowMs);
  if (now === undefined) {
    return false;
  }
  const parts = ticket?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return false;
  }
  const [, encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) {
    return false;
  }
  const expectedSig = signAssistantMediaTicketPayload(encodedPayload);
  if (!safeEqualSecret(sig, expectedSig)) {
    return false;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<AssistantMediaTicketPayload>;
    return (
      payload.scope === CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE &&
      payload.source === source &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp) &&
      payload.exp >= now
    );
  } catch {
    return false;
  }
}

function classifyAssistantMediaError(err: unknown): AssistantMediaAvailability {
  if (err instanceof FsSafeError) {
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
    const localPath = await resolveMediaReferenceLocalPath(source);
    await assertLocalMediaAllowed(localPath, localRoots);
    const opened = await openLocalFileSafely({ filePath: localPath });
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
  const source = normalizeAssistantMediaSource(url.searchParams.get("source") ?? "");
  if (!source) {
    respondControlUiNotFound(res);
    return true;
  }
  const isMetaRequest = url.searchParams.get("meta") === "1";
  const hasValidMediaTicket =
    !isMetaRequest && verifyAssistantMediaTicket(url.searchParams.get("mediaTicket"), source);
  if (
    !hasValidMediaTicket &&
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
  const localRoots = opts?.config
    ? getAgentScopedMediaLocalRoots(opts.config, opts.agentId)
    : getDefaultLocalRoots();

  if (isMetaRequest) {
    const availability = await resolveAssistantMediaAvailability(source, localRoots);
    sendJson(
      res,
      200,
      availability.available
        ? { ...availability, ...createAssistantMediaTicket(source) }
        : availability,
    );
    return true;
  }

  let opened: Awaited<ReturnType<typeof openLocalFileSafely>> | null = null;
  let localPath;
  let handleClosed = false;
  const closeOpenedHandle = async () => {
    if (!opened || handleClosed) {
      return;
    }
    handleClosed = true;
    await opened.handle.close().catch(() => {});
  };
  try {
    const resolvedReference = await resolveMediaReferenceLocalPathInfo(source);
    localPath = resolvedReference.path;
    await assertLocalMediaAllowed(localPath, localRoots);
    opened = await openLocalFileSafely({ filePath: localPath });
    const sniffLength = Math.min(opened.stat.size, 8192);
    const sniffBuffer = sniffLength > 0 ? Buffer.allocUnsafe(sniffLength) : undefined;
    const bytesRead =
      sniffBuffer && sniffLength > 0
        ? (await opened.handle.read(sniffBuffer, 0, sniffLength, 0)).bytesRead
        : 0;
    const mime = await detectMime({
      buffer: sniffBuffer?.subarray(0, bytesRead),
      filePath: localPath,
    });
    const contentType = mime ?? "application/octet-stream";
    const filename =
      resolvedReference.kind === "inbound"
        ? extractOriginalFilename(localPath)
        : path.basename(localPath);
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      buildAssistantMediaContentDisposition(filename, contentType),
    );
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
    config: OpenClawConfig;
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
  const agentIdParts = pathname.slice(pathWithBase.length).split("/").filter(Boolean);
  const agentId = agentIdParts[0] ?? "";
  if (agentIdParts.length !== 1 || !agentId || !isValidAgentId(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

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

  const identity = resolveAssistantIdentity({ cfg: opts.config, agentId });
  const projection = openGatewayAssistantAvatar({ cfg: opts.config, identity });
  const resolved = projection.resolution;

  if (url.searchParams.get("meta") === "1") {
    try {
      const meta = controlUiAvatarResolutionMeta(resolved);
      const avatarUrl =
        resolved?.kind === "local"
          ? buildControlUiAvatarUrl(basePath, agentId)
          : resolved?.kind === "remote" || resolved?.kind === "data"
            ? resolved.url
            : null;
      sendJson(res, 200, {
        avatarUrl,
        avatarSource: meta.avatarSource,
        avatarStatus: meta.avatarStatus,
        avatarReason: meta.avatarReason,
      } satisfies ControlUiAvatarMeta);
    } finally {
      if (projection.openedFile) {
        fs.closeSync(projection.openedFile.fd);
      }
    }
    return true;
  }

  if (resolved?.kind !== "local" || !projection.openedFile) {
    respondControlUiNotFound(res);
    return true;
  }

  try {
    res.setHeader("Content-Type", resolveAvatarMime(projection.openedFile.path));
    res.setHeader("Cache-Control", "no-cache");
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.end();
      return true;
    }
    const body = await readFileDescriptorBounded(projection.openedFile.fd, AVATAR_MAX_BYTES);
    res.end(body);
    return true;
  } catch {
    respondControlUiNotFound(res);
    return true;
  } finally {
    fs.closeSync(projection.openedFile.fd);
  }
}

async function serveResolvedIndexHtml(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  basePath?: string,
  allowWasm?: boolean,
) {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const withBasePath = rewriteControlUiIndexHtmlPublicAssetHrefs(body, normalizedBasePath);
  const basePathAttribute = normalizedBasePath
    ? ` ${CONTROL_UI_BASE_PATH_ATTRIBUTE}="${escapeHtmlAttribute(normalizedBasePath)}"`
    : "";
  // Let the app initialize fail-closed without guessing whether this document
  // was served with the terminal's WASM CSP allowance.
  const prepared = withBasePath.replace(
    /<html\b/i,
    `<html${basePathAttribute} ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="${allowWasm === true}"`,
  );
  const hashes = computeInlineScriptHashes(prepared);
  // Always set the document CSP here (the index carries inline scripts) so the
  // terminal's WASM relaxation is applied to the page that loads ghostty-web.
  res.setHeader(
    "Content-Security-Policy",
    buildControlUiCspHeader({ inlineScriptHashes: hashes, allowWasm }),
  );
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache");
  await sendControlUiHtmlBody(req, res, prepared);
}

function isExpectedSafePathError(error: unknown): boolean {
  const code =
    typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
  return code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP";
}

function resolveSafeControlUiFile(
  rootReal: string,
  filePath: string,
  rejectHardlinks: boolean,
): { path: string; fd: number } | null {
  const opened = openRootFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    rejectHardlinks,
  });
  if (!opened.ok) {
    return matchRootFileOpenFailure(opened, {
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

// Path served by the gateway under the default Control UI namespace when no
// `gateway.controlUi.basePath` is configured. The SPA is mounted at
// `/__openclaw__/`, so a browser that opens the default entry infers
// `/__openclaw__` as its base path (see `inferBasePathFromPathname`) and fetches
// `/__openclaw__/control-ui-config.json`. Accept that namespaced alias so the
// default entry resolves its bootstrap config instead of 404ing.
const CONTROL_UI_DEFAULT_NAMESPACE_BOOTSTRAP_CONFIG_PATH = `${CONTROL_UI_NAMESPACE_PREFIX.replace(
  /\/$/,
  "",
)}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;

// Single-underscore `/__openclaw` prefix used by the pre-base-path-relative
// bootstrap endpoint. Before #66946 made the config path base-path-relative,
// `CONTROL_UI_BOOTSTRAP_CONFIG_PATH` was hard-coded to
// `/__openclaw/control-ui-config.json`, so current main and the v2026.6.1
// release serve and document that exact path under an empty base path.
const LEGACY_CONTROL_UI_NAMESPACE_PREFIX = "/__openclaw";

// The old documented no-base-path bootstrap endpoint
// (`/__openclaw/control-ui-config.json`, single underscore). It is derived from
// the legacy `/__openclaw` namespace joined with the canonical config constant
// so it tracks any rename of the config filename. Kept as an empty-base-path
// compatibility alias so older bundles and clients that fetch the previously
// documented endpoint keep receiving config after upgrading instead of 404ing.
const LEGACY_BOOTSTRAP_CONFIG_PATH = `${LEGACY_CONTROL_UI_NAMESPACE_PREFIX}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}`;

/**
 * Whether `pathname` should be served the Control UI bootstrap config payload.
 *
 * The canonical endpoint is the configured base path joined with the shared
 * bootstrap constant (or the bare constant when no base path is configured).
 * For every base path (configured or empty) we additionally accept the legacy
 * single-underscore suffix `${basePath}/__openclaw/control-ui-config.json` that
 * current main and v2026.6.1 serve and document, so older bundles and clients
 * that still request the pre-#66946 endpoint keep receiving config after an
 * upgrade instead of 404ing. When no base path is configured we further accept
 * the default-namespace alias `/__openclaw__/control-ui-config.json`, which is
 * what the default `/__openclaw__/` entry requests after inferring its base path
 * from the URL. All compatibility endpoints are preserved; no path is removed.
 */
function matchesControlUiBootstrapConfigPath(pathname: string, basePath: string): boolean {
  // Canonical and legacy suffixes apply under both an empty and a configured
  // base path. `LEGACY_BOOTSTRAP_CONFIG_PATH` already starts with the legacy
  // `/__openclaw` namespace, so joining it with the base path yields
  // `${basePath}/__openclaw/control-ui-config.json` (or the bare legacy path
  // when no base path is configured).
  if (
    pathname === `${basePath}${CONTROL_UI_BOOTSTRAP_CONFIG_PATH}` ||
    pathname === `${basePath}${LEGACY_BOOTSTRAP_CONFIG_PATH}`
  ) {
    return true;
  }
  // The default `/__openclaw__/` namespace alias only applies when no base path
  // is configured; with a configured base path the canonical endpoint already
  // lives under that base path and this inferred alias does not apply.
  return basePath === "" && pathname === CONTROL_UI_DEFAULT_NAMESPACE_BOOTSTRAP_CONFIG_PATH;
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
  // The embedded terminal ships ghostty-web (WASM); relax the index CSP only
  // for an explicitly enabled terminal so the default policy stays strict.
  const terminalEnabled =
    opts?.terminalEnabled ?? opts?.config?.gateway?.terminal?.enabled === true;
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

  if (matchesControlUiBootstrapConfigPath(pathname, basePath)) {
    let pluginFrameGrants: readonly ControlUiPluginFrameGrantAck[] = [];
    if (
      !(await authorizeControlUiReadRequest(req, res, {
        auth: opts?.auth,
        trustedProxies: opts?.trustedProxies,
        allowRealIpFallback: opts?.allowRealIpFallback,
        rateLimiter: opts?.rateLimiter,
        onPluginFrameGrants: (grants) => {
          pluginFrameGrants = grants;
        },
      }))
    ) {
      return true;
    }
    if (req.method === "HEAD") {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache");
      res.end();
      return true;
    }
    const config = opts?.config;
    const identity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : DEFAULT_ASSISTANT_IDENTITY;
    const avatarProjection = config
      ? resolveGatewayAssistantAvatar({ cfg: config, identity })
      : { avatar: identity.avatar, resolution: null };
    const avatarMeta = controlUiAvatarResolutionMeta(avatarProjection.resolution);
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarProjection.avatar,
      assistantAvatarSource: avatarMeta.avatarSource,
      assistantAvatarStatus: avatarMeta.avatarStatus,
      assistantAvatarReason: avatarMeta.avatarReason,
      assistantAgentId: identity.agentId,
      serverVersion: resolveRuntimeServiceVersion(process.env),
      devGitBranch: (await resolveDevInstallGitBranch()) ?? undefined,
      localMediaPreviewRoots: [...getAgentScopedMediaLocalRoots(config ?? {}, identity.agentId)],
      embedSandbox:
        config?.gateway?.controlUi?.embedSandbox === "trusted"
          ? "trusted"
          : config?.gateway?.controlUi?.embedSandbox === "strict"
            ? "strict"
            : "scripts",
      allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
      seamColor: config?.ui?.seamColor,
      timeFormat: "auto",
      terminalEnabled,
      pluginFrameGrants: pluginFrameGrants.map(({ pluginId, path: grantPath, match }) => ({
        pluginId,
        path: grantPath,
        match,
      })),
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
  const approvalDocument = isControlUiApprovalDocumentPath({ basePath, pathname });
  const rel = (() => {
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    if (uiPath.startsWith(CONTROL_UI_NAMESPACE_PREFIX)) {
      const namespacedRel = uiPath.slice(CONTROL_UI_NAMESPACE_PREFIX.length);
      if (CONTROL_UI_ROOT_PUBLIC_ASSETS.has(namespacedRel)) {
        return namespacedRel;
      }
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = approvalDocument
    ? "index.html"
    : rel && !rel.endsWith("/")
      ? rel
      : `${rel}index.html`;
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
  // Bundled sidecars are implementation artifacts selected through
  // Accept-Encoding. Configured roots retain ordinary .br/.gz resources.
  if (
    isBundledRoot &&
    isControlUiPrecompressedAssetExtension(path.extname(fileRel).toLowerCase())
  ) {
    respondControlUiNotFound(res);
    return true;
  }
  const rejectHardlinks = !isBundledRoot;
  // Vite fingerprints every file emitted under the bundled assets directory.
  // Configured roots remain revalidated because their naming is not our contract.
  const immutableAsset = isBundledRoot && fileRel.startsWith("assets/");
  const safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (safeFile) {
    if (path.basename(safeFile.path) === "index.html") {
      if (req.method === "HEAD") {
        try {
          const encoding = resolveControlUiHtmlEncoding(req);
          if (encoding === "not-acceptable") {
            respondControlUiNotAcceptable(res);
            return true;
          }
          respondHeadForControlUiFile(res, safeFile.path, {
            encoding: encoding === "identity" ? undefined : encoding,
          });
          return true;
        } finally {
          fs.closeSync(safeFile.fd);
        }
      }
      const body = await readAndCloseControlUiFileText(safeFile.fd);
      await serveResolvedIndexHtml(req, res, body, basePath, terminalEnabled);
      return true;
    }
    const representation = resolveOpenedControlUiRepresentation({
      req,
      sourceFile: safeFile,
      precompressed: immutableAsset,
      openPrecompressedFile: (compressedPath) =>
        resolveSafeControlUiFile(rootReal, compressedPath, false),
    });
    if (!representation) {
      respondControlUiNotAcceptable(res);
      return true;
    }
    if (req.method === "HEAD") {
      try {
        respondHeadForControlUiFile(res, representation.contentPath, {
          immutable: immutableAsset,
          encoding: representation.encoding,
        });
        return true;
      } finally {
        fs.closeSync(representation.bodyFile.fd);
      }
    }
    const body = await readAndCloseControlUiFile(representation.bodyFile.fd);
    await serveControlUiAsset(res, representation.contentPath, body, {
      immutable: immutableAsset,
      encoding: representation.encoding,
    });
    return true;
  }

  // If the requested path looks like a static asset (known extension), return
  // 404 rather than falling through to the SPA index.html fallback.  We check
  // against the same extension set used by the static response helper so
  // that dotted SPA routes (e.g. /user/jane.doe, /v2.0) still get the
  // client-side router fallback.
  if (isControlUiStaticAssetExtension(path.extname(fileRel).toLowerCase())) {
    respondControlUiNotFound(res);
    return true;
  }

  // SPA fallback (client-side router): serve index.html for unknown paths.
  const indexPath = path.join(root, "index.html");
  const safeIndex = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
  if (safeIndex) {
    if (req.method === "HEAD") {
      try {
        const encoding = resolveControlUiHtmlEncoding(req);
        if (encoding === "not-acceptable") {
          respondControlUiNotAcceptable(res);
          return true;
        }
        respondHeadForControlUiFile(res, safeIndex.path, {
          encoding: encoding === "identity" ? undefined : encoding,
        });
        return true;
      } finally {
        fs.closeSync(safeIndex.fd);
      }
    }
    const body = await readAndCloseControlUiFileText(safeIndex.fd);
    await serveResolvedIndexHtml(req, res, body, basePath, terminalEnabled);
    return true;
  }

  respondControlUiNotFound(res);
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
