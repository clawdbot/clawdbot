// Web media helpers load local and remote media for web-facing surfaces.
import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { maxBytesForKind, type MediaKind } from "@openclaw/media-core/constants";
import { basenameFromAnyPath, extnameFromAnyPath } from "@openclaw/media-core/file-name";
import {
  detectMime,
  extensionForMime,
  getFileExtension,
  kindFromMime,
  mimeTypeFromFilePath,
  normalizeMimeType,
} from "@openclaw/media-core/mime";
import { hasHttpUrlPrefix } from "@openclaw/net-policy/url-protocol";
import { uniqueValues } from "@openclaw/normalization-core/string-normalization";
import { resolveCanvasHttpPathToLocalPath } from "../canvas/documents.js";
import { logVerbose, shouldLogVerbose } from "../globals.js";
import { formatErrorMessage } from "../infra/errors.js";
import { FsSafeError, readLocalFileSafely } from "../infra/fs-safe.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../infra/kysely-sync.js";
import { assertNoWindowsNetworkPath, safeFileURLToPath } from "../infra/local-file-access.js";
import type { PinnedDispatcherPolicy, SsrFPolicy } from "../infra/net/ssrf.js";
import { isNotFoundPathError } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { getActivePluginHttpRouteRegistry } from "../plugins/runtime.js";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  openOpenClawStateDatabase,
  runOpenClawStateWriteTransaction,
} from "../state/openclaw-state-db.js";
import { resolveUserPath } from "../utils.js";
import { chunkItems } from "../utils/chunk-items.js";
import { readRemoteMediaBuffer } from "./fetch.js";
import {
  assertLocalMediaAllowed,
  getDefaultLocalRoots,
  LocalMediaAccessError,
  type LocalMediaAccessErrorCode,
} from "./local-media-access.js";
import { MediaReferenceError, resolveInboundMediaReference } from "./media-reference.js";
import {
  createImageProcessor,
  readImageMetadataFromHeader,
  readImageProbeFromHeader,
} from "./media-services.js";
import { extractOriginalFilename, getMediaDir } from "./store.js";

export { getDefaultLocalRoots, LocalMediaAccessError };
export type { LocalMediaAccessErrorCode };

/** Loaded media bytes plus resolved MIME kind and filename metadata for outbound/plugin callers. */
export type WebMediaResult = {
  buffer: Buffer;
  contentType?: string;
  kind: MediaKind | undefined;
  fileName?: string;
  /** Source bytes came from a generated-HTML trust boundary. */
  trustedGeneratedHtmlSource?: boolean;
};

type WebMediaOptions = {
  maxBytes?: number;
  optimizeImages?: boolean;
  imageCompression?: ImageCompressionPolicy;
  ssrfPolicy?: SsrFPolicy;
  proxyUrl?: string;
  fetchImpl?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  requestInit?: RequestInit;
  readIdleTimeoutMs?: number;
  trustExplicitProxyDns?: boolean;
  workspaceDir?: string;
  /** Allowed root directories for local path reads. "any" is deprecated; prefer sandboxValidated + readFile. */
  localRoots?: readonly string[] | "any";
  /** Channel inbound attachment root patterns checked with inbound path policy semantics. */
  inboundRoots?: readonly string[];
  /** Caller already validated the local path (sandbox/other guards); requires readFile override. */
  sandboxValidated?: boolean;
  readFile?: (filePath: string) => Promise<Buffer>;
  /** Host-local fs-policy read piggyback; rejects plaintext-like document sends. */
  hostReadCapability?: boolean;
};

/** Compression preference used to tune image size/quality search grids. */
export type ImageQualityPreference = "auto" | "efficient" | "balanced" | "high";

/** Per-model image compression constraints merged into outbound media policy. */
export type ImageCompressionModelPolicy = {
  maxBytes?: number;
  maxPixels?: number;
  maxSidePx?: number;
  preferredSidePx?: number;
};

/** Image compression policy for model/tool callers that need bounded media payloads. */
export type ImageCompressionPolicy = {
  quality?: ImageQualityPreference;
  models?: ImageCompressionModelPolicy[];
  imageCount?: number;
};

async function resolveMediaStoreUriToPath(mediaUrl: string): Promise<string | null> {
  if (!/^media:\/\//i.test(mediaUrl)) {
    return null;
  }
  try {
    return (await resolveInboundMediaReference(mediaUrl))?.physicalPath ?? null;
  } catch (err) {
    if (err instanceof MediaReferenceError) {
      throw new LocalMediaAccessError(err.code, err.message, { cause: err });
    }
    throw err;
  }
}

async function resolveHostedPluginMediaUrl(mediaUrl: string): Promise<string | null> {
  const registry = getActivePluginHttpRouteRegistry();
  for (const entry of registry?.hostedMediaResolvers ?? []) {
    try {
      const resolved = await entry.resolver(mediaUrl);
      if (typeof resolved === "string" && resolved.trim()) {
        return resolved;
      }
    } catch (err) {
      if (shouldLogVerbose()) {
        logVerbose(
          `Hosted media resolver failed (${entry.pluginId ?? "unknown"}): ${formatErrorMessage(err)}`,
        );
      }
    }
  }
  return null;
}

function resolveWebMediaOptions(params: {
  maxBytesOrOptions?: number | WebMediaOptions;
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" };
  optimizeImages: boolean;
}): WebMediaOptions {
  if (typeof params.maxBytesOrOptions === "number" || params.maxBytesOrOptions === undefined) {
    return {
      maxBytes: params.maxBytesOrOptions,
      optimizeImages: params.optimizeImages,
      ssrfPolicy: params.options?.ssrfPolicy,
      localRoots: params.options?.localRoots,
    };
  }
  return {
    ...params.maxBytesOrOptions,
    optimizeImages: params.optimizeImages
      ? (params.maxBytesOrOptions.optimizeImages ?? true)
      : false,
  };
}

const HEIC_MIME_RE = /^image\/hei[cf]$/i;
const HEIC_EXT_RE = /\.(heic|heif)$/i;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const HOST_READ_ALLOWED_DOCUMENT_MIMES = new Set([
  "application/msword",
  "application/pdf",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/gzip",
  "application/x-7z-compressed",
  "application/x-tar",
  "application/zip",
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml",
]);
// file-type returns undefined (no magic bytes) for plain-text formats like CSV,
// Markdown, TXT, JSON, and YAML, so host-read needs an explicit "this really
// decodes as text" fallback.
const HOST_READ_TEXT_PLAIN_ALIASES = new Set([
  "text/csv",
  "text/markdown",
  "text/plain",
  "application/json",
  "application/yaml",
]);
// HTML remains deliberately outside the host-read allowlist pending a separate
// security-boundary review, but extension-declared .html files still need to
// fail closed instead of falling through to binary/media sniffing.
const HOST_READ_DECLARED_TEXT_MIMES = new Set([...HOST_READ_TEXT_PLAIN_ALIASES, "text/html"]);
const HOST_READ_DECLARED_TEXT_ERROR =
  "hostReadCapability permits only validated plain-text documents " +
  "and trusted generated HTML reports for local reads";
const HOST_READ_TEXT_PLAIN_EXTENSION_BY_MIME: Record<string, readonly string[]> = {
  "text/plain": [".txt"],
};
const MB = 1024 * 1024;

function stripLegacyMediaDirectivePrefix(mediaUrl: string): string {
  if (/^\s*media:\/\//i.test(mediaUrl)) {
    return mediaUrl;
  }
  return mediaUrl.replace(/^\s*MEDIA\s*:\s*/i, "");
}

function getTextStats(text: string): { printableRatio: number } {
  if (!text) {
    return { printableRatio: 0 };
  }
  let printable = 0;
  let control = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (code === 9 || code === 10 || code === 13 || code === 32) {
      printable += 1;
      continue;
    }
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) {
      control += 1;
      continue;
    }
    printable += 1;
  }
  const total = printable + control;
  if (total === 0) {
    return { printableRatio: 0 };
  }
  return { printableRatio: printable / total };
}

function hasSingleByteTextShape(buffer: Buffer): boolean {
  if (buffer.length === 0) {
    return true;
  }
  let asciiText = 0;
  let control = 0;
  for (const byte of buffer) {
    if (byte === 9 || byte === 10 || byte === 13 || (byte >= 0x20 && byte <= 0x7e)) {
      asciiText += 1;
      continue;
    }
    if (byte < 0x20 || byte === 0x7f) {
      control += 1;
    }
  }
  const total = buffer.length;
  const highBytes = total - asciiText - control;
  return control === 0 && asciiText / total >= 0.7 && highBytes / total <= 0.3;
}

function decodeHostReadText(buffer: Buffer): string | undefined {
  if (buffer.length === 0) {
    return "";
  }
  // UTF-16 decoding is intentionally omitted: TextDecoder("utf-16le/be") never throws on
  // arbitrary byte pairs, so every byte pair is a valid (if meaningless) Unicode scalar —
  // an attacker can prepend a BOM and pass getTextStats with printableRatio≈1.0 on pure
  // binary garbage. The Latin-1 path below already covers the most common non-UTF-8
  // real-world case (Excel CSV exports with accented chars like é, ñ) while remaining
  // safe because hasSingleByteTextShape gates on byte shape *before* any decode.
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    if (!hasSingleByteTextShape(buffer)) {
      return undefined;
    }
    // WHATWG latin1 decodes common Excel-style single-byte exports via Windows-1252 mapping.
    return new TextDecoder("latin1").decode(buffer);
  }
}

function isValidatedHostReadText(buffer?: Buffer): boolean {
  return getValidatedHostReadText(buffer) !== undefined;
}

function getValidatedHostReadText(buffer?: Buffer): string | undefined {
  if (!buffer) {
    return undefined;
  }
  if (buffer.length === 0) {
    return "";
  }
  const text = decodeHostReadText(buffer);
  if (text === undefined) {
    return undefined;
  }
  const { printableRatio } = getTextStats(text);
  return printableRatio > 0.95 ? text : undefined;
}

function isPathInsideRoot(filePath: string | undefined, root: string): boolean {
  if (!filePath) {
    return false;
  }
  const relative = path.relative(path.resolve(root), path.resolve(filePath));
  return (
    relative === "" || (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function resolveLocalMediaFileName(filePath: string): string | undefined {
  const fileName = basenameFromAnyPath(filePath) || undefined;
  return fileName && isPathInsideRoot(filePath, getMediaDir())
    ? extractOriginalFilename(fileName)
    : fileName;
}

function hasHtmlDocumentShape(text: string): boolean {
  const sample = text.trimStart().slice(0, 8192);
  return /^(?:<!doctype\s+html\b|<html\b)/iu.test(sample) || /<\/(?:html|body)>/iu.test(sample);
}

type HostReadHtmlTrust =
  | { source: "temp-root" }
  | { source: "outbound"; expectedSha256: string; expectedSize: number };

const TRUSTED_GENERATED_HTML_MARKER_VERSION = 1;
const TRUSTED_GENERATED_HTML_MARKER_KIND = "trusted-generated-html";
type OutboundProvenanceDatabase = Pick<OpenClawStateKyselyDatabase, "outbound_media_provenance">;

async function getTrustedGeneratedHtmlMarker(
  resolvedFilePath: string,
): Promise<{ sha256: string; size: number } | undefined> {
  try {
    const { db } = openOpenClawStateDatabase();
    const row = executeSqliteQueryTakeFirstSync(
      db,
      getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
        .selectFrom("outbound_media_provenance")
        .select(["kind", "version", "sha256", "size_bytes"])
        .where("realpath", "=", resolvedFilePath),
    );
    return row?.kind === TRUSTED_GENERATED_HTML_MARKER_KIND &&
      row.version === TRUSTED_GENERATED_HTML_MARKER_VERSION
      ? { sha256: row.sha256, size: row.size_bytes }
      : undefined;
  } catch (error) {
    // State failures must narrow trust, never turn into a permissive fallback.
    logVerbose(
      `trusted-html marker lookup failed (${resolvedFilePath}): ${formatErrorMessage(error)}`,
    );
    return undefined;
  }
}

async function resolveTrustedGeneratedHostReadHtml(
  filePath: string | undefined,
): Promise<HostReadHtmlTrust | undefined> {
  if (!filePath) {
    return undefined;
  }
  const info = await lstat(filePath).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
    return undefined;
  }
  const [resolvedFilePath, tmpRoot, outboundRoot] = await Promise.all([
    realpath(filePath).catch(() => undefined),
    realpath(resolvePreferredOpenClawTmpDir()).catch(() => undefined),
    realpath(path.join(getMediaDir(), "outbound")).catch(() => undefined),
  ]);
  if (!resolvedFilePath) {
    return undefined;
  }
  // Outbound staging always requires provenance, even when a custom state dir
  // places media/outbound underneath the otherwise trusted temp root.
  if (outboundRoot && isPathInsideRoot(resolvedFilePath, outboundRoot)) {
    const marker = await getTrustedGeneratedHtmlMarker(resolvedFilePath);
    return marker
      ? { source: "outbound", expectedSha256: marker.sha256, expectedSize: marker.size }
      : undefined;
  }
  return tmpRoot && isPathInsideRoot(resolvedFilePath, tmpRoot)
    ? { source: "temp-root" }
    : undefined;
}

/** Records exact-byte provenance for a trusted generated HTML staged outbound. */
export async function markTrustedGeneratedHtmlPath(
  filePath: string,
  contents: Buffer,
): Promise<void> {
  const resolvedFilePath = await realpath(filePath);
  const outboundRoot = await realpath(path.join(getMediaDir(), "outbound")).catch(() => undefined);
  if (!outboundRoot || !isPathInsideRoot(resolvedFilePath, outboundRoot)) {
    throw new Error(
      `markTrustedGeneratedHtmlPath: refusing path outside outbound staging: ${resolvedFilePath}`,
    );
  }
  const sha256 = createHash("sha256").update(contents).digest("hex");
  const sizeBytes = contents.length;
  const createdAtMs = Date.now();
  runOpenClawStateWriteTransaction(({ db }) => {
    executeSqliteQuerySync(
      db,
      getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
        .insertInto("outbound_media_provenance")
        .values({
          realpath: resolvedFilePath,
          kind: TRUSTED_GENERATED_HTML_MARKER_KIND,
          version: TRUSTED_GENERATED_HTML_MARKER_VERSION,
          sha256,
          size_bytes: sizeBytes,
          created_at_ms: createdAtMs,
        })
        .onConflict((conflict) =>
          conflict.column("realpath").doUpdateSet({
            kind: TRUSTED_GENERATED_HTML_MARKER_KIND,
            version: TRUSTED_GENERATED_HTML_MARKER_VERSION,
            sha256,
            size_bytes: sizeBytes,
            created_at_ms: createdAtMs,
          }),
        ),
    );
  });
}

/** Removes provenance whose staged regular file no longer exists. */
export async function pruneStaleTrustedGeneratedHtmlMarkers(): Promise<void> {
  const { db } = openOpenClawStateDatabase();
  const rows = executeSqliteQuerySync(
    db,
    getNodeSqliteKysely<OutboundProvenanceDatabase>(db)
      .selectFrom("outbound_media_provenance")
      .select("realpath"),
  ).rows;
  const stale: string[] = [];
  for (const row of rows) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(row.realpath);
    } catch (error) {
      if (isNotFoundPathError(error)) {
        stale.push(row.realpath);
      } else {
        logVerbose(
          `trusted-html prune kept uninspectable marker (${row.realpath}): ${formatErrorMessage(error)}`,
        );
      }
      continue;
    }
    if (!info?.isFile() || info.isSymbolicLink() || info.nlink !== 1) {
      stale.push(row.realpath);
    }
  }
  if (stale.length === 0) {
    return;
  }
  runOpenClawStateWriteTransaction(({ db: writeDb }) => {
    for (const batch of chunkItems(stale, 500)) {
      executeSqliteQuerySync(
        writeDb,
        getNodeSqliteKysely<OutboundProvenanceDatabase>(writeDb)
          .deleteFrom("outbound_media_provenance")
          .where("realpath", "in", batch),
      );
    }
  });
  logVerbose(`trusted-html prune removed ${stale.length} stale marker(s)`);
}

function isTrustedGeneratedHostReadHtml(params: {
  filePath?: string;
  sniffedContentType?: string;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
}): boolean {
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (sniffedMime && sniffedMime !== "text/html") {
    return false;
  }
  if (!params.trustedGeneratedHtmlPath) {
    return false;
  }
  const text = getValidatedHostReadText(params.buffer);
  if (text === undefined || !hasHtmlDocumentShape(text)) {
    return false;
  }
  if (params.trustedGeneratedHtmlPath.source === "temp-root") {
    return true;
  }
  return (
    params.buffer?.length === params.trustedGeneratedHtmlPath.expectedSize &&
    createHash("sha256").update(params.buffer).digest("hex") ===
      params.trustedGeneratedHtmlPath.expectedSha256
  );
}

function isAllowedHostReadTextAlias(mime: string | undefined, filePath?: string): boolean {
  if (!mime || !HOST_READ_TEXT_PLAIN_ALIASES.has(mime)) {
    return false;
  }
  const allowedExtensions = HOST_READ_TEXT_PLAIN_EXTENSION_BY_MIME[mime];
  if (!allowedExtensions) {
    return true;
  }
  const ext = getFileExtension(filePath);
  return ext !== undefined && allowedExtensions.includes(ext);
}

function formatMb(bytes: number, digits = 2): string {
  return (bytes / MB).toFixed(digits);
}

function formatCapLimit(label: string, cap: number, size: number): string {
  return `${label} exceeds ${formatMb(cap, 0)}MB limit (got ${formatMb(size)}MB)`;
}

function formatCapReduce(label: string, cap: number, size: number): string {
  return `${label} could not be reduced below ${formatMb(cap, 0)}MB (got ${formatMb(size)}MB)`;
}

function isHeicSource(opts: { contentType?: string; fileName?: string }): boolean {
  if (opts.contentType && HEIC_MIME_RE.test(opts.contentType.trim())) {
    return true;
  }
  if (opts.fileName && HEIC_EXT_RE.test(opts.fileName.trim())) {
    return true;
  }
  return false;
}

function assertHostReadMediaAllowed(params: {
  sniffedContentType?: string;
  contentType?: string;
  filePath?: string;
  kind: MediaKind | undefined;
  buffer?: Buffer;
  trustedGeneratedHtmlPath?: HostReadHtmlTrust;
}): void {
  const declaredMime = normalizeMimeType(mimeTypeFromFilePath(params.filePath));
  const normalizedMime = normalizeMimeType(params.contentType);
  // For extension-declared plain-text aliases such as .csv/.html/.md, trust only the
  // text validator path. Some opaque blobs can still produce bogus binary MIME
  // hits (for example BOM-prefixed 0xFF data sniffing as audio/mpeg), and
  // host-read should reject those instead of returning early on the sniff.
  if (declaredMime && HOST_READ_DECLARED_TEXT_MIMES.has(declaredMime)) {
    if (
      declaredMime === "text/html" &&
      isTrustedGeneratedHostReadHtml({
        filePath: params.filePath,
        sniffedContentType: params.sniffedContentType,
        buffer: params.buffer,
        trustedGeneratedHtmlPath: params.trustedGeneratedHtmlPath,
      })
    ) {
      return;
    }
    if (
      isAllowedHostReadTextAlias(declaredMime, params.filePath) &&
      !params.sniffedContentType &&
      params.buffer &&
      isValidatedHostReadText(params.buffer)
    ) {
      return;
    }
    throw new LocalMediaAccessError("path-not-allowed", HOST_READ_DECLARED_TEXT_ERROR);
  }
  const sniffedKind = kindFromMime(params.sniffedContentType);
  if (sniffedKind === "image" || sniffedKind === "audio" || sniffedKind === "video") {
    return;
  }
  const sniffedMime = normalizeMimeType(params.sniffedContentType);
  if (
    sniffedKind === "document" &&
    sniffedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(sniffedMime)
  ) {
    return;
  }
  if (
    sniffedMime === "application/x-cfb" &&
    [".doc", ".ppt", ".xls"].includes(getFileExtension(params.filePath) ?? "")
  ) {
    return;
  }
  // Plain-text document exception: file-type v22 returns undefined (not "text/plain")
  // for text buffers that have no binary magic bytes. Allow these formats when:
  // - sniffedMime is undefined (no binary signature detected by file-type)
  // - The extension-derived MIME is an allowed text/document MIME (operator intent)
  // - The buffer decodes as actual text instead of opaque binary bytes
  if (
    !sniffedMime &&
    normalizedMime &&
    isAllowedHostReadTextAlias(normalizedMime, params.filePath) &&
    params.buffer &&
    isValidatedHostReadText(params.buffer)
  ) {
    return;
  }
  if (
    params.kind === "document" &&
    normalizedMime &&
    HOST_READ_ALLOWED_DOCUMENT_MIMES.has(normalizedMime)
  ) {
    throw new LocalMediaAccessError(
      "path-not-allowed",
      `Host-local media sends require buffer-verified media/document types (got fallback ${normalizedMime}).`,
    );
  }
  throw new LocalMediaAccessError(
    "path-not-allowed",
    `Host-local media sends only allow buffer-verified images, audio, video, PDF, Office documents, archives, and validated plain-text documents (got ${sniffedMime ?? normalizedMime ?? "unknown"}).`,
  );
}

function toJpegFileName(fileName?: string): string | undefined {
  if (!fileName) {
    return undefined;
  }
  const trimmed = basenameFromAnyPath(fileName.trim());
  if (!trimmed) {
    return fileName;
  }
  const parsed = path.parse(trimmed);
  if (!parsed.ext || HEIC_EXT_RE.test(parsed.ext)) {
    return path.format({ dir: parsed.dir, name: parsed.name || trimmed, ext: ".jpg" });
  }
  return path.format({ dir: parsed.dir, name: parsed.name, ext: ".jpg" });
}

type OptimizedImage = {
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  format: "jpeg" | "png" | "webp";
  mimeType: string;
  quality?: number;
  compressionLevel?: number;
};

const DEFAULT_JPEG_SIDES = [2048, 1536, 1280, 1024, 800] as const;
const DEFAULT_JPEG_QUALITIES = [80, 70, 60, 50, 40] as const;
const DEFAULT_VISION_MAX_SIDE = 2048;
const LOW_IMAGE_SIDE_FALLBACKS = [640, 512, 384, 256, 192, 128] as const;

function normalizeImageQualityPreference(value?: string): ImageQualityPreference {
  switch (value) {
    case "efficient":
    case "balanced":
    case "high":
      return value;
    default:
      return "auto";
  }
}

function squareLongSideForPixelBudget(pixelBudget: number): number {
  return Math.floor(Math.sqrt(pixelBudget));
}

function positiveInteger(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

function effectiveImageQualityPreference(
  policy?: ImageCompressionPolicy,
): Exclude<ImageQualityPreference, "auto"> {
  const preference = normalizeImageQualityPreference(policy?.quality);
  if (preference !== "auto") {
    return preference;
  }
  const imageCount = Math.max(1, Math.floor(policy?.imageCount ?? 1));
  if (imageCount >= 6) {
    return "efficient";
  }
  return "balanced";
}

function maxSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  const maxSide = positiveInteger(model?.maxSidePx);
  const maxPixels = positiveInteger(model?.maxPixels);
  const hardLimits = [
    maxSide,
    maxPixels ? squareLongSideForPixelBudget(maxPixels) : undefined,
  ].filter((value): value is number => value !== undefined);
  if (hardLimits.length > 0) {
    return Math.min(...hardLimits);
  }
  return positiveInteger(model?.preferredSidePx) ?? DEFAULT_VISION_MAX_SIDE;
}

function preferredSideForModel(model: ImageCompressionModelPolicy | undefined): number {
  return (
    positiveInteger(model?.preferredSidePx) ??
    Math.min(maxSideForModel(model), DEFAULT_VISION_MAX_SIDE)
  );
}

function policyModelSides(policy: ImageCompressionPolicy | undefined): {
  maxSide: number;
  preferredSide: number;
} {
  const models = policy?.models?.length ? policy.models : [undefined];
  const maxSide = Math.min(...models.map((model) => maxSideForModel(model)));
  const preferredSide = Math.min(...models.map((model) => preferredSideForModel(model)));
  return {
    maxSide,
    preferredSide: Math.min(preferredSide, maxSide),
  };
}

function sideForPreference(
  preference: Exclude<ImageQualityPreference, "auto">,
  policy?: ImageCompressionPolicy,
): number {
  const { maxSide, preferredSide } = policyModelSides(policy);
  switch (preference) {
    case "efficient":
      return Math.min(preferredSide, maxSide, 1280);
    case "balanced":
      return Math.min(preferredSide, maxSide);
    case "high":
      return maxSide;
  }
  return Math.min(preferredSide, maxSide);
}

function imageMaxBytesForPolicy(policy?: ImageCompressionPolicy): number | undefined {
  const maxBytes = policy?.models
    ?.map((model) => positiveInteger(model.maxBytes))
    .filter((value): value is number => value !== undefined);
  return maxBytes?.length ? Math.min(...maxBytes) : undefined;
}

function imageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
): boolean {
  const models = policy?.models ?? [];
  const hardMaxSides = models
    .map((model) => positiveInteger(model.maxSidePx))
    .filter((value): value is number => value !== undefined);
  const hardMaxPixels = models
    .map((model) => positiveInteger(model.maxPixels))
    .filter((value): value is number => value !== undefined);
  if (hardMaxSides.length === 0 && hardMaxPixels.length === 0) {
    return true;
  }

  const meta = readImageMetadataFromHeader(buffer);
  if (!meta) {
    return false;
  }
  const maxSide = Math.max(meta.width, meta.height);
  const pixels = meta.width * meta.height;
  return (
    (hardMaxSides.length === 0 || maxSide <= Math.min(...hardMaxSides)) &&
    (hardMaxPixels.length === 0 || pixels <= Math.min(...hardMaxPixels))
  );
}

function assertImageSatisfiesHardDimensionPolicy(
  buffer: Buffer,
  policy?: ImageCompressionPolicy,
): void {
  if (imageSatisfiesHardDimensionPolicy(buffer, policy)) {
    return;
  }
  const meta = readImageMetadataFromHeader(buffer);
  const detail = meta ? `: ${meta.width}x${meta.height}` : "";
  throw new Error(`Image dimensions exceed model image limits${detail}`);
}

function resolvePreservableOriginalImageContentType(params: {
  buffer: Buffer;
  cap: number;
  contentType?: string;
  fileName?: string;
  policy?: ImageCompressionPolicy;
}): string | null {
  if (params.buffer.length > params.cap) {
    return null;
  }
  const declaredContentType = normalizeMimeType(params.contentType);
  const actualContentType = detectPreservableImageMime(params.buffer);
  if (!actualContentType) {
    return null;
  }
  const declaredPreservableContentType = isPreservableImageMime(declaredContentType)
    ? declaredContentType
    : undefined;
  if (declaredPreservableContentType && declaredPreservableContentType !== actualContentType) {
    return null;
  }
  if (declaredContentType?.startsWith("image/") && !declaredPreservableContentType) {
    return null;
  }
  const resolvedContentType = declaredPreservableContentType ?? actualContentType;
  if (isHeicSource({ contentType: resolvedContentType, fileName: params.fileName })) {
    return null;
  }
  const meta = readImageMetadataFromHeader(params.buffer);
  if (!meta) {
    return null;
  }
  const preferredSide =
    resolveImageCompressionGrid(params.policy).sides[0] ?? DEFAULT_VISION_MAX_SIDE;
  if (
    Math.max(meta.width, meta.height) > preferredSide ||
    !imageSatisfiesHardDimensionPolicy(params.buffer, params.policy)
  ) {
    return null;
  }
  return resolvedContentType;
}

function detectPreservableImageMime(
  buffer: Buffer,
): "image/png" | "image/jpeg" | "image/webp" | null {
  const format = readImageProbeFromHeader(buffer)?.format;
  return format === "png"
    ? "image/png"
    : format === "jpeg"
      ? "image/jpeg"
      : format === "webp"
        ? "image/webp"
        : null;
}

function isPreservableImageMime(
  contentType: string | undefined,
): contentType is "image/png" | "image/jpeg" | "image/webp" {
  return (
    contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp"
  );
}

/** Returns the stricter byte cap between caller limits and image compression policy limits. */
export function effectiveImageBytesCap(
  baseCap: number | undefined,
  policy?: ImageCompressionPolicy,
): number | undefined {
  const policyCap = imageMaxBytesForPolicy(policy);
  if (baseCap === undefined) {
    return policyCap;
  }
  return policyCap === undefined ? baseCap : Math.min(baseCap, policyCap);
}

function buildDescendingLadder(maxSide: number, values: readonly number[]): number[] {
  const normalizedMax = Math.max(1, Math.floor(maxSide));
  const ladder = uniqueValues(
    [normalizedMax, ...values, ...LOW_IMAGE_SIDE_FALLBACKS]
      .map((value) => Math.min(normalizedMax, value))
      .filter((value) => value > 0),
  ).toSorted((a, b) => b - a);
  if (ladder.length > 1 || normalizedMax <= 1) {
    return ladder;
  }
  const fallbackLadder = [
    normalizedMax,
    Math.floor(normalizedMax * 0.75),
    Math.floor(normalizedMax * 0.5),
    Math.floor(normalizedMax * 0.25),
  ];
  return uniqueValues(fallbackLadder.filter((value) => value > 0)).toSorted((a, b) => b - a);
}

/** Resolves the ordered max-side and JPEG quality search grid for an image compression policy. */
export function resolveImageCompressionGrid(policy?: ImageCompressionPolicy): {
  sides: number[];
  qualities: number[];
} {
  const preference = effectiveImageQualityPreference(policy);
  const side = sideForPreference(preference, policy);
  switch (preference) {
    case "efficient":
      return {
        sides: buildDescendingLadder(side, [1024, 800]),
        qualities: [70, 60, 50, 40],
      };
    case "high":
      return {
        sides: buildDescendingLadder(side, [3072, 2576, 2048, 1800, 1536, 1280, 1024, 800]),
        qualities: [92, 85, 78, 70, 62, 52, 42],
      };
    case "balanced":
      return {
        sides: buildDescendingLadder(side, [...DEFAULT_JPEG_SIDES]),
        qualities: [...DEFAULT_JPEG_QUALITIES],
      };
  }
  return {
    sides: buildDescendingLadder(side, [...DEFAULT_JPEG_SIDES]),
    qualities: [...DEFAULT_JPEG_QUALITIES],
  };
}

function logOptimizedImage(params: { originalSize: number; optimized: OptimizedImage }): void {
  if (!shouldLogVerbose()) {
    return;
  }
  if (params.optimized.optimizedSize >= params.originalSize) {
    return;
  }
  if (params.optimized.format === "png") {
    logVerbose(
      `Optimized PNG (preserving alpha) from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px)`,
    );
    return;
  }
  logVerbose(
    `Optimized media from ${formatMb(params.originalSize)}MB to ${formatMb(params.optimized.optimizedSize)}MB (side<=${params.optimized.resizeSide}px, q=${params.optimized.quality})`,
  );
}

async function optimizeImageWithFallback(params: {
  buffer: Buffer;
  cap: number;
  meta?: { contentType?: string; fileName?: string };
  imageCompression?: ImageCompressionPolicy;
}): Promise<OptimizedImage> {
  const { buffer, cap } = params;
  const grid = resolveImageCompressionGrid(params.imageCompression);
  const optimized = await createImageProcessor().encode(buffer, {
    format: "auto",
    maxBytes: cap,
    opaque: { format: "jpeg" },
    transparent: { format: "png" },
    search: {
      maxSide: grid.sides,
      quality: grid.qualities,
    },
    transparency: "auto",
  });
  if (optimized.chosen.transparency === "flattened" && shouldLogVerbose()) {
    logVerbose(`Image transparency flattened to fit ${formatMb(cap, 0)}MB optimization budget`);
  }
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    format: optimized.format,
    mimeType: optimized.mimeType,
    ...(optimized.chosen.quality === undefined ? {} : { quality: optimized.chosen.quality }),
    ...(optimized.chosen.compressionLevel === undefined
      ? {}
      : { compressionLevel: optimized.chosen.compressionLevel }),
  };
}

/** Optimizes image bytes for web-media delivery while preserving accepted original formats when possible. */
export async function optimizeImageBufferForWebMedia(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  maxBytes?: number;
  imageCompression?: ImageCompressionPolicy;
}): Promise<WebMediaResult> {
  const baseCap = params.maxBytes ?? maxBytesForKind("image");
  const cap = effectiveImageBytesCap(baseCap, params.imageCompression) ?? baseCap;
  if (params.contentType === "image/gif") {
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("GIF", cap, params.buffer.length));
    }
    assertImageSatisfiesHardDimensionPolicy(params.buffer, params.imageCompression);
    return {
      buffer: params.buffer,
      contentType: params.contentType,
      kind: "image",
      fileName: params.fileName,
    };
  }
  const meta = { contentType: params.contentType, fileName: params.fileName };
  const originalContentType = resolvePreservableOriginalImageContentType({
    buffer: params.buffer,
    cap,
    contentType: params.contentType,
    fileName: params.fileName,
    policy: params.imageCompression,
  });
  if (originalContentType) {
    return {
      buffer: params.buffer,
      contentType: originalContentType,
      kind: "image",
      fileName: params.fileName,
    };
  }
  const optimized = await optimizeImageWithFallback({
    buffer: params.buffer,
    cap,
    meta,
    imageCompression: params.imageCompression,
  });
  logOptimizedImage({ originalSize: params.buffer.length, optimized });
  if (optimized.buffer.length > cap) {
    throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
  }
  return {
    buffer: optimized.buffer,
    contentType: optimized.mimeType,
    kind: "image",
    fileName:
      optimized.format === "jpeg" && isHeicSource(params)
        ? toJpegFileName(params.fileName)
        : params.fileName,
  };
}

async function loadWebMediaInternal(
  mediaUrlInput: string,
  options: WebMediaOptions = {},
): Promise<WebMediaResult> {
  let mediaUrl = mediaUrlInput;
  const {
    maxBytes,
    optimizeImages = true,
    ssrfPolicy,
    proxyUrl,
    fetchImpl,
    requestInit,
    readIdleTimeoutMs,
    trustExplicitProxyDns,
    workspaceDir,
    localRoots,
    inboundRoots,
    sandboxValidated = false,
    readFile: readFileOverride,
    hostReadCapability = false,
    imageCompression,
  } = options;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);
  mediaUrl = (await resolveMediaStoreUriToPath(mediaUrl)) ?? mediaUrl;
  // Use fileURLToPath for proper handling of file:// URLs (handles file://localhost/path, etc.)
  if (mediaUrl.startsWith("file://")) {
    try {
      mediaUrl = safeFileURLToPath(mediaUrl);
    } catch (err) {
      throw new LocalMediaAccessError("invalid-file-url", (err as Error).message, { cause: err });
    }
  }
  mediaUrl =
    resolveCanvasHttpPathToLocalPath(mediaUrl) ??
    (await resolveHostedPluginMediaUrl(mediaUrl)) ??
    mediaUrl;
  mediaUrl = stripLegacyMediaDirectivePrefix(mediaUrl);

  const optimizeAndClampImage = async (
    buffer: Buffer,
    cap: number,
    meta?: { contentType?: string; fileName?: string },
  ) => {
    const originalSize = buffer.length;
    const optimized = await optimizeImageWithFallback({
      buffer,
      cap,
      meta,
      ...(imageCompression ? { imageCompression } : {}),
    });
    logOptimizedImage({ originalSize, optimized });

    if (optimized.buffer.length > cap) {
      throw new Error(formatCapReduce("Media", cap, optimized.buffer.length));
    }

    const fileName =
      optimized.format === "jpeg" && meta && isHeicSource(meta)
        ? toJpegFileName(meta.fileName)
        : meta?.fileName;

    return {
      buffer: optimized.buffer,
      contentType: optimized.mimeType,
      kind: "image" as const,
      fileName,
    };
  };

  const clampAndFinalize = async (params: {
    buffer: Buffer;
    contentType?: string;
    kind: MediaKind | undefined;
    fileName?: string;
    trustedGeneratedHtmlSource?: boolean;
  }): Promise<WebMediaResult> => {
    // If caller explicitly provides maxBytes, trust it (for channels that handle large files).
    // Otherwise fall back to per-kind defaults.
    const cap = maxBytes !== undefined ? maxBytes : maxBytesForKind(params.kind ?? "document");
    if (params.kind === "image") {
      const imageCap = effectiveImageBytesCap(cap, imageCompression) ?? cap;
      const isGif = params.contentType === "image/gif";
      if (isGif || !optimizeImages) {
        if (params.buffer.length > imageCap) {
          throw new Error(formatCapLimit(isGif ? "GIF" : "Media", imageCap, params.buffer.length));
        }
        assertImageSatisfiesHardDimensionPolicy(params.buffer, imageCompression);
        return {
          buffer: params.buffer,
          contentType: params.contentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      }
      const originalContentType = resolvePreservableOriginalImageContentType({
        buffer: params.buffer,
        cap: imageCap,
        contentType: params.contentType,
        fileName: params.fileName,
        policy: imageCompression,
      });
      if (originalContentType) {
        return {
          buffer: params.buffer,
          contentType: originalContentType,
          kind: params.kind,
          fileName: params.fileName,
        };
      }
      return {
        ...(await optimizeAndClampImage(params.buffer, imageCap, {
          contentType: params.contentType,
          fileName: params.fileName,
        })),
      };
    }
    if (params.buffer.length > cap) {
      throw new Error(formatCapLimit("Media", cap, params.buffer.length));
    }
    return {
      buffer: params.buffer,
      contentType: params.contentType ?? undefined,
      kind: params.kind,
      fileName: params.fileName,
      ...(params.trustedGeneratedHtmlSource ? { trustedGeneratedHtmlSource: true } : {}),
    };
  };

  if (hasHttpUrlPrefix(mediaUrl)) {
    // Enforce a download cap during fetch to avoid unbounded memory usage.
    // For optimized images, allow fetching larger payloads before compression.
    const defaultFetchCap = maxBytesForKind("document");
    const fetchCap =
      maxBytes === undefined
        ? defaultFetchCap
        : optimizeImages
          ? Math.max(maxBytes, defaultFetchCap)
          : maxBytes;
    const dispatcherPolicy: PinnedDispatcherPolicy | undefined = proxyUrl
      ? {
          mode: "explicit-proxy",
          proxyUrl,
          allowPrivateProxy: true,
        }
      : undefined;
    const fetched = await readRemoteMediaBuffer({
      url: mediaUrl,
      fetchImpl,
      requestInit,
      readIdleTimeoutMs,
      maxBytes: fetchCap,
      ssrfPolicy,
      dispatcherPolicy,
      trustExplicitProxyDns,
    });
    const { buffer, contentType, fileName } = fetched;
    const kind = kindFromMime(contentType);
    return await clampAndFinalize({ buffer, contentType, kind, fileName });
  }

  // Expand tilde paths to absolute paths (e.g., ~/Downloads/photo.jpg)
  if (mediaUrl.startsWith("~")) {
    mediaUrl = resolveUserPath(mediaUrl);
  }
  if (workspaceDir && !path.isAbsolute(mediaUrl) && !WINDOWS_DRIVE_RE.test(mediaUrl)) {
    mediaUrl = path.resolve(workspaceDir, mediaUrl);
  }
  try {
    assertNoWindowsNetworkPath(mediaUrl, "Local media path");
  } catch (err) {
    throw new LocalMediaAccessError("network-path-not-allowed", (err as Error).message, {
      cause: err,
    });
  }

  if ((sandboxValidated || localRoots === "any") && !readFileOverride) {
    throw new LocalMediaAccessError(
      "unsafe-bypass",
      "Refusing localRoots bypass without readFile override. Use sandboxValidated with readFile, or pass explicit localRoots.",
    );
  }

  // Guard local reads against allowed directory roots to prevent file exfiltration.
  if (!(sandboxValidated || localRoots === "any")) {
    await assertLocalMediaAllowed(mediaUrl, localRoots, { inboundRoots });
  }

  const hostReadDeclaredMime = hostReadCapability
    ? normalizeMimeType(mimeTypeFromFilePath(mediaUrl))
    : undefined;
  const htmlTrust =
    hostReadDeclaredMime === "text/html"
      ? await resolveTrustedGeneratedHostReadHtml(mediaUrl)
      : undefined;
  if (hostReadDeclaredMime === "text/html" && !htmlTrust) {
    throw new LocalMediaAccessError("path-not-allowed", HOST_READ_DECLARED_TEXT_ERROR);
  }

  // Local path
  let data: Buffer;
  if (readFileOverride) {
    data = await readFileOverride(mediaUrl);
  } else {
    try {
      data = (await readLocalFileSafely({ filePath: mediaUrl })).buffer;
    } catch (err) {
      if (err instanceof FsSafeError) {
        if (err.code === "not-found") {
          throw new LocalMediaAccessError("not-found", `Local media file not found: ${mediaUrl}`, {
            cause: err,
          });
        }
        if (err.code === "not-file") {
          throw new LocalMediaAccessError(
            "not-file",
            `Local media path is not a file: ${mediaUrl}`,
            { cause: err },
          );
        }
        throw new LocalMediaAccessError(
          "invalid-path",
          `Local media path is not safe to read: ${mediaUrl}`,
          { cause: err },
        );
      }
      throw err;
    }
  }
  const sniffedMime = await detectMime({ buffer: data });
  const mime = await detectMime({ buffer: data, filePath: mediaUrl });
  const kind = kindFromMime(mime);
  if (hostReadCapability) {
    assertHostReadMediaAllowed({
      sniffedContentType: sniffedMime,
      contentType: mime,
      filePath: mediaUrl,
      kind,
      buffer: data,
      trustedGeneratedHtmlPath: htmlTrust,
    });
  }
  let fileName = resolveLocalMediaFileName(mediaUrl);
  if (fileName && !extnameFromAnyPath(fileName) && mime) {
    const ext = extensionForMime(mime);
    if (ext) {
      fileName = `${fileName}${ext}`;
    }
  }
  return await clampAndFinalize({
    buffer: data,
    contentType: mime,
    kind,
    fileName,
    trustedGeneratedHtmlSource: Boolean(htmlTrust && hostReadDeclaredMime === "text/html"),
  });
}

/** Loads local, remote, hosted, or media-store media and optimizes images by default. */
export async function loadWebMedia(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: true }),
  );
}

/** Loads local, remote, hosted, or media-store media without image optimization. */
export async function loadWebMediaRaw(
  mediaUrl: string,
  maxBytesOrOptions?: number | WebMediaOptions,
  options?: { ssrfPolicy?: SsrFPolicy; localRoots?: readonly string[] | "any" },
): Promise<WebMediaResult> {
  return await loadWebMediaInternal(
    mediaUrl,
    resolveWebMediaOptions({ maxBytesOrOptions, options, optimizeImages: false }),
  );
}

/** Optimizes image bytes to JPEG under a target byte cap using the shared compression grid. */
export async function optimizeImageToJpeg(
  buffer: Buffer,
  maxBytes: number,
  opts: {
    contentType?: string;
    fileName?: string;
    imageCompression?: ImageCompressionPolicy;
  } = {},
): Promise<{
  buffer: Buffer;
  optimizedSize: number;
  resizeSide: number;
  quality: number;
}> {
  const { sides, qualities } = resolveImageCompressionGrid(opts.imageCompression);
  const optimized = await createImageProcessor().encode(buffer, {
    format: "auto",
    maxBytes,
    opaque: { format: "jpeg" },
    search: {
      maxSide: sides,
      quality: qualities,
    },
    transparency: "flatten",
  });
  return {
    buffer: optimized.data,
    optimizedSize: optimized.bytes,
    resizeSide: optimized.chosen.maxSide ?? Math.max(optimized.width, optimized.height),
    quality: optimized.chosen.quality ?? qualities.at(-1) ?? 85,
  };
}

export { optimizeImageToPng } from "./media-services.js";
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
