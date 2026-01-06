import { CONFIG_PATH_CLAWDBOT } from "../../config/config.js";
import type { RuntimeEnv } from "../../runtime.js";
import { resolveModelTarget, updateConfig } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    const resolved = resolveModelTarget({ raw: modelRaw, cfg });
    const key = `${resolved.provider}/${resolved.model}`;
    const nextModels = { ...cfg.agent?.models };
    if (!nextModels[key]) nextModels[key] = {};
    const existingModel = cfg.agent?.model as
      | { primary?: string; fallbacks?: string[] }
      | undefined;
    return {
      ...cfg,
      agent: {
        ...cfg.agent,
        model: {
          ...(existingModel?.fallbacks
            ? { fallbacks: existingModel.fallbacks }
            : undefined),
          primary: key,
        },
        models: nextModels,
      },
    };
  });

  runtime.log(`Updated ${CONFIG_PATH_CLAWDBOT}`);
  runtime.log(`Default model: ${updated.agent?.model?.primary ?? modelRaw}`);
}
