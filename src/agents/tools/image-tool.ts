import {
  type Api,
  type AssistantMessage,
  type Context,
  complete,
  type Model,
} from "@mariozechner/pi-ai";
import {
  discoverAuthStorage,
  discoverModels,
} from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { ClawdbotConfig } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { loadWebMedia } from "../../web/media.js";
import { resolveClawdbotAgentDir } from "../agent-paths.js";
import { getApiKeyForModel } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { ensureClawdbotModelsJson } from "../models-config.js";
import { extractAssistantText } from "../pi-embedded-utils.js";
import type { AnyAgentTool } from "./common.js";

const DEFAULT_PROMPT = "Describe the image.";

function ensureImageToolConfigured(cfg?: ClawdbotConfig): boolean {
  const imageModel = cfg?.agent?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const primary =
    typeof imageModel === "string" ? imageModel.trim() : imageModel?.primary;
  const fallbacks =
    typeof imageModel === "object" ? (imageModel?.fallbacks ?? []) : [];
  return Boolean(primary?.trim() || fallbacks.length > 0);
}

function pickMaxBytes(
  cfg?: ClawdbotConfig,
  maxBytesMb?: number,
): number | undefined {
  if (
    typeof maxBytesMb === "number" &&
    Number.isFinite(maxBytesMb) &&
    maxBytesMb > 0
  ) {
    return Math.floor(maxBytesMb * 1024 * 1024);
  }
  const configured = cfg?.agent?.mediaMaxMb;
  if (
    typeof configured === "number" &&
    Number.isFinite(configured) &&
    configured > 0
  ) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function buildImageContext(
  prompt: string,
  base64: string,
  mimeType: string,
): Context {
  return {
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image", data: base64, mimeType },
        ],
        timestamp: Date.now(),
      },
    ],
  };
}

async function runImagePrompt(params: {
  cfg?: ClawdbotConfig;
  modelOverride?: string;
  prompt: string;
  base64: string;
  mimeType: string;
}): Promise<{ text: string; provider: string; model: string }> {
  const agentDir = resolveClawdbotAgentDir();
  await ensureClawdbotModelsJson(params.cfg);
  const authStorage = discoverAuthStorage(agentDir);
  const modelRegistry = discoverModels(authStorage, agentDir);

  const result = await runWithImageModelFallback({
    cfg: params.cfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }
      if (!model.input?.includes("image")) {
        throw new Error(
          `Model does not support images: ${provider}/${modelId}`,
        );
      }
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: params.cfg,
      });
      authStorage.setRuntimeApiKey(model.provider, apiKeyInfo.apiKey);
      const context = buildImageContext(
        params.prompt,
        params.base64,
        params.mimeType,
      );
      const message = (await complete(model, context, {
        apiKey: apiKeyInfo.apiKey,
        maxTokens: 512,
        temperature: 0,
      })) as AssistantMessage;
      return message;
    },
  });

  const text = extractAssistantText(result.result);
  return {
    text: text || "(no text returned)",
    provider: result.provider,
    model: result.model,
  };
}

export function createImageTool(options?: {
  config?: ClawdbotConfig;
}): AnyAgentTool | null {
  if (!ensureImageToolConfigured(options?.config)) return null;
  return {
    label: "Image",
    name: "image",
    description:
      "Analyze an image with the configured image model (agent.imageModel). Provide a prompt and image path or URL.",
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.String(),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      const imageRaw =
        typeof record.image === "string" ? record.image.trim() : "";
      if (!imageRaw) throw new Error("image required");
      const promptRaw =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;
      const modelOverride =
        typeof record.model === "string" && record.model.trim()
          ? record.model.trim()
          : undefined;
      const maxBytesMb =
        typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);

      const resolvedImage = imageRaw.startsWith("~")
        ? resolveUserPath(imageRaw)
        : imageRaw;
      const media = await loadWebMedia(resolvedImage, maxBytes);
      if (media.kind !== "image") {
        throw new Error(`Unsupported media type: ${media.kind}`);
      }

      const mimeType = media.contentType ?? "image/png";
      const base64 = media.buffer.toString("base64");
      const result = await runImagePrompt({
        cfg: options?.config,
        modelOverride,
        prompt: promptRaw,
        base64,
        mimeType,
      });
      return {
        content: [{ type: "text", text: result.text }],
        details: {
          model: `${result.provider}/${result.model}`,
          image: resolvedImage,
        },
      };
    },
  };
}
