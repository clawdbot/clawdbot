/** Commands for listing, adding, and removing model aliases. */
import { formatCliCommand } from "../../cli/command-format.js";
import { DEFAULT_MODEL_ALIASES } from "../../config/defaults.js";
import { logConfigUpdated } from "../../config/logging.js";
import { normalizeAgentModelMapForConfig } from "../../config/model-input.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";
import { normalizeAlias } from "./alias-name.js";
import { loadModelsConfig } from "./load-config.js";
import { ensureFlagCompatibility, resolveModelTarget, updateConfig } from "./shared.js";

/** Lists configured model aliases as JSON, plain pairs, or human-readable rows. */
export async function modelsAliasesListCommand(
  opts: { json?: boolean; plain?: boolean },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  const cfg = await loadModelsConfig({ commandName: "models aliases list", runtime });
  const models = cfg.agents?.defaults?.models ?? {};
  const aliases = Object.entries(models).reduce<Record<string, string>>(
    (acc, [modelKey, entry]) => {
      const alias = entry?.alias?.trim();
      if (alias) {
        acc[alias] = modelKey;
      }
      return acc;
    },
    {},
  );

  if (opts.json) {
    writeRuntimeJson(runtime, { aliases });
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

/** Adds or replaces an alias for a resolved provider/model target. */
export async function modelsAliasesAddCommand(
  aliasRaw: string,
  modelRaw: string,
  runtime: RuntimeEnv,
) {
  const alias = normalizeAlias(aliasRaw);
  const cfg = await loadModelsConfig({ commandName: "models aliases add", runtime });
  const resolved = resolveModelTarget({ raw: modelRaw, cfg });
  await updateConfig((cfgLocal) => {
    const modelKey = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfgLocal.agents?.defaults?.models };
    // Alias names are globally unique across model entries; otherwise command
    // input could resolve to different targets depending on config order.
    for (const [key, entry] of Object.entries(nextModels)) {
      const existing = entry?.alias?.trim();
      if (existing && existing === alias && key !== modelKey) {
        throw new Error(`Alias ${alias} already points to ${key}.`);
      }
    }
    const existing = nextModels[modelKey] ?? {};
    nextModels[modelKey] = { ...existing, alias };
    return {
      ...cfgLocal,
      agents: {
        ...cfgLocal.agents,
        defaults: {
          ...cfgLocal.agents?.defaults,
          models: nextModels,
        },
      },
    };
  });

  logConfigUpdated(runtime);
  runtime.log(`Alias ${alias} -> ${resolved.provider}/${resolved.model}`);
}

/** Removes a configured alias by name. */
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
      // A built-in alias is materialized into the resolved config by applyModelDefaults
      // when (a) the alias name is in DEFAULT_MODEL_ALIASES and (b) the target model
      // entry exists in the user's source config without an explicit alias set. In that
      // case the user sees the alias in `models aliases list` but it cannot be removed
      // because it isn't actually stored in the config file.
      //
      // applyModelDefaults materializes those aliases against the *normalized* model map
      // (provider ids and retired Google preview keys are canonicalized first), so an
      // entry whose only matching key is un-normalized still surfaces the alias in `list`.
      // Match that contract here so `remove` recognizes the same built-in aliases.
      const builtinTarget = DEFAULT_MODEL_ALIASES[alias];
      const normalizedModels = normalizeAgentModelMapForConfig(nextModels);
      if (
        builtinTarget &&
        normalizedModels[builtinTarget] &&
        normalizedModels[builtinTarget]?.alias === undefined
      ) {
        throw new Error(
          `Cannot remove "${alias}": it is a built-in alias for "${builtinTarget}" provided automatically by OpenClaw and is not stored in your config file. To shadow it with a different target, run ${formatCliCommand(`openclaw models aliases add ${alias} <model>`)}.`,
        );
      }
      throw new Error(
        `Alias not found: ${alias}. Run ${formatCliCommand("openclaw models aliases list")} to see configured aliases.`,
      );
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
