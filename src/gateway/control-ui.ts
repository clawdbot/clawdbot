import { createHmac, randomBytes } from "node:crypto";
import fs from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { detectMime, kindFromMime } from "@openclaw/media-core/mime";
import {
  asDateTimestampMs,
  resolveTimestampMsToIsoString,
} from "@openclaw/normalization-core/number-coercion";
import {
  type AgentAvatarResolution,
  resolvePublicAgentAvatarSource,
} from "../agents/identity-avatar.js";
import { resolveGatewayPublicOrigin } from "../config/gateway-public-origin.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  matchRootFileOpenFailure,
  openRootFileSync,
  readFileDescriptorBounded,
} from "../infra/boundary-file-read.js";
import { resolveDevInstallGitBranch } from "../infra/dev-install-branch.js";
import { readFileWindowFully } from "../infra/file-read.js";
import { openLocalFileSafely, FsSafeError } from "../infra/fs-safe.js";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { isWithinDir } from "../infra/path-safety.js";
import { assertLocalMediaAllowed, LocalMediaAccessError } from "../media/local-media-access.js";
import {
  probePlaybackMediaFileDescriptor,
  toMediaProbeResult,
  type MediaProbeResult,
} from "../media/media-probe.js";
import { resolveMediaReferenceLocalPathInfo } from "../media/media-reference.js";
import {
  replacePlaybackFileExtension,
  resolvePlaybackModeForSource,
  resolvePlaybackTranscode,
} from "../media/playback-transcode.js";
import { extractOriginalFilename } from "../media/store.js";
import { safeEqualSecret } from "../security/secret-equal.js";
import { AVATAR_MAX_BYTES, resolveAvatarMime } from "../shared/avatar-policy.js";
import { escapeHtml } from "../shared/html-escape.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { resolveUserPath } from "../utils.js";
import { resolveRuntimeServiceBuildId, resolveRuntimeServiceVersion } from "../version.js";
import { gatewayAvatarImageRevision } from "./assistant-avatar-cache.js";
import {
  gatewayAssistantAvatarUrl,
  openGatewayAssistantAvatar,
  resolveGatewayAssistantAvatar,
} from "./assistant-avatar.js";
import { DEFAULT_ASSISTANT_IDENTITY, resolveAssistantIdentity } from "./assistant-identity.js";
import { buildAssistantMediaContentDisposition } from "./assistant-media-content-disposition.js";
import {
  resolveAssistantMediaPolicy,
  type AssistantMediaSession,
  type AssistantMediaReader,
} from "./assistant-media-policy.js";
import type { AuthRateLimiter } from "./auth-rate-limit.js";
import type { ResolvedGatewayAuth } from "./auth.js";
import type { ControlUiAssetRetention } from "./control-ui-asset-retention.js";
import {
  buildControlUiRootAssetPath,
  CONTROL_UI_BASE_PATH_ATTRIBUTE,
  CONTROL_UI_BOOTSTRAP_CONFIG_PATH,
  CONTROL_UI_BUILD_ID_ATTRIBUTE,
  CONTROL_UI_ENVIRONMENT_ATTRIBUTE,
  CONTROL_UI_ROOT_PUBLIC_ASSETS,
  CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE,
  isControlUiRootPublicAsset,
  isControlUiVersionedPublicAsset,
  parseControlUiResourcePath,
  type ControlUiBootstrapConfig,
  type ControlUiEnvironment,
  type ControlUiPluginFrameGrantAck,
} from "./control-ui-contract.js";
import { buildControlUiCspHeader, computeInlineScriptHashes } from "./control-ui-csp.js";
import {
  isReadHttpMethod,
  respondNotFound as respondControlUiNotFound,
  respondPlainText,
} from "./control-ui-http-utils.js";
import { resolveAssistantMediaRoutePath } from "./control-ui-resource-routes.js";
import {
  classifyControlUiRequest,
  isControlUiApprovalDocumentPath,
  isControlUiFocusDocumentPath,
} from "./control-ui-routing.js";
import { isControlUiSharePath, serveControlUiShareDocument } from "./control-ui-share.js";
import { normalizeControlUiBasePath } from "./control-ui-shared.js";
import {
  isControlUiFileUnmodified,
  isControlUiPrecompressedAssetExtension,
  isControlUiStaticAssetExtension,
  readAndCloseControlUiFile,
  resolveControlUiHtmlEncoding,
  resolveOpenedControlUiRepresentation,
  respondControlUiNotAcceptable,
  respondControlUiNotModified,
  respondHeadForControlUiFile,
  sendControlUiHtmlBody,
  serveControlUiAsset,
} from "./control-ui-static.js";
import {
  createGatewayByteStream,
  resolveByteResponse,
  writeByteHeaders,
} from "./http-byte-range.js";
import {
  applyHttpImageContentSecurityPolicy,
  sendHttpImageResponse,
  startsWithSvgRootElement,
} from "./http-image-response.js";
import { authorizeControlUiReadRequestOrReply } from "./http-utils.js";
import { isTerminalConfigEnabled } from "./terminal/enabled.js";

const ROOT_PREFIX = "/";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE = "assistant-media";
const CONTROL_UI_ASSISTANT_MEDIA_TICKET_TTL_MS = 5 * 60 * 1000;
const CONTROL_UI_ASSETS_MISSING_MESSAGE =
  "Control UI assets not found. Build them with `pnpm ui:build` (auto-installs UI deps), or run `pnpm ui:dev` during development.";
const controlUiAssistantMediaTicketSecret = randomBytes(32);
const loadAvatarThumbnail = createLazyRuntimeModule(
  () => import("./assistant-avatar-thumbnail.runtime.js"),
);

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
  | {
      kind: "bundled";
      path: string;
      realPath?: string;
      retainedAssets?: ControlUiAssetRetention;
      publicAssetBuildId?: string;
    }
  | { kind: "resolved"; path: string; realPath?: string }
  | { kind: "invalid"; path: string }
  | { kind: "preparing" }
  // The document route is unauthenticated; build diagnostics stay in Gateway logs.
  | { kind: "failed" }
  | { kind: "missing" };

const CONTROL_UI_NAMESPACE_PREFIX = "/__openclaw__/";
/** Anchors bundled assets before deep-linked documents begin preloading. */
function rewriteControlUiIndexHtmlAssetHrefs(
  html: string,
  basePath: string,
  buildId?: string,
): string {
  const normalized = normalizeControlUiBasePath(basePath);
  let next = html
    .replaceAll('src="./assets/', `src="${normalized}/assets/`)
    .replaceAll('href="./assets/', `href="${normalized}/assets/`);
  for (const asset of CONTROL_UI_ROOT_PUBLIC_ASSETS) {
    const version =
      buildId && isControlUiVersionedPublicAsset(asset) ? `?v=${encodeURIComponent(buildId)}` : "";
    const assetHref = `href="${buildControlUiRootAssetPath(normalized, asset)}${version}"`;
    // Vite's portable ./ base emits relative hrefs, which the browser starts
    // resolving against a nested route before the UI can correct them.
    next = next.replaceAll(`href="./${asset}"`, assetHref);
    next = next.replaceAll(`href="/${asset}"`, assetHref);
    next = next.replaceAll(`href="${buildControlUiRootAssetPath(normalized, asset)}"`, assetHref);
  }
  return next;
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
  options?: {
    configuredRootPath?: string;
    failed?: boolean;
    preparing?: boolean;
  },
) {
  const message = options?.preparing
    ? "Control UI assets are being prepared. Try again shortly."
    : options?.failed
      ? "Control UI assets could not be prepared. Check the Gateway logs or run `openclaw doctor --fix`."
      : options?.configuredRootPath
        ? `Control UI assets not found at ${options.configuredRootPath}. Build them with \`pnpm ui:build\` (auto-installs UI deps), or update gateway.controlUi.root.`
        : CONTROL_UI_ASSETS_MISSING_MESSAGE;
  if (options?.preparing) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Retry-After", "1");
  }
  respondPlainText(res, 503, message);
}

function isValidAgentPathSegment(agentId: string): boolean {
  return /^[a-z0-9][a-z0-9_-]{0,63}$/i.test(agentId);
}

function normalizeAssistantMediaSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) {
    return null;
  }
  if (/^file:/iu.test(trimmed)) {
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

type AssistantMediaAvailability =
  | ({
      available: true;
      mimeType?: string;
      playback?: "native" | "transcode";
      sizeBytes?: number;
    } & MediaProbeResult)
  | { available: false; reason: string; code: string };

type AssistantMediaTicketPayload = {
  scope: typeof CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE;
  source: string;
  exp: number;
  session?: AssistantMediaSession;
  reader: AssistantMediaReader;
  agentId?: string;
  file?: { realPath: string; dev: string; ino: string };
};

function signAssistantMediaTicketPayload(encodedPayload: string): string {
  return createHmac("sha256", controlUiAssistantMediaTicketSecret)
    .update(encodedPayload)
    .digest("base64url");
}

function createAssistantMediaTicket(
  payloadFields: Omit<AssistantMediaTicketPayload, "scope" | "exp">,
  nowMs = Date.now(),
) {
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
    ...payloadFields,
    exp,
  };
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = signAssistantMediaTicketPayload(encodedPayload);
  return {
    mediaTicket: `v1.${encodedPayload}.${sig}`,
    mediaTicketExpiresAt: resolveTimestampMsToIsoString(exp),
  };
}

function verifyAssistantMediaTicket(
  ticket: string | null,
  source: string,
  agentId: string | undefined,
  nowMs = Date.now(),
): AssistantMediaTicketPayload | undefined {
  const now = asDateTimestampMs(nowMs);
  if (now === undefined) {
    return undefined;
  }
  const parts = ticket?.split(".");
  if (!parts || parts.length !== 3 || parts[0] !== "v1") {
    return undefined;
  }
  const [, encodedPayload, sig] = parts;
  if (!encodedPayload || !sig) {
    return undefined;
  }
  const expectedSig = signAssistantMediaTicketPayload(encodedPayload);
  if (!safeEqualSecret(sig, expectedSig)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(
      Buffer.from(encodedPayload, "base64url").toString("utf8"),
    ) as Partial<AssistantMediaTicketPayload>;
    const valid =
      payload.scope === CONTROL_UI_ASSISTANT_MEDIA_TICKET_SCOPE &&
      payload.source === source &&
      payload.agentId === agentId &&
      typeof payload.reader?.authMethod === "string" &&
      Array.isArray(payload.reader.operatorScopes) &&
      (payload.file === undefined ||
        (typeof payload.file?.realPath === "string" &&
          typeof payload.file.dev === "string" &&
          typeof payload.file.ino === "string")) &&
      typeof payload.exp === "number" &&
      Number.isFinite(payload.exp) &&
      payload.exp >= now;
    // SAFETY: This process alone mints payloads; their signature and requested scope are verified above.
    return valid ? (payload as AssistantMediaTicketPayload) : undefined;
  } catch {
    return undefined;
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
      case "unsupported-media-type":
        return { available: false, code: "unsupported-media-type", reason: "Not an image" };
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

type AssistantMediaPolicy = NonNullable<ReturnType<typeof resolveAssistantMediaPolicy>>;
type AssistantMediaFile = NonNullable<AssistantMediaTicketPayload["file"]>;

function sameAssistantMediaFile(actual: AssistantMediaFile, expected: AssistantMediaFile) {
  return (
    actual.realPath === expected.realPath &&
    actual.dev === expected.dev &&
    actual.ino === expected.ino
  );
}

async function openAssistantMedia(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
) {
  const reference = await resolveMediaReferenceLocalPathInfo(source);
  if (policy.remote && reference.kind === "local") {
    throw new LocalMediaAccessError("invalid-path", "File is on another computer");
  }
  let outsideRoots = false;
  try {
    await assertLocalMediaAllowed(reference.path, policy.localRoots);
  } catch (error) {
    if (!(error instanceof LocalMediaAccessError) || error.code !== "path-not-allowed") {
      throw error;
    }
    outsideRoots = true;
    if (policy.workspaceOnly && !allowance) {
      throw error;
    }
  }
  const opened = await openLocalFileSafely({ filePath: reference.path });
  try {
    let file: AssistantMediaFile | undefined;
    if (outsideRoots && allowance) {
      const identity = await opened.handle.stat({ bigint: true });
      const candidate = {
        realPath: opened.realPath,
        dev: identity.dev.toString(),
        ino: identity.ino.toString(),
      };
      if (allowance === true || sameAssistantMediaFile(candidate, allowance)) {
        file = candidate;
      } else if (policy.workspaceOnly) {
        // Replacing an allowed image loses the grant; offer the same explicit choice again.
        throw new LocalMediaAccessError("path-not-allowed", "Outside allowed folders");
      }
    }
    // Validate the descriptor target too: a symlink may change between containment and open.
    if (!outsideRoots) {
      await assertLocalMediaAllowed(opened.realPath, policy.localRoots);
    }
    const sniffBuffer = Buffer.alloc(Math.min(opened.stat.size, 8192));
    const bytesRead = sniffBuffer.length
      ? await readFileWindowFully(opened.handle, sniffBuffer, 0)
      : 0;
    const buffer = sniffBuffer.subarray(0, bytesRead);
    const mimeType = startsWithSvgRootElement(buffer.toString("utf8"))
      ? "image/svg+xml"
      : await detectMime({ buffer, ...(outsideRoots ? {} : { filePath: reference.path }) });
    // Host-wide reads authorize actual image bytes, never a filename's extension.
    if (outsideRoots && kindFromMime(mimeType) !== "image") {
      throw new LocalMediaAccessError("unsupported-media-type", "Not an image");
    }
    return { opened, reference, mimeType, outsideRoots, file };
  } catch (error) {
    await opened.handle.close().catch(() => {});
    throw error;
  }
}

async function resolveAssistantMediaAvailability(
  source: string,
  policy: AssistantMediaPolicy,
  allowance: true | AssistantMediaFile | undefined,
  agentId: string | undefined,
): Promise<AssistantMediaAvailability & { mediaTicket?: string; mediaTicketExpiresAt?: string }> {
  try {
    const { opened, mimeType, file } = await openAssistantMedia(source, policy, allowance);
    try {
      const mediaKind = kindFromMime(mimeType);
      const playbackProbe =
        mediaKind === "audio" || mediaKind === "video"
          ? await probePlaybackMediaFileDescriptor(opened.handle.fd, mediaKind)
          : null;
      const playback =
        mimeType && (mediaKind === "audio" || mediaKind === "video")
          ? await resolvePlaybackModeForSource({
              sourcePath: opened.realPath,
              sourceStat: opened.stat,
              mimeType,
              kind: mediaKind,
              probe: playbackProbe,
            })
          : undefined;
      return {
        available: true,
        ...(mimeType ? { mimeType } : {}),
        ...(playback ? { playback } : {}),
        sizeBytes: opened.stat.size,
        ...toMediaProbeResult(playbackProbe),
        ...createAssistantMediaTicket({
          source,
          agentId,
          session: policy.session,
          reader: policy.reader,
          ...(file ? { file } : {}),
        }),
      };
    } finally {
      await opened.handle.close().catch(() => {});
    }
  } catch (error) {
    return classifyAssistantMediaError(error);
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
  if (!urlRaw) {
    return false;
  }
  const url = new URL(urlRaw, "http://localhost");
  if (url.pathname !== resolveAssistantMediaRoutePath(opts?.basePath)) {
    return false;
  }
  const isMetaRequest = url.searchParams.get("meta") === "1";
  const explicitAllow =
    req.method === "POST" && isMetaRequest && url.searchParams.get("allow") === "1";
  if (!isReadHttpMethod(req.method) && !explicitAllow) {
    return false;
  }
  applyControlUiSecurityHeaders(res);
  const source = normalizeAssistantMediaSource(url.searchParams.get("source") ?? "");
  if (!source) {
    respondControlUiNotFound(res);
    return true;
  }
  const sessionKey = url.searchParams.get("sessionKey")?.trim() || undefined;
  const agentId = sessionKey ? url.searchParams.get("agentId")?.trim() || undefined : opts?.agentId;
  const ticket = verifyAssistantMediaTicket(url.searchParams.get("mediaTicket"), source, agentId);
  const requestAuth =
    isMetaRequest || !ticket
      ? await authorizeControlUiReadRequestOrReply({
          req,
          res,
          auth: opts?.auth,
          trustedProxies: opts?.trustedProxies,
          allowRealIpFallback: opts?.allowRealIpFallback,
          rateLimiter: opts?.rateLimiter,
          allowQueryToken: !explicitAllow,
        })
      : undefined;
  if ((isMetaRequest || !ticket) && !requestAuth) {
    return true;
  }
  const policyParams = { config: opts?.config ?? {}, sessionKey, agentId };
  const policy = resolveAssistantMediaPolicy({
    ...policyParams,
    requestAuth: requestAuth ?? undefined,
    reader: isMetaRequest ? undefined : ticket?.reader,
  });
  if (!policy) {
    respondControlUiNotFound(res);
    return true;
  }
  if (explicitAllow && !policy.canAllow) {
    sendJson(res, 403, { error: "Allowing an outside image requires operator.admin" });
    return true;
  }
  const sameSession =
    ticket &&
    ticket.session?.sessionKey === policy.session?.sessionKey &&
    ticket.session?.agentId === policy.session?.agentId &&
    ticket.session?.sessionId === policy.session?.sessionId;
  if (!isMetaRequest && url.searchParams.has("mediaTicket") && (!ticket || !sameSession)) {
    respondControlUiNotFound(res);
    return true;
  }
  const allowance = explicitAllow
    ? true
    : ticket?.file && sameSession && policy.canAllow
      ? ticket.file
      : undefined;
  const assertCurrentPolicy = () => {
    // Reapply durable profile, role, and session owners after every async preparation.
    // A global access epoch changes on ordinary session activity, so it cannot revoke tickets.
    const current = resolveAssistantMediaPolicy({ ...policyParams, reader: policy.reader });
    if (
      !current ||
      current.session?.sessionKey !== policy.session?.sessionKey ||
      current.session?.agentId !== policy.session?.agentId ||
      current.session?.sessionId !== policy.session?.sessionId ||
      current.remote !== policy.remote ||
      current.workspaceOnly !== policy.workspaceOnly ||
      current.localRoots.length !== policy.localRoots.length ||
      current.localRoots.some((root, index) => root !== policy.localRoots[index]) ||
      (allowance && policy.workspaceOnly && !current.canAllow)
    ) {
      throw new FsSafeError("path-mismatch", "Media access changed");
    }
    return current;
  };
  if (isMetaRequest) {
    const availability = await resolveAssistantMediaAvailability(
      source,
      policy,
      allowance,
      agentId,
    );
    let current;
    try {
      current = assertCurrentPolicy();
    } catch {
      respondControlUiNotFound(res);
      return true;
    }
    sendJson(
      res,
      200,
      !availability.available && availability.code === "outside-allowed-folders"
        ? { ...availability, retryable: false, ...(current.canAllow ? { canAllow: true } : {}) }
        : availability,
    );
    return true;
  }

  let byteStream: ReturnType<typeof createGatewayByteStream> | undefined;
  try {
    const media = await openAssistantMedia(source, policy, allowance);
    const resolvedReference = media.reference;
    const localPath = resolvedReference.path;
    let opened = media.opened;
    byteStream = createGatewayByteStream(res, opened.handle, () => respondControlUiNotFound(res));
    const mime = media.mimeType;
    let contentType = mime ?? "application/octet-stream";
    let filename =
      resolvedReference.kind === "inbound"
        ? extractOriginalFilename(localPath)
        : path.basename(localPath);
    const mediaKind = kindFromMime(contentType);
    if (
      url.searchParams.get("playback") === "1" &&
      (mediaKind === "audio" || mediaKind === "video")
    ) {
      const playback = await resolvePlaybackTranscode({
        sourcePath: opened.realPath,
        sourceStat: opened.stat,
        mimeType: contentType,
        kind: mediaKind,
      });
      if (playback.kind === "preparing") {
        await byteStream.close();
        assertCurrentPolicy();
        sendJson(res, 202, { status: "preparing" });
        return true;
      }
      if (playback.kind === "transcoded") {
        const transcoded = await openLocalFileSafely({ filePath: playback.path }).catch(() => null);
        if (transcoded) {
          await byteStream.close();
          opened = transcoded;
          byteStream = createGatewayByteStream(res, opened.handle, () =>
            respondControlUiNotFound(res),
          );
          contentType = playback.contentType;
          filename = replacePlaybackFileExtension(filename, playback.extension);
        }
      }
    }
    assertCurrentPolicy();
    if (media.outsideRoots && mediaKind === "image") {
      applyHttpImageContentSecurityPolicy(res);
    }
    res.setHeader("Content-Type", contentType);
    res.setHeader(
      "Content-Disposition",
      buildAssistantMediaContentDisposition(filename, contentType),
    );
    res.setHeader("Cache-Control", "no-cache");
    const byteResponse = resolveByteResponse({
      // Allowed paths are mutable; matching size and mtime cannot prove unchanged bytes.
      file: { size: opened.stat.size },
      method: req.method,
      request: req,
    });
    writeByteHeaders(res, byteResponse);
    await byteStream.pipe(byteResponse, req.method);
    return true;
  } catch {
    await byteStream?.close();
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
  const parsed = parseControlUiResourcePath("agentAvatar", pathname, basePath);
  if (!parsed.matched) {
    return false;
  }

  applyControlUiSecurityHeaders(res);
  const agentId = parsed.value;
  if (!agentId || !isValidAgentPathSegment(agentId)) {
    respondControlUiNotFound(res);
    return true;
  }

  if (
    !(await authorizeControlUiReadRequestOrReply({
      req,
      res,
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
  try {
    const resolved = projection.resolution;
    if (url.searchParams.get("meta") === "1") {
      const meta = controlUiAvatarResolutionMeta(resolved);
      const avatarUrl =
        gatewayAssistantAvatarUrl(projection, basePath, agentId) ??
        (resolved?.kind === "remote" ? resolved.url : null);
      sendJson(res, 200, {
        avatarUrl,
        avatarSource: meta.avatarSource,
        avatarStatus: meta.avatarStatus,
        avatarReason: meta.avatarReason,
      } satisfies ControlUiAvatarMeta);
      return true;
    }

    if (url.searchParams.has("v") && (projection.openedFile || resolved?.kind === "data")) {
      const source = projection.openedFile
        ? { file: projection.openedFile }
        : { dataUrl: identity.avatar };
      try {
        const image = await (await loadAvatarThumbnail()).readGatewayAvatarThumbnail(source);
        // Browser HTTP caches must not reuse authenticated bytes after a credential switch.
        res.setHeader("vary", "Authorization, Cookie");
        sendHttpImageResponse({
          req,
          res,
          image,
          filename: "avatar",
          cacheControl:
            url.searchParams.get("v") === gatewayAvatarImageRevision(source)
              ? "private, max-age=31536000, immutable"
              : "private, no-cache",
        });
      } catch {
        respondControlUiNotFound(res);
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
        // The pinned descriptor exposes GET's exact byte count without reading the avatar.
        res.setHeader("Content-Length", String(projection.openedFile.stat.size));
        res.end();
        return true;
      }
      const body = await readFileDescriptorBounded(projection.openedFile.fd, AVATAR_MAX_BYTES);
      res.end(body);
      return true;
    } catch {
      respondControlUiNotFound(res);
      return true;
    }
  } finally {
    if (projection.openedFile) {
      fs.closeSync(projection.openedFile.fd);
    }
  }
}

async function serveResolvedIndexHtml(
  req: IncomingMessage,
  res: ServerResponse,
  body: string,
  basePath?: string,
  allowWasm?: boolean,
  environment?: ControlUiEnvironment,
  buildId?: string,
) {
  const normalizedBasePath = normalizeControlUiBasePath(basePath);
  const withBasePath = rewriteControlUiIndexHtmlAssetHrefs(body, normalizedBasePath, buildId);
  // An empty base path is authoritative for Gateway resources even when the
  // router infers a namespace. Always emit it so resources stay root-mounted.
  const basePathAttribute = ` ${CONTROL_UI_BASE_PATH_ATTRIBUTE}="${escapeHtml(normalizedBasePath)}"`;
  const environmentAttributes = environment
    ? ` ${CONTROL_UI_ENVIRONMENT_ATTRIBUTE}="${escapeHtml(JSON.stringify(environment))}"`
    : "";
  // Let the app initialize fail-closed without guessing whether this document
  // was served with the terminal's WASM CSP allowance.
  // The lifecycle owns bundled identity. Strip the build stamp for custom roots,
  // whose files may change independently and must keep revalidating.
  const buildAttribute = buildId
    ? ` ${CONTROL_UI_BUILD_ID_ATTRIBUTE}="${escapeHtml(buildId)}"`
    : "";
  const prepared = withBasePath.replace(/<html\b[^>]*>/i, (tag) =>
    tag
      .replace(new RegExp(`\\s${CONTROL_UI_BUILD_ID_ATTRIBUTE}="[^"]*"`, "g"), "")
      .replace(
        /<html\b/i,
        `<html${basePathAttribute} ${CONTROL_UI_TERMINAL_ENABLED_ATTRIBUTE}="${allowWasm === true}"${environmentAttributes}${buildAttribute}`,
      ),
  );
  const hashes = computeInlineScriptHashes(prepared);
  // Always set the document CSP here (the index carries inline scripts) so the
  // terminal's WASM relaxation is applied to the page that loads ghostty-web.
  res.setHeader(
    "Content-Security-Policy",
    buildControlUiCspHeader({
      inlineScriptHashes: hashes,
      allowWasm,
      portalHost: req.headers.host,
    }),
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
): { path: string; fd: number; size: number; mtimeMs: number } | null {
  const opened = openRootFileSync({
    absolutePath: filePath,
    rootPath: rootReal,
    rootRealPath: rootReal,
    boundaryLabel: "control ui root",
    skipLexicalRootCheck: true,
    // Symlinked assets that resolve inside the root are served; fs-safe still
    // rejects hops whose canonical target escapes the control-ui root.
    rejectSymlinks: false,
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
  return { path: opened.path, fd: opened.fd, size: opened.stat.size, mtimeMs: opened.stat.mtimeMs };
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
  // The embedded terminal ships ghostty-web (WASM); the index CSP carries the
  // WASM relaxation whenever the terminal is enabled (the default) and stays
  // strict once operators opt out with gateway.terminal.enabled: false.
  const terminalEnabled = opts?.terminalEnabled ?? isTerminalConfigEnabled(opts?.config);
  const route = classifyControlUiRequest({
    basePath,
    pathname,
    search: url.search,
    method: req.method,
    accept: req.headers?.accept,
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

  if (isControlUiSharePath(pathname, basePath) && pathname !== `${basePath}/share/card.png`) {
    serveControlUiShareDocument(req, res, url, basePath, resolveGatewayPublicOrigin(opts?.config));
    return true;
  }

  if (matchesControlUiBootstrapConfigPath(pathname, basePath)) {
    let pluginFrameGrants: readonly ControlUiPluginFrameGrantAck[] = [];
    if (
      !(await authorizeControlUiReadRequestOrReply({
        req,
        res,
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
    const resolvedIdentity = config
      ? resolveAssistantIdentity({ cfg: config, agentId: opts?.agentId })
      : undefined;
    const identity = resolvedIdentity ?? DEFAULT_ASSISTANT_IDENTITY;
    const assistantAgentId = resolvedIdentity?.agentId;
    const avatarProjection =
      config && resolvedIdentity
        ? resolveGatewayAssistantAvatar({
            cfg: config,
            identity: resolvedIdentity,
            httpBasePath: basePath,
          })
        : { avatar: identity.avatar, resolution: null };
    const avatarMeta = controlUiAvatarResolutionMeta(avatarProjection.resolution);
    sendJson(res, 200, {
      basePath,
      assistantName: identity.name,
      assistantAvatar: avatarProjection.avatar,
      assistantAvatarSource: avatarMeta.avatarSource,
      assistantAvatarStatus: avatarMeta.avatarStatus,
      assistantAvatarReason: avatarMeta.avatarReason,
      ...(assistantAgentId ? { assistantAgentId } : {}),
      serverVersion: resolveRuntimeServiceVersion(process.env),
      serverBuildId:
        config?.gateway?.controlUi?.root === undefined
          ? (resolveRuntimeServiceBuildId() ?? undefined)
          : undefined,
      devGitBranch: (await resolveDevInstallGitBranch()) ?? undefined,
      embedSandbox:
        config?.gateway?.controlUi?.embedSandbox === "trusted"
          ? "trusted"
          : config?.gateway?.controlUi?.embedSandbox === "strict"
            ? "strict"
            : "scripts",
      allowExternalEmbedUrls: config?.gateway?.controlUi?.allowExternalEmbedUrls === true,
      automaticallyFetchFavicons: config?.gateway?.controlUi?.automaticallyFetchFavicons !== false,
      seamColor: config?.ui?.seamColor,
      environment: config?.gateway?.controlUi?.environment,
      communityInvite: config?.gateway?.controlUi?.communityInvite !== false,
      terminalEnabled,
      cliAgentsEnabled: config?.gateway?.cliAgents?.enabled !== false,
      pluginAssetsRequireAuth: opts?.auth !== undefined && opts.auth.mode !== "none",
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
    respondControlUiAssetsUnavailable(res, {
      configuredRootPath: rootState.path,
    });
    return true;
  }
  if (rootState?.kind === "preparing") {
    respondControlUiAssetsUnavailable(res, {
      preparing: true,
    });
    return true;
  }
  if (rootState?.kind === "failed") {
    respondControlUiAssetsUnavailable(res, {
      failed: true,
    });
    return true;
  }
  if (!rootState || rootState.kind === "missing") {
    respondControlUiAssetsUnavailable(res);
    return true;
  }

  const root = rootState.path;
  const rootReal = (() => {
    if (rootState.realPath) {
      return rootState.realPath;
    }
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
  const standaloneDocument =
    isControlUiApprovalDocumentPath({ basePath, pathname }) ||
    isControlUiFocusDocumentPath({ basePath, pathname });
  const rel = (() => {
    if (uiPath === "/share/card.png") {
      return "social-card.png";
    }
    if (uiPath === ROOT_PREFIX) {
      return "";
    }
    if (uiPath.startsWith(CONTROL_UI_NAMESPACE_PREFIX)) {
      const namespacedRel = uiPath.slice(CONTROL_UI_NAMESPACE_PREFIX.length);
      if (isControlUiRootPublicAsset(namespacedRel)) {
        return namespacedRel;
      }
    }
    const assetsIndex = uiPath.indexOf("/assets/");
    if (assetsIndex >= 0) {
      return uiPath.slice(assetsIndex + 1);
    }
    return uiPath.slice(1);
  })();
  const requested = standaloneDocument
    ? "index.html"
    : rel && !rel.endsWith("/")
      ? rel
      : `${rel}index.html`;
  let fileRel: string;
  try {
    // Decode the artifact name once, after route ownership and before path validation.
    fileRel = decodeURIComponent(requested);
  } catch {
    respondControlUiNotFound(res);
    return true;
  }
  if (!isSafeRelativePath(fileRel)) {
    respondControlUiNotFound(res);
    return true;
  }
  const filePath = path.resolve(root, fileRel);
  if (!isWithinDir(root, filePath)) {
    respondControlUiNotFound(res);
    return true;
  }

  const isBundledRoot = rootState.kind === "bundled";
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
  const fingerprintedAsset = isBundledRoot && fileRel.startsWith("assets/");
  const publicAssetBuildId = isBundledRoot ? rootState.publicAssetBuildId : undefined;
  const immutableAsset =
    fingerprintedAsset ||
    Boolean(
      publicAssetBuildId &&
      url.searchParams.get("v") === publicAssetBuildId &&
      isControlUiVersionedPublicAsset(fileRel),
    );
  let servingRootReal = rootReal;
  let rejectRepresentationHardlinks = rejectHardlinks;
  let safeFile = resolveSafeControlUiFile(rootReal, filePath, rejectHardlinks);
  if (!safeFile && fingerprintedAsset && rootState.kind === "bundled") {
    const retained = rootState.retainedAssets?.resolveAsset(fileRel);
    if (retained) {
      servingRootReal = retained.rootRealPath;
      rejectRepresentationHardlinks = true;
      safeFile = resolveSafeControlUiFile(retained.rootRealPath, retained.filePath, true);
    }
  }
  // An index alias still owns document preparation when its physical target has
  // another name. Preserve existing aliases that resolve to a canonical index too.
  if (
    safeFile &&
    path.basename(fileRel) !== "index.html" &&
    path.basename(safeFile.path) !== "index.html"
  ) {
    // Future filesystem clocks must not make later replacements look unmodified;
    // clamp to response origination as in resolveByteResponse.
    const originatedAtMs = Date.now();
    const lastModifiedMs = Math.floor(Math.min(safeFile.mtimeMs, originatedAtMs) / 1_000) * 1_000;
    const representation = resolveOpenedControlUiRepresentation({
      req,
      sourceFile: safeFile,
      contentPath: fileRel,
      precompressed: fingerprintedAsset,
      openPrecompressedFile: (compressedPath) =>
        resolveSafeControlUiFile(servingRootReal, compressedPath, rejectRepresentationHardlinks),
    });
    if (!representation) {
      respondControlUiNotAcceptable(res);
      return true;
    }
    // Negotiation failures precede preconditions; release the selected representation on 304.
    if (isControlUiFileUnmodified(req, lastModifiedMs, originatedAtMs)) {
      fs.closeSync(representation.bodyFile.fd);
      respondControlUiNotModified(res, { immutable: immutableAsset, lastModifiedMs });
      return true;
    }
    if (req.method === "HEAD") {
      try {
        respondHeadForControlUiFile(res, fileRel, {
          immutable: immutableAsset,
          encoding: representation.encoding,
          contentLength: representation.bodyFile.size,
          lastModifiedMs,
        });
        return true;
      } finally {
        fs.closeSync(representation.bodyFile.fd);
      }
    }
    const body = await readAndCloseControlUiFile(representation.bodyFile);
    await serveControlUiAsset(res, fileRel, body, {
      immutable: immutableAsset,
      encoding: representation.encoding,
      lastModifiedMs,
    });
    return true;
  }

  if (!safeFile) {
    // Missing assets stay 404; dotted routes can still use the SPA document.
    if (isControlUiStaticAssetExtension(path.extname(fileRel).toLowerCase())) {
      respondControlUiNotFound(res);
      return true;
    }
    if (!route.spaFallback) {
      return false;
    }
    const indexPath = path.resolve(root, "index.html");
    if (filePath !== indexPath) {
      safeFile = resolveSafeControlUiFile(rootReal, indexPath, rejectHardlinks);
    }
  }

  // Direct documents and SPA fallbacks share rewriting, CSP, encoding and fd ownership.
  if (safeFile) {
    if (req.method === "HEAD") {
      try {
        const encoding = resolveControlUiHtmlEncoding(req);
        if (encoding === "not-acceptable") {
          respondControlUiNotAcceptable(res);
          return true;
        }
        respondHeadForControlUiFile(res, "index.html", {
          encoding: encoding === "identity" ? undefined : encoding,
        });
        return true;
      } finally {
        fs.closeSync(safeFile.fd);
      }
    }
    const body = (await readAndCloseControlUiFile(safeFile)).toString("utf8");
    await serveResolvedIndexHtml(
      req,
      res,
      body,
      basePath,
      terminalEnabled,
      opts?.config?.gateway?.controlUi?.environment,
      publicAssetBuildId,
    );
    return true;
  }

  respondControlUiNotFound(res);
  return true;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
