import { buildModelAliasIndex, resolveModelRefFromString } from "../../agents/model-selection.js";
import { loadConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  modelKey,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsImageFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const fallbacks = cfg.agents?.defaults?.imageModel?.fallbacks ?? [];

  if (opts.json) {
    runtime.log(JSON.stringify({ fallbacks }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) runtime.log(entry);
    return;
  }

  runtime.log(`Image fallbacks (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) runtime.log(`- ${entry}`);
}

export async function modelsImageFallbacksAddCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const nextModels = { ...cfg.agents?.defaults?.models };
    if (!nextModels[targetKey]) nextModels[targetKey] = {};
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agents?.defaults?.imageModel?.fallbacks ?? [];
    const existingKeys = existing
      .map((entry) =>
        resolveModelRefFromString({
          raw: String(entry ?? ""),
          defaultProvider: DEFAULT_PROVIDER,
          aliasIndex,
        }),
      )
      .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
      .map((entry) => modelKey(entry.ref.provider, entry.ref.model));

    if (existingKeys.includes(targetKey)) return cfg;

    const existingModel = cfg.agents?.defaults?.imageModel as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          imageModel: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: [...existing, targetKey],
          },
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(
    `Image fallbacks: ${(updated.agents?.defaults?.imageModel?.fallbacks ?? []).join(", ")}`,
  );
}

export async function modelsImageFallbacksRemoveCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agents?.defaults?.imageModel?.fallbacks ?? [];
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: String(entry ?? ""),
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) return true;
      return modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !== targetKey;
    });

    if (filtered.length === existing.length) {
      throw new Error(`Image fallback not found: ${targetKey}`);
    }

    const existingModel = cfg.agents?.defaults?.imageModel as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          imageModel: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: filtered,
          },
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(
    `Image fallbacks: ${(updated.agents?.defaults?.imageModel?.fallbacks ?? []).join(", ")}`,
  );
}

export async function modelsImageFallbacksClearCommand(runtime: RuntimeEnv) {
  await updateConfig((cfg) => {
    const existingModel = cfg.agents?.defaults?.imageModel as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          imageModel: {
            ...(existingModel?.primary ? { primary: existingModel.primary } : undefined),
            fallbacks: [],
          },
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log("Image fallback list cleared.");
}
