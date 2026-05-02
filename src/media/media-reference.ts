import path from "node:path";
import { safeFileURLToPath } from "../infra/local-file-access.js";
import { resolveUserPath } from "../utils.js";
import { getMediaDir, resolveMediaBufferPath } from "./store.js";

type MediaReferenceErrorCode = "invalid-path" | "path-not-allowed";

export class MediaReferenceError extends Error {
  code: MediaReferenceErrorCode;

  constructor(code: MediaReferenceErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.code = code;
    this.name = "MediaReferenceError";
  }
}

type InboundMediaReference = {
  id: string;
  normalizedSource: string;
  physicalPath: string;
  sourceType: "uri" | "path";
};

export function normalizeMediaReferenceSource(source: string): string {
  const trimmed = source.trim();
  if (/^media:\/\//i.test(trimmed)) {
    return trimmed;
  }
  return trimmed.replace(/^\s*MEDIA\s*:\s*/i, "").trim();
}

type MediaReferenceSourceInfo = {
  hasScheme: boolean;
  hasUnsupportedScheme: boolean;
  isDataUrl: boolean;
  isFileUrl: boolean;
  isHttpUrl: boolean;
  isMediaStoreUrl: boolean;
  looksLikeWindowsDrivePath: boolean;
};

export function classifyMediaReferenceSource(
  source: string,
  options?: { allowDataUrl?: boolean },
): MediaReferenceSourceInfo {
  const allowDataUrl = options?.allowDataUrl ?? true;
  const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(source);
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(source);
  const isFileUrl = /^file:/i.test(source);
  const isHttpUrl = /^https?:\/\//i.test(source);
  const isDataUrl = /^data:/i.test(source);
  const isMediaStoreUrl = /^media:\/\//i.test(source);
  const hasUnsupportedScheme =
    hasScheme &&
    !looksLikeWindowsDrivePath &&
    !isFileUrl &&
    !isHttpUrl &&
    !isMediaStoreUrl &&
    !(allowDataUrl && isDataUrl);
  return {
    hasScheme,
    hasUnsupportedScheme,
    isDataUrl,
    isFileUrl,
    isHttpUrl,
    isMediaStoreUrl,
    looksLikeWindowsDrivePath,
  };
}

function maybeLocalPathFromSource(source: string): string | null {
  if (/^file:/i.test(source)) {
    try {
      return safeFileURLToPath(source);
    } catch {
      return null;
    }
  }
  if (source.startsWith("~")) {
    return resolveUserPath(source);
  }
  if (path.isAbsolute(source)) {
    return source;
  }
  return null;
}

async function resolveInboundMediaUri(
  normalizedSource: string,
): Promise<InboundMediaReference | null> {
  if (!/^media:\/\//i.test(normalizedSource)) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(normalizedSource);
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (parsed.hostname !== "inbound") {
    throw new MediaReferenceError(
      "path-not-allowed",
      `Unsupported media URI location: ${parsed.hostname || "(missing)"}`,
    );
  }

  let id: string;
  try {
    id = decodeURIComponent(parsed.pathname.replace(/^\/+/, ""));
  } catch (err) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`, {
      cause: err,
    });
  }

  if (!id || id.includes("/") || id.includes("\\")) {
    throw new MediaReferenceError("invalid-path", `Invalid media URI: ${normalizedSource}`);
  }

  return {
    id,
    normalizedSource,
    physicalPath: await resolveInboundMediaPath(id, normalizedSource),
    sourceType: "uri",
  };
}

export async function resolveInboundMediaReference(
  source: string,
): Promise<InboundMediaReference | null> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  if (!normalizedSource) {
    return null;
  }

  const uriSource = await resolveInboundMediaUri(normalizedSource);
  if (uriSource) {
    return uriSource;
  }

  const localPath = maybeLocalPathFromSource(normalizedSource);
  if (!localPath) {
    return null;
  }

  const inboundDir = path.resolve(getMediaDir(), "inbound");
  const resolvedPath = path.resolve(localPath);
  const rel = path.relative(inboundDir, resolvedPath);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel) || rel.includes(path.sep)) {
    return null;
  }

  return {
    id: rel,
    normalizedSource,
    physicalPath: await resolveInboundMediaPath(rel, normalizedSource),
    sourceType: "path",
  };
}

export async function resolveMediaReferenceLocalPath(source: string): Promise<string> {
  const normalizedSource = normalizeMediaReferenceSource(source);
  return (await resolveInboundMediaReference(normalizedSource))?.physicalPath ?? normalizedSource;
}

async function resolveInboundMediaPath(id: string, source: string): Promise<string> {
  try {
    return await resolveMediaBufferPath(id, "inbound");
  } catch (err) {
    throw new MediaReferenceError(
      "invalid-path",
      err instanceof Error ? err.message : `Invalid media reference: ${source}`,
      { cause: err },
    );
  }
}
