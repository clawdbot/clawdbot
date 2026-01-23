import { loadConfig } from "../../config/config.js";
import { logConfigUpdated } from "../../config/logging.js";
import type { RuntimeEnv } from "../../runtime.js";
import {
  ensureFlagCompatibility,
  normalizeAlias,
  resolveModelTarget,
  updateConfig,
} from "./shared.js";

export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = loadConfig();
  const models = cfg.agents?.defaults?.models ?? {};
  const aliases = Object.entries(models).reduce<Record<string, string>>(
    (acc, [modelKey, entry]) => {
      const alias = entry?.alias?.trim();
      if (alias) acc[alias] = modelKey;
      return acc;
    },
    {},
  );

  if (opts.json) {
    runtime.log(JSON.stringify({ aliases }, null, 2));
    return;
  }
  if (opts.plain) {
    for (const [alias, target] of Object.entries(aliases)) {
      runtime.log(`${alias} ${target}`);
    }
    return;
  }

  runtime.log(`Aliases (${Object.keys(aliases).length}):`);
  if (Object.keys(aliases).length === 0) {
    runtime.log("- none");
    return;
  }
  for (const [alias, target] of Object.entries(aliases)) {
    runtime.log(`- ${alias} -> ${target}`);
  }
}

export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const resolved = resolveModelTarget({ raw: modelRaw, cfg: loadConfig() });
  const _updated = await updateConfig((cfg) => {
    const modelKey = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agents?.defaults?.models };
    for (const [key, entry] of Object.entries(nextModels)) {
      const existing = entry?.alias?.trim();
      if (existing && existing === alias && key !== modelKey) {
        throw new Error(`Alias ${alias} already points to ${key}.`);
      }
    }
    const existing = nextModels[modelKey] ?? {};
    nextModels[modelKey] = { ...existing, alias };
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Alias ${alias} -> ${resolved.provider}/${resolved.model}`);
}

export async function modelsAliasesRemoveCommand(aliasRaw: string, runtime: RuntimeEnv) {
  const alias = normalizeAlias(aliasRaw);
  const updated = await updateConfig((cfg) => {
    const nextModels = { ...cfg.agents?.defaults?.models };
    let found = false;
    for (const [key, entry] of Object.entries(nextModels)) {
      if (entry?.alias?.trim() === alias) {
        nextModels[key] = { ...entry, alias: undefined };
        found = true;
        break;
      }
    }
    if (!found) {
      throw new Error(`Alias not found: ${alias}`);
    }
    return {
      ...cfg,
      agents: {
        ...cfg.agents,
        defaults: {
          ...cfg.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  if (
    !updated.agents?.defaults?.models ||
    Object.values(updated.agents.defaults.models).every((entry) => !entry?.alias?.trim())
  ) {
    runtime.log("No aliases configured.");
  }
}
