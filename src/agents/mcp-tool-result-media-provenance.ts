/** Host-only provenance for MCP attachments created after local staging. */
const HOST_OWNED_MCP_RELAY_MEDIA_TTL_MS = 10 * 60 * 1000;
const HOST_OWNED_MCP_RELAY_MEDIA_MAX_ENTRIES = 1024;

type HostOwnedMcpRelayMediaEntry = {
  fingerprint: string;
  expiresAt: number;
};

type HostOwnedMcpRelayMediaRegistry = Map<string, HostOwnedMcpRelayMediaEntry>;

const HOST_OWNED_MCP_RELAY_MEDIA_REGISTRY_SYMBOL = Symbol.for(
  "openclaw.mcp-relay-media-provenance.v1",
);

function isHostOwnedMcpRelayMediaRegistry(value: unknown): value is HostOwnedMcpRelayMediaRegistry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const candidate = value as {
    delete?: unknown;
    get?: unknown;
    keys?: unknown;
    set?: unknown;
    size?: unknown;
    [Symbol.iterator]?: unknown;
  };
  return (
    typeof candidate.delete === "function" &&
    typeof candidate.get === "function" &&
    typeof candidate.keys === "function" &&
    typeof candidate.set === "function" &&
    typeof candidate.size === "number" &&
    typeof candidate[Symbol.iterator] === "function"
  );
}

function getHostOwnedMcpRelayMediaRegistry(): HostOwnedMcpRelayMediaRegistry {
  const scope = process as typeof process & Record<symbol, unknown>;
  const existing = scope[HOST_OWNED_MCP_RELAY_MEDIA_REGISTRY_SYMBOL];
  if (isHostOwnedMcpRelayMediaRegistry(existing)) {
    return existing;
  }
  const registry: HostOwnedMcpRelayMediaRegistry = new Map();
  Object.defineProperty(scope, HOST_OWNED_MCP_RELAY_MEDIA_REGISTRY_SYMBOL, {
    value: registry,
    configurable: false,
    enumerable: false,
    writable: false,
  });
  return registry;
}

function attachmentFingerprint(value: unknown): { mediaUrl: string; fingerprint: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const attachment = value as Record<string, unknown>;
  if (
    (attachment.type !== "image" && attachment.type !== "audio") ||
    typeof attachment.mediaUrl !== "string" ||
    !attachment.mediaUrl.trim() ||
    typeof attachment.mimeType !== "string" ||
    !attachment.mimeType.trim() ||
    typeof attachment.name !== "string" ||
    !attachment.name.trim() ||
    typeof attachment.sizeBytes !== "number" ||
    !Number.isFinite(attachment.sizeBytes) ||
    attachment.sizeBytes < 0
  ) {
    return null;
  }
  const mediaUrl = attachment.mediaUrl.trim();
  return {
    mediaUrl,
    fingerprint: JSON.stringify([
      attachment.type,
      mediaUrl,
      attachment.mimeType.trim(),
      attachment.name.trim(),
      attachment.sizeBytes,
    ]),
  };
}

function pruneHostOwnedMcpRelayMedia(now: number): void {
  const hostOwnedMcpRelayMediaByUrl = getHostOwnedMcpRelayMediaRegistry();
  for (const [mediaUrl, entry] of hostOwnedMcpRelayMediaByUrl) {
    if (entry.expiresAt <= now) {
      hostOwnedMcpRelayMediaByUrl.delete(mediaUrl);
    }
  }
  while (hostOwnedMcpRelayMediaByUrl.size > HOST_OWNED_MCP_RELAY_MEDIA_MAX_ENTRIES) {
    const oldestUrl = hostOwnedMcpRelayMediaByUrl.keys().next().value as string | undefined;
    if (!oldestUrl) {
      break;
    }
    hostOwnedMcpRelayMediaByUrl.delete(oldestUrl);
  }
}

export function markHostOwnedMcpRelayMedia<T extends object>(media: T): T {
  const hostOwnedMcpRelayMediaByUrl = getHostOwnedMcpRelayMediaRegistry();
  const now = Date.now();
  pruneHostOwnedMcpRelayMedia(now);
  const attachments = (media as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments)) {
    return media;
  }
  for (const attachment of attachments) {
    const provenance = attachmentFingerprint(attachment);
    if (!provenance) {
      continue;
    }
    hostOwnedMcpRelayMediaByUrl.delete(provenance.mediaUrl);
    hostOwnedMcpRelayMediaByUrl.set(provenance.mediaUrl, {
      fingerprint: provenance.fingerprint,
      expiresAt: now + HOST_OWNED_MCP_RELAY_MEDIA_TTL_MS,
    });
  }
  pruneHostOwnedMcpRelayMedia(now);
  return media;
}

export function isHostOwnedMcpRelayMedia(media: unknown): media is object {
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    return false;
  }
  const attachments = (media as { attachments?: unknown }).attachments;
  if (!Array.isArray(attachments) || attachments.length === 0) {
    return false;
  }
  const now = Date.now();
  pruneHostOwnedMcpRelayMedia(now);
  const hostOwnedMcpRelayMediaByUrl = getHostOwnedMcpRelayMediaRegistry();
  return attachments.every((attachment) => {
    const provenance = attachmentFingerprint(attachment);
    if (!provenance) {
      return false;
    }
    const registered = hostOwnedMcpRelayMediaByUrl.get(provenance.mediaUrl);
    return (
      registered !== undefined &&
      registered.expiresAt > now &&
      registered.fingerprint === provenance.fingerprint
    );
  });
}
