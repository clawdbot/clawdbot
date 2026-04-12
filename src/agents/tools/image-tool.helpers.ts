import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { estimateBase64DecodedBytes } from "../../media/base64.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { findNormalizedProviderValue } from "../model-selection.js";
import { extractAssistantText } from "../pi-embedded-utils.js";
import { coerceToolModelConfig, type ToolModelConfig } from "./model-config.helpers.js";

export type ImageModelConfig = ToolModelConfig;

export function decodeDataUrl(
  dataUrl: string,
  opts?: { maxBytes?: number },
): {
  buffer: Buffer;
  mimeType: string;
  kind: "image";
} {
  const trimmed = dataUrl.trim();
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
  if (!match) {
    throw new Error("Invalid data URL (expected base64 data: URL).");
  }
  const mimeType = normalizeLowercaseStringOrEmpty(match[1]);
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
  }
  const b64 = (match[2] ?? "").trim();
  if (typeof opts?.maxBytes === "number" && estimateBase64DecodedBytes(b64) > opts.maxBytes) {
    throw new Error("Invalid data URL: payload exceeds size limit.");
  }
  const buffer = Buffer.from(b64, "base64");
  if (buffer.length === 0) {
    throw new Error("Invalid data URL: empty payload.");
  }
  return { buffer, mimeType, kind: "image" };
}

export function coerceImageAssistantText(params: {
  message: AssistantMessage;
  provider: string;
  model: string;
}): string {
  const stop = params.message.stopReason;
  const errorMessage = params.message.errorMessage?.trim();
  if (stop === "error" || stop === "aborted") {
    throw new Error(
      errorMessage
        ? `Image model failed (${params.provider}/${params.model}): ${errorMessage}`
        : `Image model failed (${params.provider}/${params.model})`,
    );
  }
  if (errorMessage) {
    throw new Error(`Image model failed (${params.provider}/${params.model}): ${errorMessage}`);
  }
  const text = extractAssistantText(params.message);
  if (text.trim()) {
    return text.trim();
  }
  throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}

export function coerceImageModelConfig(cfg?: OpenClawConfig): ImageModelConfig {
  return coerceToolModelConfig(cfg?.agents?.defaults?.imageModel);
}

export function resolveProviderVisionModelFromConfig(params: {
  cfg?: OpenClawConfig;
  provider: string;
}): string | null {
  const providerCfg = findNormalizedProviderValue(
    params.cfg?.models?.providers,
    params.provider,
  ) as unknown as { models?: Array<{ id?: string; input?: string[] }> } | undefined;
  const models = providerCfg?.models ?? [];
  const picked = models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"));
  const id = (picked?.id ?? "").trim();
  return id ? `${params.provider}/${id}` : null;
}
