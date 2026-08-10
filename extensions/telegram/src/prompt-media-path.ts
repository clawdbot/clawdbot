import path from "node:path";

export function resolveTelegramInboundMediaUri(id: string): string | undefined {
  if (
    !id ||
    id === "." ||
    id === ".." ||
    id.includes("/") ||
    id.includes("\\") ||
    id.includes("\0")
  ) {
    return undefined;
  }
  return `media://inbound/${encodeURIComponent(id)}`;
}

function decodeInboundMediaId(id: string): string | undefined {
  try {
    return decodeURIComponent(id);
  } catch {
    return undefined;
  }
}

export function resolveTelegramPromptMediaPath(mediaPath: string): string | undefined {
  const canonicalMatch = /^media:\/\/inbound\/([^/\\]+)$/i.exec(mediaPath);
  if (canonicalMatch?.[1]) {
    const id = decodeInboundMediaId(canonicalMatch[1]);
    return id ? resolveTelegramInboundMediaUri(id) : undefined;
  }
  const normalized = mediaPath.replace(/\\/g, "/");
  if (!normalized.includes("/media/inbound/")) {
    return undefined;
  }
  return resolveTelegramInboundMediaUri(path.posix.basename(normalized));
}
