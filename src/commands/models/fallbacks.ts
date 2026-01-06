import {
  buildModelAliasIndex,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { CONFIG_PATH_CLAWDBOT, loadConfig } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  DEFAULT_PROVIDER,
  ensureFlagCompatibility,
  modelKey,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsFallbacksListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const fallbacks = cfg.agent?.model?.fallbacks ?? [];

  if (opts.json) {
    runtime.log(JSON.stringify({ fallbacks }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const entry of fallbacks) runtime.log(entry);
    return;
  }

  runtime.log(`Fallbacks (${fallbacks.length}):`);
  if (fallbacks.length === 0) {
    runtime.log("- none");
    return;
  }
  for (const entry of fallbacks) runtime.log(`- ${entry}`);
}

export async function modelsFallbacksAddCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const nextModels = { ...cfg.agent?.models };
    if (!nextModels[targetKey]) nextModels[targetKey] = {};
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agent?.model?.fallbacks ?? [];
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

    const existingModel = cfg.agent?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        model: {
          ...(existingModel?.primary
            ? { primary: existingModel.primary }
            : undefined),
          fallbacks: [...existing, targetKey],
        },
        models: nextModels,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(
    `Fallbacks: ${(updated.agent?.model?.fallbacks ?? []).join(", ")}`,
  );
}

export async function modelsFallbacksRemoveCommand(
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const targetKey = modelKey(resolved.provider, resolved.model);
    const aliasIndex = buildModelAliasIndex({
      cfg,
      defaultProvider: DEFAULT_PROVIDER,
    });
    const existing = cfg.agent?.model?.fallbacks ?? [];
    const filtered = existing.filter((entry) => {
      const resolvedEntry = resolveModelRefFromString({
        raw: String(entry ?? ""),
        defaultProvider: DEFAULT_PROVIDER,
        aliasIndex,
      });
      if (!resolvedEntry) return true;
      return (
        modelKey(resolvedEntry.ref.provider, resolvedEntry.ref.model) !==
        targetKey
      );
    });

    if (filtered.length === existing.length) {
      throw new Error(`Fallback not found: ${targetKey}`);
    }

    const existingModel = cfg.agent?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;

    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        model: {
          ...(existingModel?.primary
            ? { primary: existingModel.primary }
            : undefined),
          fallbacks: filtered,
        },
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(
    `Fallbacks: ${(updated.agent?.model?.fallbacks ?? []).join(", ")}`,
  );
}

export async function modelsFallbacksClearCommand(runtime: RuntimeEnv) {
  await updateConfig((cfg) => {
    const existingModel = cfg.agent?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        model: {
          ...(existingModel?.primary
            ? { primary: existingModel.primary }
            : undefined),
          fallbacks: [],
        },
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log("Fallback list cleared.");
}
