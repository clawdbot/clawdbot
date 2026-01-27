import type { Api, Model } from "@mariozechner/pi-ai";
import { discoverAuthStorage, discoverModels } from "@mariozechner/pi-coding-agent";

import { resolveMoltbotAgentDir } from "../../agents/agent-paths.js";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import { listProfilesForProvider } from "../../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveAwsSdkEnvVarName,
  resolveEnvApiKey,
} from "../../agents/model-auth.js";
import { ensureMoltbotModelsJson } from "../../agents/models-config.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { ModelRow } from "./list.types.js";
import { modelKey } from "./shared.js";

const isLocalBaseUrl = (baseUrl: string) => {
  try {
    const url = new URL(baseUrl);
    const host = url.hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host.endsWith(".local")
    );
  } catch {
    return false;
  }
};

const hasAuthForProvider = (provider: string, cfg: MoltbotConfig, authStore: AuthProfileStore) => {
  if (listProfilesForProvider(authStore, provider).length > 0) return true;
  if (provider === "amazon-bedrock" && resolveAwsSdkEnvVarName()) return true;
  if (resolveEnvApiKey(provider)) return true;
  if (getCustomProviderApiKey(cfg, provider)) return true;
  return false;
};

export async function loadModelRegistry(cfg: MoltbotConfig) {
  await ensureMoltbotModelsJson(cfg);
  const agentDir = resolveMoltbotAgentDir();
  const authStorage = discoverAuthStorage(agentDir);
  const registry = discoverModels(authStorage, agentDir);
  const models = registry.getAll() as Model<Api>[];
  const availableModels = registry.getAvailable() as Model<Api>[];
  const availableKeys = new Set(availableModels.map((model) => modelKey(model.provider, model.id)));
  return { registry, models, availableKeys };
}

export function toModelRow(params: {
  model?: Model<Api>;
  key: string;
  tags: string[];
  aliases?: string[];
  availableKeys?: Set<string>;
  cfg?: MoltbotConfig;
  authStore?: AuthProfileStore;
}): ModelRow {
  const { model, key, tags, aliases = [], availableKeys, cfg, authStore } = params;
  if (!model) {
    return {
      key,
      name: key,
      input: "-",
      contextWindow: null,
      local: null,
      available: null,
      tags: [...tags, "missing"],
      missing: true,
    };
  }

  const input = model.input.join("+") || "text";
  const local = isLocalBaseUrl(model.baseUrl);
  const available =
    cfg && authStore
      ? hasAuthForProvider(model.provider, cfg, authStore)
      : (availableKeys?.has(modelKey(model.provider, model.id)) ?? false);
  const aliasTags = aliases.length > 0 ? [`alias:${aliases.join(",")}`] : [];
  const mergedTags = new Set(tags);
  if (aliasTags.length > 0) {
    for (const tag of mergedTags) {
      if (tag === "alias" || tag.startsWith("alias:")) mergedTags.delete(tag);
    }
    for (const tag of aliasTags) mergedTags.add(tag);
  }

  return {
    key,
    name: model.name || model.id,
    input,
    contextWindow: model.contextWindow ?? null,
    local,
    available,
    tags: Array.from(mergedTags),
    missing: false,
  };
}
