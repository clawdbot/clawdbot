import {
  embeddedAgentLog,
  type EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { generatedImageAssetFromBase64 } from "openclaw/plugin-sdk/image-generation";
import { resolveGeneratedMediaMaxBytes } from "openclaw/plugin-sdk/media-generation-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { readItemString, readString } from "./event-projector-values.js";
import type { CodexThreadItem, JsonObject } from "./protocol.js";
import type { CodexRemoteWorkspaceFileReader } from "./remote-workspace-media.js";

const GENERATED_IMAGE_MEDIA_SUBDIR = "tool-image-generation";

export class CodexGeneratedMediaProjection {
  private readonly itemIds = new Set<string>();
  private readonly urlsByItemId = new Map<string, string>();
  private readonly gatewayMaterializedItemIds = new Set<string>();
  private readonly pendingMaterializationsByItemId = new Map<string, Promise<void>>();

  constructor(
    private readonly config: EmbeddedRunAttemptParams["config"],
    private readonly remote?: {
      remoteWorkspaceRoot?: string;
      readFile?: CodexRemoteWorkspaceFileReader;
      requestTimeoutMs?: number;
      signal?: AbortSignal;
    },
  ) {}

  hasGeneratedMedia(): boolean {
    return this.itemIds.size > 0;
  }

  async recordNative(item: CodexThreadItem | undefined): Promise<void> {
    if (item?.type !== "imageGeneration") {
      return;
    }
    // Image generation is already a billable side effect even if its remote
    // artifact cannot be transferred into this gateway's media store.
    this.itemIds.add(item.id);
    const result = readItemString(item, "result");
    if (result) {
      await this.recordImage({
        itemId: item.id,
        result,
        revisedPrompt: readItemString(item, "revisedPrompt"),
        source: "native",
      });
      return;
    }
    const savedPath = readItemString(item, "savedPath")?.trim();
    if (savedPath) {
      if (this.remote?.remoteWorkspaceRoot) {
        if (!this.remote.readFile) {
          embeddedAgentLog.warn("codex remote image has no app-server file transfer", {
            itemId: item.id,
          });
          return;
        }
        try {
          const response = await this.remote.readFile({
            path: savedPath,
            maxBytes: resolveGeneratedMediaMaxBytes(this.config, "image"),
            signal: this.remote.signal,
            timeoutMs: this.remote.requestTimeoutMs,
          });
          if (!response || typeof response.dataBase64 !== "string" || !response.dataBase64) {
            embeddedAgentLog.warn("codex remote image file returned no inline bytes", {
              itemId: item.id,
            });
            return;
          }
          await this.recordImage({
            itemId: item.id,
            result: response.dataBase64,
            revisedPrompt: readItemString(item, "revisedPrompt"),
            source: "native",
          });
        } catch (error) {
          embeddedAgentLog.warn("codex app-server remote image file read failed", {
            itemId: item.id,
            error,
          });
        }
        return;
      }
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
    await this.recordImage({
      itemId,
      result,
      revisedPrompt: readString(item, "revised_prompt") ?? readString(item, "revisedPrompt"),
      source: "raw",
    });
  }

  private async recordImage(params: {
    itemId: string;
    result: string;
    revisedPrompt?: string;
    source: "native" | "raw";
  }): Promise<void> {
    this.itemIds.add(params.itemId);
    if (this.gatewayMaterializedItemIds.has(params.itemId)) {
      return;
    }
    let pending = this.pendingMaterializationsByItemId.get(params.itemId);
    while (pending) {
      await pending;
      if (this.gatewayMaterializedItemIds.has(params.itemId)) {
        return;
      }
      // A malformed, oversized, or failed sibling event must not suppress a
      // valid completion carrying the same Codex image item.
      pending = this.pendingMaterializationsByItemId.get(params.itemId);
    }

    const materialization = this.materializeImage(params);
    this.pendingMaterializationsByItemId.set(params.itemId, materialization);
    try {
      await materialization;
    } finally {
      if (this.pendingMaterializationsByItemId.get(params.itemId) === materialization) {
        this.pendingMaterializationsByItemId.delete(params.itemId);
      }
    }
  }

  private async materializeImage(params: {
    itemId: string;
    result: string;
    revisedPrompt?: string;
    source: "native" | "raw";
  }): Promise<void> {
    const maxBytes = resolveGeneratedMediaMaxBytes(this.config, "image");
    const estimatedDecodedBytes = estimateBase64DecodedBytes(params.result);
    if (estimatedDecodedBytes !== undefined && estimatedDecodedBytes > maxBytes) {
      embeddedAgentLog.warn(
        `codex app-server ${params.source} image generation result exceeds media limit`,
        {
          itemId: params.itemId,
          estimatedDecodedBytes,
          maxBytes,
        },
      );
      return;
    }
    const asset = generatedImageAssetFromBase64({
      base64: params.result,
      index: this.itemIds.size,
      revisedPrompt: params.revisedPrompt,
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
      this.gatewayMaterializedItemIds.add(params.itemId);
      this.recordUrl({
        itemId: params.itemId,
        mediaUrl: saved.path,
        // Both Codex event shapes can carry a DevBox-local savedPath; channel
        // delivery must always use the copy materialized on this gateway.
        replaceExisting: true,
      });
    } catch (error) {
      embeddedAgentLog.warn(
        `codex app-server ${params.source} image generation result save failed`,
        {
          itemId: params.itemId,
          error,
        },
      );
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
