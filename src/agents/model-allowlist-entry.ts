/**
 * Updates static model allowlist entries in agent defaults. Setup uses this
 * helper to keep both raw and canonical provider/model keys present.
 */
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_PROVIDER } from "./defaults.js";
import { resolveStaticAllowlistModelKey } from "./model-ref-shared.js";

/** Ensures a static model allowlist entry exists in agent defaults. */
export function ensureStaticModelAllowlistEntry(params: {
  cfg: OpenClawConfig;
  modelRef: string;
  defaultProvider?: string;
}): OpenClawConfig {
  const rawModelRef = params.modelRef.trim();
  if (!rawModelRef) {
    return params.cfg;
  }

  const models = { ...params.cfg.agents?.defaults?.models };
  const keySet = new Set<string>([rawModelRef]);
  const canonicalKey = resolveStaticAllowlistModelKey(
    rawModelRef,
    params.defaultProvider ?? DEFAULT_PROVIDER,
  );
  if (canonicalKey) {
    keySet.add(canonicalKey);
  }

  for (const key of keySet) {
    models[key] = {
      ...models[key],
    };
  }

  return {
    ...params.cfg,
    agents: {
      ...params.cfg.agents,
      defaults: {
        ...params.cfg.agents?.defaults,
        models,
      },
    },
  };
}
