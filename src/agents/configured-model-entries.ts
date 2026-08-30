/** Projects effective configured model refs, aliases, and role tags for one agent. */
import { buildModelCatalogRef } from "@openclaw/model-catalog-core/model-catalog-refs";
import {
  resolveAgentModelFallbackValues,
  resolveAgentModelPrimaryValue,
} from "../config/model-input.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveAgentConfig } from "./agent-scope-config.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER } from "./defaults.js";
import { resolveConfiguredModelFallbacks } from "./model-selection-resolve.js";
import {
  buildModelAliasIndexCore as buildModelAliasIndex,
  inferUniqueProviderFromConfiguredModels,
  type ModelAliasIndex,
  type ModelSelectionNormalizationContext,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "./model-selection-shared.js";

type ConfiguredModelEntry = {
  key: string;
  ref: { provider: string; model: string };
  tags: Set<string>;
  aliases: string[];
  aliasDisabled: boolean;
};

export function resolveConfiguredModelEntries(
  params: {
    cfg: OpenClawConfig;
    agentId?: string;
    defaultProvider?: string;
    defaultModel?: string;
    allowManifestNormalization?: boolean;
    allowPluginNormalization?: boolean;
    canonicalizeRef?: <TRef extends { provider: string; model: string }>(ref: TRef) => TRef;
    aliasIndex?: ModelAliasIndex;
  } & ModelSelectionNormalizationContext,
): {
  entries: ConfiguredModelEntry[];
  byKey: Map<string, ConfiguredModelEntry>;
  defaultRef: { provider: string; model: string };
} {
  const defaultProvider = params.defaultProvider ?? DEFAULT_PROVIDER;
  const defaultModel = params.defaultModel ?? DEFAULT_MODEL;
  const resolvedDefault = resolveConfiguredModelRef({
    ...params,
    defaultProvider,
    defaultModel,
  });
  const aliasIndex =
    params.aliasIndex ??
    buildModelAliasIndex({
      ...params,
      defaultProvider,
    });
  const entriesByKey = new Map<string, ConfiguredModelEntry>();

  const addEntry = (ref: { provider: string; model: string }, tag: string) => {
    const canonicalRef = params.canonicalizeRef?.(ref) ?? ref;
    const key = buildModelCatalogRef(canonicalRef.provider, canonicalRef.model);
    const originalKey = buildModelCatalogRef(ref.provider, ref.model);
    const existing = entriesByKey.get(key);
    const aliases = [
      ...(existing?.aliases ?? []),
      ...(aliasIndex.byKey.get(key) ?? []),
      ...(originalKey === key ? [] : (aliasIndex.byKey.get(originalKey) ?? [])),
    ];
    const aliasDisabled =
      existing?.aliasDisabled === true ||
      aliasIndex.disabledKeys?.has(key) === true ||
      aliasIndex.disabledKeys?.has(originalKey) === true;
    if (existing) {
      existing.tags.add(tag);
      existing.aliases = [...new Set(aliases)];
      existing.aliasDisabled = aliasDisabled;
      return;
    }
    entriesByKey.set(key, {
      key,
      ref: canonicalRef,
      tags: new Set([tag]),
      aliases: [...new Set(aliases)],
      aliasDisabled,
    });
  };

  const addRaw = (raw: string, tag: string) => {
    const trimmed = raw.trim();
    const inferredProvider = trimmed.includes("/")
      ? undefined
      : inferUniqueProviderFromConfiguredModels({
          ...params,
          model: trimmed,
        });
    const resolved = resolveModelRefFromString({
      ...params,
      raw,
      defaultProvider: inferredProvider ?? defaultProvider,
      aliasIndex,
    });
    if (resolved) {
      addEntry(resolved.ref, tag);
    }
  };

  addEntry(resolvedDefault, "default");
  resolveConfiguredModelFallbacks({ cfg: params.cfg, agentId: params.agentId }).forEach(
    (raw, index) => addRaw(raw, `fallback#${index + 1}`),
  );

  // Image-model configuration remains global; per-agent image inheritance is
  // outside this projection's model-metadata contract.
  const imageModel = params.cfg.agents?.defaults?.imageModel;
  const imagePrimary = resolveAgentModelPrimaryValue(imageModel);
  if (imagePrimary) {
    addRaw(imagePrimary, "image");
  }
  resolveAgentModelFallbackValues(imageModel).forEach((raw, index) =>
    addRaw(raw, `img-fallback#${index + 1}`),
  );

  const agentModels = params.agentId
    ? resolveAgentConfig(params.cfg, params.agentId)?.models
    : undefined;
  const configuredRefs = new Set<string>();
  for (const models of [params.cfg.agents?.defaults?.models, agentModels]) {
    for (const raw of Object.keys(models ?? {})) {
      if (!raw.trim().endsWith("/*")) {
        configuredRefs.add(raw);
      }
    }
  }
  for (const raw of configuredRefs) {
    addRaw(raw, "configured");
  }

  return {
    defaultRef: resolvedDefault,
    entries: [...entriesByKey.values()],
    byKey: entriesByKey,
  };
}
