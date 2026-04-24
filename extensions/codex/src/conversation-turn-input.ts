import path from "node:path";
import type { PluginHookInboundClaimEvent } from "openclaw/plugin-sdk/plugin-entry";
import type { CodexUserInput } from "./app-server/protocol.js";

type InboundMedia = {
  path?: string;
  url?: string;
  mimeType?: string;
};

const IMAGE_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export function buildCodexConversationTurnInput(params: {
  prompt: string;
  event: PluginHookInboundClaimEvent;
}): CodexUserInput[] {
  return [
    { type: "text", text: params.prompt, text_elements: [] },
    ...extractInboundMedia(params.event)
      .map(toCodexImageInput)
      .filter((item): item is CodexUserInput => item !== undefined),
  ];
}

function extractInboundMedia(event: PluginHookInboundClaimEvent): InboundMedia[] {
  const metadata = event.metadata ?? {};
  // OpenClaw channels expose either local staged files or remote URLs. Keep
  // them separate so Codex can receive the cheaper localImage input when a file
  // is already present, while still supporting remote-only transports.
  const paths = readStringArray(metadata.mediaPaths).concat(readStringArray(metadata.mediaPath));
  const urls = readStringArray(metadata.mediaUrls).concat(readStringArray(metadata.mediaUrl));
  const mimeTypes = readStringArray(metadata.mediaTypes).concat(
    readStringArray(metadata.mediaType),
  );
  const count = Math.max(paths.length, urls.length, mimeTypes.length);
  const media: InboundMedia[] = [];
  for (let index = 0; index < count; index += 1) {
    media.push({
      path: paths[index],
      url: urls[index],
      mimeType: mimeTypes[index] ?? mimeTypes[0],
    });
  }
  return media;
}

function toCodexImageInput(media: InboundMedia): CodexUserInput | undefined {
  if (!isImageMedia(media)) {
    return undefined;
  }
  if (media.path) {
    return { type: "localImage", path: normalizeFileUrl(media.path) };
  }
  return media.url ? { type: "image", url: media.url } : undefined;
}

function isImageMedia(media: InboundMedia): boolean {
  if (media.mimeType?.toLowerCase().startsWith("image/")) {
    return true;
  }
  const candidate = media.path ?? media.url;
  if (!candidate) {
    return false;
  }
  return IMAGE_EXTENSIONS.has(path.extname(candidate.split(/[?#]/, 1)[0] ?? "").toLowerCase());
}

function normalizeFileUrl(value: string): string {
  return value.startsWith("file://") ? new URL(value).pathname : value;
}

function readStringArray(value: unknown): string[] {
  if (typeof value === "string" && value.trim()) {
    return [value.trim()];
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}
