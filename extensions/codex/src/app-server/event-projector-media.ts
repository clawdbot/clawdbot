import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { readItemString, readString } from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";
const BYTES_PER_MB = 1024 * 1024;
const DEFAULT_GENERATED_IMAGE_MAX_BYTES = 6 * BYTES_PER_MB;

export class CodexGeneratedMediaProjection {
  private readonly itemIds = new Set<string>();
  private readonly urlsByItemId = new Map<string, string>();

  constructor(private readonly config: EmbeddedRunAttemptParams["config"]) {}

  hasGeneratedMedia(): boolean {
    return this.itemIds.size > 0;
  }

  recordNative(item: CodexThreadItem | undefined): void {
    if (item?.type !== "imageGeneration") {
      return;
    }
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      this.recordUrl({ itemId: item.id, mediaUrl: savedPath });
    }
  }

  async recordRaw(item: JsonObject): Promise<void> {
    if (readString(item, "type") !== "image_generation_call") {
      return;
    }
    const result = readString(item, "result");
    if (!result) {
      return;
    }
    const itemId = readString(item, "id") ?? `raw-image-${this.itemIds.size}`;
    this.itemIds.add(itemId);
    const maxBytes = resolveGeneratedImageMaxBytes(this.config);
    const estimatedDecodedBytes = estimateBase64DecodedBytes(result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn("codex app-server raw image generation result exceeds media limit", {
        itemId,
        estimatedDecodedBytes,
        maxBytes,
      });
      return;
    }
    const asset = generatedImageAssetFromBase64({
      base64: result,
      index: this.itemIds.size,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      fileNamePrefix: "codex-image-generation",
      sniffMimeType: true,
    });
    if (!asset) {
      return;
    }
    try {
      const saved = await saveMediaBuffer(
        asset.buffer,
        asset.mimeType,
        GENERATED_IMAGE_MEDIA_SUBDIR,
        maxBytes,
        asset.fileName,
      );
      this.recordUrl({
        itemId,
        mediaUrl: saved.path,
        // The typed savedPath may belong to a remote app-server host. Always
        // prefer the copy persisted into this gateway's managed media root.
        replaceExisting: true,
      });
    } catch (error) {
      embeddedAgentLog.warn("codex app-server raw image generation result save failed", {
        itemId,
        error,
      });
    }
  }

  buildToolMediaUrls(params: {
    toolMediaUrls?: string[];
    messagingToolSentMediaUrls?: string[];
  }): string[] | undefined {
    const mediaUrls = new Set(params.toolMediaUrls?.map((url) => url.trim()).filter(Boolean) ?? []);
    if ((params.messagingToolSentMediaUrls?.length ?? 0) === 0) {
      for (const mediaUrl of this.urlsByItemId.values()) {
        mediaUrls.add(mediaUrl);
      }
    }
    return mediaUrls.size > 0 ? [...mediaUrls] : params.toolMediaUrls;
  }

  buildHostOwnedMediaUrls(params: { messagingToolSentMediaUrls?: string[] }): string[] | undefined {
    if ((params.messagingToolSentMediaUrls?.length ?? 0) > 0) {
      return undefined;
    }
    const mediaUrls = [...this.urlsByItemId.values()];
    return mediaUrls.length > 0 ? mediaUrls : undefined;
  }

  private recordUrl(params: { itemId: string; mediaUrl: string; replaceExisting?: boolean }): void {
    if (this.urlsByItemId.has(params.itemId) && params.replaceExisting !== true) {
      this.itemIds.add(params.itemId);
      return;
    }
    this.urlsByItemId.set(params.itemId, params.mediaUrl);
    this.itemIds.add(params.itemId);
  }
}

function estimateBase64DecodedBytes(base64: string): number | undefined {
  let nonWhitespaceLength = 0;
  let previousCode = -1;
  let lastCode = -1;
  for (let i = 0; i < base64.length; i += 1) {
    const code = base64.charCodeAt(i);
    if (isBase64WhitespaceCode(code)) {
      continue;
    }
    nonWhitespaceLength += 1;
    previousCode = lastCode;
    lastCode = code;
  }
  if (nonWhitespaceLength === 0) {
    return undefined;
  }
  const equalsCode = "=".charCodeAt(0);
  const padding = lastCode === equalsCode ? (previousCode === equalsCode ? 2 : 1) : 0;
  return Math.max(0, Math.floor((nonWhitespaceLength * 3) / 4) - padding);
}

function isBase64WhitespaceCode(code: number): boolean {
  return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

function resolveGeneratedImageMaxBytes(config: EmbeddedRunAttemptParams["config"]): number {
  const configured = config?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * BYTES_PER_MB);
  }
  return DEFAULT_GENERATED_IMAGE_MAX_BYTES;
}
