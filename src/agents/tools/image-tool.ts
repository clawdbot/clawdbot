import fs from "node:fs/promises";
import path from "node:path";

import {
  type Api,
  type AssistantMessage,
  type Context,
  complete,
  type Model,
} from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { MoltbotConfig } from "../../config/config.js";
import { resolveUserPath } from "../../utils.js";
import { loadWebMedia } from "../../web/media.js";
import { ensureAuthProfileStore, listProfilesForProvider } from "../auth-profiles.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "../defaults.js";
import { minimaxUnderstandImage } from "../minimax-vlm.js";
import { getApiKeyForModel, requireApiKey, resolveEnvApiKey } from "../model-auth.js";
import { runWithImageModelFallback } from "../model-fallback.js";
import { resolveConfiguredModelRef } from "../model-selection.js";
import { ensureMoltbotModelsJson } from "../models-config.js";
import { assertSandboxPath } from "../sandbox-paths.js";
import type { AnyAgentTool } from "./common.js";
import {
  coerceImageAssistantText,
  coerceImageModelConfig,
  decodeDataUrl,
  type ImageModelConfig,
  resolveProviderVisionModelFromConfig,
} from "./image-tool.helpers.js";

const DEFAULT_PROMPT = "Describe the image.";

export const __testing = {
  decodeDataUrl,
  coerceImageAssistantText,
} as const;

function resolveDefaultModelRef(cfg?: MoltbotConfig): {
  provider: string;
  model: string;
} {
  if (cfg) {
    const resolved = resolveConfiguredModelRef({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
      defaultModel: DEFAULT_MODEL,
    });
    return { provider: resolved.provider, model: resolved.model };
  }
  return { provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL };
}

function hasAuthForProvider(params: { provider: string; agentDir: string }): boolean {
  if (resolveEnvApiKey(params.provider)?.apiKey) return true;
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  return listProfilesForProvider(store, params.provider).length > 0;
}

/**
 * Resolve the effective image model config for the `image` tool.
 *
 * - Prefer explicit config (`agents.defaults.imageModel`).
 * - Otherwise, try to "pair" the primary model with an image-capable model:
 *   - same provider (best effort)
 *   - fall back to OpenAI/Anthropic when available
 */
export function resolveImageModelConfigForTool(params: {
  cfg?: MoltbotConfig;
  agentDir: string;
}): ImageModelConfig | null {
  // Note: We intentionally do NOT gate based on primarySupportsImages here.
  // Even when the primary model supports images, we keep the tool available
  // because images are auto-injected into prompts (see attempt.ts detectAndLoadPromptImages).
  // The tool description is adjusted via modelHasVision to discourage redundant usage.
  const explicit = coerceImageModelConfig(params.cfg);
  if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
    return explicit;
  }

  const primary = resolveDefaultModelRef(params.cfg);
  const openaiOk = hasAuthForProvider({
    provider: "openai",
    agentDir: params.agentDir,
  });
  const anthropicOk = hasAuthForProvider({
    provider: "anthropic",
    agentDir: params.agentDir,
  });

  const fallbacks: string[] = [];
  const addFallback = (modelRef: string | null) => {
    const ref = (modelRef ?? "").trim();
    if (!ref) return;
    if (fallbacks.includes(ref)) return;
    fallbacks.push(ref);
  };

  const providerVisionFromConfig = resolveProviderVisionModelFromConfig({
    cfg: params.cfg,
    provider: primary.provider,
  });
  const providerOk = hasAuthForProvider({
    provider: primary.provider,
    agentDir: params.agentDir,
  });

  let preferred: string | null = null;

  // MiniMax users: always try the canonical vision model first when auth exists.
  if (primary.provider === "minimax" && providerOk) {
    preferred = "minimax/MiniMax-VL-01";
  } else if (providerOk && providerVisionFromConfig) {
    preferred = providerVisionFromConfig;
  } else if (primary.provider === "openai" && openaiOk) {
    preferred = "openai/gpt-5-mini";
  } else if (primary.provider === "anthropic" && anthropicOk) {
    preferred = "anthropic/claude-opus-4-5";
  }

  if (preferred?.trim()) {
    if (openaiOk) addFallback("openai/gpt-5-mini");
    if (anthropicOk) addFallback("anthropic/claude-opus-4-5");
    // Don't duplicate primary in fallbacks.
    const pruned = fallbacks.filter((ref) => ref !== preferred);
    return {
      primary: preferred,
      ...(pruned.length > 0 ? { fallbacks: pruned } : {}),
    };
  }

  // Cross-provider fallback when we can't pair with the primary provider.
  if (openaiOk) {
    if (anthropicOk) addFallback("anthropic/claude-opus-4-5");
    return {
      primary: "openai/gpt-5-mini",
      ...(fallbacks.length ? { fallbacks } : {}),
    };
  }
  if (anthropicOk) {
    return { primary: "anthropic/claude-opus-4-5" };
  }

  return null;
}

function pickMaxBytes(cfg?: MoltbotConfig, maxBytesMb?: number): number | undefined {
  if (typeof maxBytesMb === "number" && Number.isFinite(maxBytesMb) && maxBytesMb > 0) {
    return Math.floor(maxBytesMb * 1024 * 1024);
  }
  const configured = cfg?.agents?.defaults?.mediaMaxMb;
  if (typeof configured === "number" && Number.isFinite(configured) && configured > 0) {
    return Math.floor(configured * 1024 * 1024);
  }
  return undefined;
}

function buildImageContext(prompt: string, base64: string, mimeType: string): Context {
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

async function resolveSandboxedImagePath(params: {
  sandboxRoot: string;
  imagePath: string;
}): Promise<{ resolved: string; rewrittenFrom?: string }> {
  const normalize = (p: string) => (p.startsWith("file://") ? p.slice("file://".length) : p);
  const filePath = normalize(params.imagePath);
  try {
    const out = await assertSandboxPath({
      filePath,
      cwd: params.sandboxRoot,
      root: params.sandboxRoot,
    });
    return { resolved: out.resolved };
  } catch (err) {
    const name = path.basename(filePath);
    const candidateRel = path.join("media", "inbound", name);
    const candidateAbs = path.join(params.sandboxRoot, candidateRel);
    try {
      await fs.stat(candidateAbs);
    } catch {
      throw err;
    }
    const out = await assertSandboxPath({
      filePath: candidateRel,
      cwd: params.sandboxRoot,
      root: params.sandboxRoot,
    });
    return { resolved: out.resolved, rewrittenFrom: filePath };
  }
}

async function runImagePrompt(params: {
  cfg?: MoltbotConfig;
  agentDir: string;
  imageModelConfig: ImageModelConfig;
  modelOverride?: string;
  prompt: string;
  base64: string;
  mimeType: string;
}): Promise<{
  text: string;
  provider: string;
  model: string;
  attempts: Array<{ provider: string; model: string; error: string }>;
}> {
  const effectiveCfg: MoltbotConfig | undefined = params.cfg
    ? {
        ...params.cfg,
        agents: {
          ...params.cfg.agents,
          defaults: {
            ...params.cfg.agents?.defaults,
            imageModel: params.imageModelConfig,
          },
        },
      }
    : undefined;

  await ensureMoltbotModelsJson(effectiveCfg, params.agentDir);
  const authStorage = discoverAuthStorage(params.agentDir);
  const modelRegistry = discoverModels(authStorage, params.agentDir);

  const result = await runWithImageModelFallback({
    cfg: effectiveCfg,
    modelOverride: params.modelOverride,
    run: async (provider, modelId) => {
      const model = modelRegistry.find(provider, modelId) as Model<Api> | null;
      if (!model) {
        throw new Error(`Unknown model: ${provider}/${modelId}`);
      }
      if (!model.input?.includes("image")) {
        throw new Error(`Model does not support images: ${provider}/${modelId}`);
      }
      const apiKeyInfo = await getApiKeyForModel({
        model,
        cfg: effectiveCfg,
        agentDir: params.agentDir,
      });
      const apiKey = requireApiKey(apiKeyInfo, model.provider);
      authStorage.setRuntimeApiKey(model.provider, apiKey);
      const imageDataUrl = `data:${params.mimeType};base64,${params.base64}`;

      if (model.provider === "minimax") {
        const text = await minimaxUnderstandImage({
          apiKey,
          prompt: params.prompt,
          imageDataUrl,
          modelBaseUrl: model.baseUrl,
        });
        return { text, provider: model.provider, model: model.id };
      }

      const context = buildImageContext(params.prompt, params.base64, params.mimeType);
      const message = (await complete(model, context, {
        apiKey,
        maxTokens: 512,
      })) as AssistantMessage;
      const text = coerceImageAssistantText({
        message,
        provider: model.provider,
        model: model.id,
      });
      return { text, provider: model.provider, model: model.id };
    },
  });

  return {
    text: result.result.text,
    provider: result.result.provider,
    model: result.result.model,
    attempts: result.attempts.map((attempt) => ({
      provider: attempt.provider,
      model: attempt.model,
      error: attempt.error,
    })),
  };
}

export function createImageTool(options?: {
  config?: MoltbotConfig;
  agentDir?: string;
  sandboxRoot?: string;
  /** If true, the model has native vision capability and images in the prompt are auto-injected */
  modelHasVision?: boolean;
}): AnyAgentTool | null {
  const agentDir = options?.agentDir?.trim();
  if (!agentDir) {
    const explicit = coerceImageModelConfig(options?.config);
    if (explicit.primary?.trim() || (explicit.fallbacks?.length ?? 0) > 0) {
      throw new Error("createImageTool requires agentDir when enabled");
    }
    return null;
  }
  const imageModelConfig = resolveImageModelConfigForTool({
    cfg: options?.config,
    agentDir,
  });
  if (!imageModelConfig) return null;

  // If model has native vision, images in the prompt are auto-injected
  // so this tool is only needed when image wasn't provided in the prompt
  const description = options?.modelHasVision
    ? "Analyze an image with a vision model. Only use this tool when the image was NOT already provided in the user's message. Images mentioned in the prompt are automatically visible to you."
    : "Analyze an image with the configured image model (agents.defaults.imageModel). Provide a prompt and image path or URL.";

  return {
    label: "Image",
    name: "image",
    description,
    parameters: Type.Object({
      prompt: Type.Optional(Type.String()),
      image: Type.String(),
      model: Type.Optional(Type.String()),
      maxBytesMb: Type.Optional(Type.Number()),
    }),
    execute: async (_toolCallId, args) => {
      const record = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
      const imageRawInput = typeof record.image === "string" ? record.image.trim() : "";
      const imageRaw = imageRawInput.startsWith("@")
        ? imageRawInput.slice(1).trim()
        : imageRawInput;
      if (!imageRaw) throw new Error("image required");

      // The tool accepts file paths, file/data URLs, or http(s) URLs. In some
      // agent/model contexts, images can be referenced as pseudo-URIs like
      // `image:0` (e.g. "first image in the prompt"). We don't have access to a
      // shared image registry here, so fail gracefully instead of attempting to
      // `fs.readFile("image:0")` and producing a noisy ENOENT.
      const looksLikeWindowsDrivePath = /^[a-zA-Z]:[\\/]/.test(imageRaw);
      const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(imageRaw);
      const isFileUrl = /^file:/i.test(imageRaw);
      const isHttpUrl = /^https?:\/\//i.test(imageRaw);
      const isDataUrl = /^data:/i.test(imageRaw);
      if (hasScheme && !looksLikeWindowsDrivePath && !isFileUrl && !isHttpUrl && !isDataUrl) {
        return {
          content: [
            {
              type: "text",
              text: `Unsupported image reference: ${imageRawInput}. Use a file path, a file:// URL, a data: URL, or an http(s) URL.`,
            },
          ],
          details: {
            error: "unsupported_image_reference",
            image: imageRawInput,
          },
        };
      }
      const promptRaw =
        typeof record.prompt === "string" && record.prompt.trim()
          ? record.prompt.trim()
          : DEFAULT_PROMPT;
      const modelOverride =
        typeof record.model === "string" && record.model.trim() ? record.model.trim() : undefined;
      const maxBytesMb = typeof record.maxBytesMb === "number" ? record.maxBytesMb : undefined;
      const maxBytes = pickMaxBytes(options?.config, maxBytesMb);

      const sandboxRoot = options?.sandboxRoot?.trim();
      const isUrl = isHttpUrl;
      if (sandboxRoot && isUrl) {
        throw new Error("Sandboxed image tool does not allow remote URLs.");
      }

      const resolvedImage = (() => {
        if (sandboxRoot) return imageRaw;
        if (imageRaw.startsWith("~")) return resolveUserPath(imageRaw);
        return imageRaw;
      })();
      const resolvedPathInfo: { resolved: string; rewrittenFrom?: string } = isDataUrl
        ? { resolved: "" }
        : sandboxRoot
          ? await resolveSandboxedImagePath({
              sandboxRoot,
              imagePath: resolvedImage,
            })
          : {
              resolved: resolvedImage.startsWith("file://")
                ? resolvedImage.slice("file://".length)
                : resolvedImage,
            };
      const resolvedPath = isDataUrl ? null : resolvedPathInfo.resolved;

      const media = isDataUrl
        ? decodeDataUrl(resolvedImage)
        : await loadWebMedia(resolvedPath ?? resolvedImage, maxBytes);
      if (media.kind !== "image") {
        throw new Error(`Unsupported media type: ${media.kind}`);
      }

      const mimeType =
        ("contentType" in media && media.contentType) ||
        ("mimeType" in media && media.mimeType) ||
        "image/png";
      const base64 = media.buffer.toString("base64");
      const result = await runImagePrompt({
        cfg: options?.config,
        agentDir,
        imageModelConfig,
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
          ...(resolvedPathInfo.rewrittenFrom
            ? { rewrittenFrom: resolvedPathInfo.rewrittenFrom }
            : {}),
          attempts: result.attempts,
        },
      };
    },
  };
}
