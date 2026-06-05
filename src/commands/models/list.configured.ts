/** Resolves configured model refs and tags for model-list rows. */
import {
  buildModelAliasIndex,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../../config/model-input.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.js";
import type { ConfiguredEntry } from "./list.types.js";
import { createModelCatalogProviderAliasCanonicalizer } from "./provider-aliases.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, modelKey } from "./shared.js";

const DISPLAY_MODEL_PARSE_OPTIONS = { allowPluginNormalization: false } as const;

/** Returns canonical configured model entries with default/fallback/image/configured tags. */
export function resolveConfiguredEntries(
  cfg: OpenClawConfig,
  metadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry">,
) {
  const resolvedDefault = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
    ...DISPLAY_MODEL_PARSE_OPTIONS,
  });
  const aliasIndex = buildModelAliasIndex({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    ...DISPLAY_MODEL_PARSE_OPTIONS,
  });
  const order: string[] = [];
  const tagsByKey = new Map<string, Set<string>>();
  const aliasesByKey = new Map<string, string[]>();
  const canonicalizeProviderAlias = createModelCatalogProviderAliasCanonicalizer({
    cfg,
    metadataSnapshot,
  });

  for (const [key, aliases] of aliasIndex.byKey.entries()) {
    aliasesByKey.set(key, aliases);
  }

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const canonicalRef = canonicalizeProviderAlias.ref(ref);
    const key = modelKey(canonicalRef.provider, canonicalRef.model);
    const originalKey = modelKey(ref.provider, ref.model);
    if (originalKey !== key) {
      // Preserve aliases attached to pre-canonical provider keys so display rows
      // still show user-facing aliases after catalog provider canonicalization.
      const aliases = aliasesByKey.get(originalKey);
      if (aliases) {
        aliasesByKey.set(key, [...new Set([...(aliasesByKey.get(key) ?? []), ...aliases])]);
      }
    }
    if (!tagsByKey.has(key)) {
      tagsByKey.set(key, new Set());
      order.push(key);
    }
    tagsByKey.get(key)?.add(tag);
  };

  const addResolvedModelRef = (raw: string, tag: string) => {
    const resolved = resolveModelRefFromString({
      raw,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });
    if (resolved) {
      addEntry(resolved.ref, tag);
    }
  };

  addEntry(resolvedDefault, "default");

  const modelFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.model);
  const imageFallbacks = resolveAgentModelFallbackValues(cfg.agents?.defaults?.imageModel);
  const imagePrimary = resolveAgentModelPrimaryValue(cfg.agents?.defaults?.imageModel) ?? "";

  modelFallbacks.forEach((raw, idx) => {
    addResolvedModelRef(raw, `fallback#${idx + 1}`);
  });

  if (imagePrimary) {
    addResolvedModelRef(imagePrimary, "image");
  }

  imageFallbacks.forEach((raw, idx) => {
    addResolvedModelRef(raw, `img-fallback#${idx + 1}`);
  });

  for (const key of Object.keys(cfg.agents?.defaults?.models ?? {})) {
    if (key.trim().endsWith("/*")) {
      continue;
    }
    const resolved = resolveModelRefFromString({
      cfg,
      raw: key,
      defaultProvider: DEFAULT_PROVIDER,
      aliasIndex,
      ...DISPLAY_MODEL_PARSE_OPTIONS,
    });
    if (!resolved) {
      continue;
    }
    addEntry(resolved.ref, "configured");
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
