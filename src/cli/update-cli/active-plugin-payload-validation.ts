// Boot-local plugin payload verification without repair, install, or catalog imports.
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { PluginInstallRecord } from "../../config/types.plugins.js";
import { normalizePluginsConfig, resolveEffectiveEnableState } from "../../plugins/config-state.js";
import {
  resolveTrustedSourceLinkedOfficialClawHubSpec,
  resolveTrustedSourceLinkedOfficialNpmSpec,
} from "../../plugins/official-external-install-records.js";
import {
  runPluginPayloadSmokeCheck,
  type PluginPayloadSmokeResult,
} from "./plugin-payload-validation.js";

/** Runs the static payload check without repair, installs, or network access. */
export async function runActivePluginPayloadSmokeCheck(params: {
  cfg: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
  env: NodeJS.ProcessEnv;
}): Promise<PluginPayloadSmokeResult> {
  return await runPluginPayloadSmokeCheck({
    records: filterRecordsToActive({ cfg: params.cfg, records: params.records }),
    env: params.env,
  });
}

/** Selects the installed records covered by update/startup payload verification. */
export function filterRecordsToActive(params: {
  cfg: OpenClawConfig;
  records: Record<string, PluginInstallRecord>;
}): Record<string, PluginInstallRecord> {
  const normalizedPluginConfig = normalizePluginsConfig(params.cfg.plugins);
  const filtered: Record<string, PluginInstallRecord> = {};
  for (const [pluginId, record] of Object.entries(params.records)) {
    if (!record || typeof record !== "object") {
      continue;
    }
    const enableState = resolveEffectiveEnableState({
      id: pluginId,
      origin: "global",
      config: normalizedPluginConfig,
      rootConfig: params.cfg,
    });
    if (enableState.enabled) {
      filtered[pluginId] = record;
      continue;
    }
    // Trusted-source-linked official installs remain authoritative sync targets
    // even when their plugin entry is disabled.
    const officialNpm = resolveTrustedSourceLinkedOfficialNpmSpec({ pluginId, record });
    const officialClawHub = resolveTrustedSourceLinkedOfficialClawHubSpec({ pluginId, record });
    if (officialNpm || officialClawHub) {
      filtered[pluginId] = record;
    }
  }
  return filtered;
}
