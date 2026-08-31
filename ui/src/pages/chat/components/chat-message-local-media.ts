import { buildAssistantMediaUrl } from "../../../app/assistant-media.ts";

export function isLocalAssistantAttachmentSource(source: string): boolean {
  const trimmed = source.trim();
  if (/^\/(?:__openclaw__|media|api\/chat\/media\/outgoing)\//.test(trimmed)) {
    return false;
  }
  return (
    isCanonicalInboundMediaSource(trimmed) ||
    /^file:/iu.test(trimmed) ||
    trimmed.startsWith("~") ||
    trimmed.startsWith("/") ||
    /^[a-zA-Z]:[\\/]/.test(trimmed)
  );
}

function isCanonicalInboundMediaSource(source: string): boolean {
  // Match the raw one-segment form first; URL parsing would erase dot segments.
  const match = /^media:\/\/inbound\/([^/?#]+)$/i.exec(source.trim());
  if (!match?.[1]) {
    return false;
  }
  try {
    const id = decodeURIComponent(match[1]);
    return (
      id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\") && !id.includes("\0")
    );
  } catch {
    return false;
  }
}

function normalizeLocalAttachmentPath(source: string): string | null {
  const trimmed = source.trim();
  if (!isLocalAssistantAttachmentSource(trimmed) || isCanonicalInboundMediaSource(trimmed)) {
    return null;
  }
  if (/^file:/iu.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      if (url.hostname || /%2f|%5c/iu.test(url.pathname)) {
        return null;
      }
      const pathname = decodeURIComponent(url.pathname);
      if (/^\/[a-zA-Z]:\//.test(pathname)) {
        return pathname.slice(1);
      }
      return pathname;
    } catch {
      return null;
    }
  }
  if (trimmed.startsWith("~")) {
    return null;
  }
  return trimmed;
}

function resolveHomeCandidatesFromRoots(localMediaPreviewRoots: readonly string[]): string[] {
  const candidates = new Set<string>();
  for (const root of localMediaPreviewRoots) {
    const normalized = canonicalizeLocalPathForComparison(root.trim());
    const unixHome = normalized.match(/^(\/Users\/[^/]+|\/home\/[^/]+)(?:\/|$)/);
    if (unixHome?.[1]) {
      candidates.add(unixHome[1]);
      continue;
    }
    const windowsHome = normalized.match(/^([a-z]:\/Users\/[^/]+)(?:\/|$)/i);
    if (windowsHome?.[1]) {
      candidates.add(windowsHome[1]);
    }
  }
  return [...candidates];
}

function canonicalizeLocalPathForComparison(value: string): string {
  let slashNormalized = value.replace(/\\/g, "/").replace(/\/+$/, "");
  if (/^\/[a-zA-Z]:\//.test(slashNormalized)) {
    slashNormalized = slashNormalized.slice(1);
  }
  if (/^[a-zA-Z]:\//.test(slashNormalized)) {
    return slashNormalized.toLowerCase();
  }
  return slashNormalized;
}

export function isLocalAttachmentPreviewAllowed(
  source: string,
  localMediaPreviewRoots: readonly string[],
): boolean {
  if (isCanonicalInboundMediaSource(source)) {
    return true;
  }
  const normalizedSource = normalizeLocalAttachmentPath(source);
  const comparableSources = normalizedSource
    ? [canonicalizeLocalPathForComparison(normalizedSource)]
    : source.trim().startsWith("~")
      ? resolveHomeCandidatesFromRoots(localMediaPreviewRoots).map((home) =>
          canonicalizeLocalPathForComparison(source.trim().replace(/^~(?=$|[\\/])/, () => home)),
        )
      : [];
  if (comparableSources.length === 0) {
    return false;
  }
  return localMediaPreviewRoots.some((root) => {
    const normalizedRoot = canonicalizeLocalPathForComparison(root.trim());
    return (
      normalizedRoot.length > 0 &&
      comparableSources.some(
        (comparableSource) =>
          comparableSource === normalizedRoot || comparableSource.startsWith(`${normalizedRoot}/`),
      )
    );
  });
}

export function buildAssistantAttachmentUrl(
  source: string,
  resourceBasePath?: string,
  mediaTicket?: string | null,
): string {
  if (!isLocalAssistantAttachmentSource(source)) {
    return source;
  }
  return buildAssistantMediaUrl(source, resourceBasePath, mediaTicket);
}

export function appendAttachmentUrlSearchParam(
  source: string,
  name: string,
  value: string,
): string {
  const trimmed = source.trim();
  if (!trimmed) {
    return trimmed;
  }
  const hashIndex = trimmed.indexOf("#");
  const hash = hashIndex === -1 ? "" : trimmed.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? trimmed : trimmed.slice(0, hashIndex);
  const queryIndex = withoutHash.indexOf("?");
  const path = queryIndex === -1 ? withoutHash : withoutHash.slice(0, queryIndex);
  const params = new URLSearchParams(queryIndex === -1 ? "" : withoutHash.slice(queryIndex + 1));
  params.set(name, value);
  return `${path}?${params.toString()}${hash}`;
}
