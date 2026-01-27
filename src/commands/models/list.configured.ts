import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import type { MoltbotConfig } from "../../config/config.js";
import type { ConfiguredEntry } from "./list.types.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, modelKey } from "./shared.js";

export function resolveConfiguredEntries(cfg: MoltbotConfig) {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
  });
  const order: string[] = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();

  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    aliasesByKey.set(key, aliases);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const key = modelKey(ref.provider, ref.model);
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push(key);
    }
    tagsByKey.get(key)?.add(tag);
  };

  addEntry(resolvedDefault, "default");

  const modelConfig = cfg.agents?.defaults?.model as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const imageModelConfig = cfg.agents?.defaults?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | undefined;
  const modelFallbacks = typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageFallbacks =
    typeof imageModelConfig === "object" ? (imageModelConfig?.fallbacks ?? []) : [];
  const imagePrimary = imageModelConfig?.primary?.trim() ?? "";

  modelFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    const resolved = resolveModelRefFromString({
      raw: imagePrimary,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (resolved) addEntry(resolved.ref, "image");
  }

  imageFallbacks.forEach((raw, idx) => {
    const resolved = resolveModelRefFromString({
      raw: String(raw ?? ""),
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
    });
    if (!resolved) return;
    addEntry(resolved.ref, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    const parsed = parseModelRef(String(key ?? ""), DEFAULT_PROVIDER);
    if (!parsed) continue;
    addEntry(parsed, "configured");
  }

  const entries: ConfiguredEntry[] = order.map((key) => {
    const slash = key.indexOf("/");
    const provider = slash === -1 ? key : key.slice(0, slash);
    const model = slash === -1 ? "" : key.slice(slash + 1);
    return {
      key,
      ref: { provider, model },
      tags: tagsByKey.get(key) ?? new Set(),
      aliases: aliasesByKey.get(key) ?? [],
    } satisfies ConfiguredEntry;
  });

  return { entries };
}
