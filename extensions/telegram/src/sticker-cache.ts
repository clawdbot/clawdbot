import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/agent-runtime";
import type { ModelCatalogEntry } from "openclaw/plugin-sdk/agent-runtime";
import {
  findModelInCatalog,
  loadModelCatalog,
  modelSupportsVision,
} from "openclaw/plugin-sdk/agent-runtime";
import { resolveDefaultModelForAgent } from "openclaw/plugin-sdk/agent-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveAutoImageModel } from "openclaw/plugin-sdk/media-runtime";
import {
  resolveAutoMediaKeyProviders,
  resolveDefaultMediaModel,
} from "openclaw/plugin-sdk/media-runtime";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { getTelegramRuntime } from "./runtime.js";
export {
  cacheSticker,
  getAllCachedStickers,
  getCachedSticker,
  getCacheStats,
  searchStickers,
  type CachedSticker,
} from "./sticker-cache-store.js";

const STICKER_DESCRIPTION_PROMPT =
  "Describe this sticker image in 1-2 sentences. Focus on what the sticker depicts (character, object, action, emotion). Be concise and objective.";

export interface DescribeStickerParams {
  imagePath: string;
  cfg: OpenClawConfig;
  agentDir?: string;
  agentId?: string;
}

/**
 * Describe a sticker image using vision API.
 * Auto-detects an available vision provider based on configured API keys.
 * Returns null if no vision provider is available.
 */
export async function describeStickerImage(params: DescribeStickerParams): Promise<string | null> {
  const { imagePath, cfg, agentDir, agentId } = params;

  const defaultModel = resolveDefaultModelForAgent({ cfg, agentId });
  let activeModel = undefined as { provider: string; model: string } | undefined;
  let catalog: ModelCatalogEntry[] = [];
  try {
    catalog = await loadModelCatalog({ config: cfg });
    const entry = findModelInCatalog(catalog, defaultModel.provider, defaultModel.model);
    const supportsVision = modelSupportsVision(entry);
    if (supportsVision) {
      activeModel = { provider: defaultModel.provider, model: defaultModel.model };
    }
  } catch {
    // Ignore catalog failures; fall back to auto selection.
  }

  const hasProviderKey = async (provider: string) => {
    try {
      await resolveApiKeyForProvider({ provider, cfg, agentDir });
      return true;
    } catch {
      return false;
    }
  };

  const autoProviders = resolveAutoMediaKeyProviders({
    cfg,
    capability: "image",
  });

  const selectCatalogModel = (provider: string) => {
    const entries = catalog.filter(
      (entry) =>
        normalizeLowercaseStringOrEmpty(entry.provider) ===
          normalizeLowercaseStringOrEmpty(provider) && modelSupportsVision(entry),
    );
    if (entries.length === 0) {
      return undefined;
    }
    const defaultId = resolveDefaultMediaModel({
      cfg,
      providerId: provider,
      capability: "image",
    });
    const preferred = entries.find((entry) => entry.id === defaultId);
    return preferred ?? entries[0];
  };

  let resolved = null as { provider: string; model?: string } | null;
  if (
    activeModel &&
    autoProviders.includes(activeModel.provider) &&
    (await hasProviderKey(activeModel.provider))
  ) {
    resolved = activeModel;
  }

  if (!resolved) {
    for (const provider of autoProviders) {
      if (!(await hasProviderKey(provider))) {
        continue;
      }
      const entry = selectCatalogModel(provider);
      if (entry) {
        resolved = { provider, model: entry.id };
        break;
      }
    }
  }

  if (!resolved) {
    resolved = await resolveAutoImageModel({
      cfg,
      agentDir,
      activeModel,
    });
  }

  if (!resolved?.model) {
    logVerbose("telegram: no vision provider available for sticker description");
    return null;
  }

  const { provider, model } = resolved;
  logVerbose(`telegram: describing sticker with ${provider}/${model}`);

  try {
    const result = await getTelegramRuntime().mediaUnderstanding.describeImageFileWithModel({
      filePath: imagePath,
      mime: "image/webp",
      cfg,
      agentDir,
      provider,
      model,
      prompt: STICKER_DESCRIPTION_PROMPT,
      maxTokens: 150,
      timeoutMs: 30_000,
    });
    return result.text ?? null;
  } catch (err) {
    logVerbose(`telegram: failed to describe sticker: ${String(err)}`);
    return null;
  }
}
