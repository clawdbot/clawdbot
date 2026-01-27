import type { AssistantMessage } from "@mariozechner/pi-ai";

import type { MoltbotConfig } from "../../config/config.js";
import { extractAssistantText } from "../pi-embedded-utils.js";

export type ImageModelConfig = { primary?: string; fallbacks?: string[] };

export function decodeDataUrl(dataUrl: string): {
  buffer: Buffer;
  mimeType: string;
  kind: "image";
} {
  const trimmed = dataUrl.trim();
  const match = /^data:([^;,]+);base64,([a-z0-9+/=\r\n]+)$/i.exec(trimmed);
  if (!match) throw new Error("Invalid data URL (expected base64 data: URL).");
  const mimeType = (match[1] ?? "").trim().toLowerCase();
  if (!mimeType.startsWith("image/")) {
    throw new Error(`Unsupported data URL type: ${mimeType || "unknown"}`);
  }
  const b64 = (match[2] ?? "").trim();
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
  if (text.trim()) return text.trim();
  throw new Error(`Image model returned no text (${params.provider}/${params.model}).`);
}

export function coerceImageModelConfig(cfg?: MoltbotConfig): ImageModelConfig {
  const imageModel = cfg?.agents?.defaults?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const primary = typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
  const fallbacks = typeof imageModel === "object" ? (imageModel?.fallbacks ?? []) : [];
  return {
    ...(primary?.trim() ? { primary: primary.trim() } : {}),
    ...(fallbacks.length > 0 ? { fallbacks } : {}),
  };
}

export function resolveProviderVisionModelFromConfig(params: {
  cfg?: MoltbotConfig;
  provider: string;
}): string | null {
  const providerCfg = params.cfg?.models?.providers?.[params.provider] as unknown as
    | { models?: Array<{ id?: string; input?: string[] }> }
    | undefined;
  const models = providerCfg?.models ?? [];
  const preferMinimaxVl =
    params.provider === "minimax"
      ? models.find(
          (m) =>
            (m?.id ?? "").trim() === "MiniMax-VL-01" &&
            Array.isArray(m?.input) &&
            m.input.includes("image"),
        )
      : null;
  const picked =
    preferMinimaxVl ??
    models.find((m) => Boolean((m?.id ?? "").trim()) && m.input?.includes("image"));
  const id = (picked?.id ?? "").trim();
  return id ? `${params.provider}/${id}` : null;
}
