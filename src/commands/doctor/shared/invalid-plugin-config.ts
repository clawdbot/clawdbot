import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { sanitizeForLog } from "../../../terminal/ansi.js";
import { asObjectRecord } from "./object.js";

type InvalidPluginConfigHit = {
  pluginId: string;
  pathLabel: string;
};

const PLUGIN_CONFIG_ISSUE_RE = /^plugins\.entries\.([^.]+)\.config(?:\.|$)/;

function scanInvalidPluginConfig(cfg: OpenClawConfig): InvalidPluginConfigHit[] {
  const validation = validateConfigObjectWithPlugins(cfg);
  if (validation.ok) {
    return [];
  }
  const hits: InvalidPluginConfigHit[] = [];
  const seen = new Set<string>();
  for (const issue of validation.issues) {
    if (!issue.message.startsWith("invalid config:")) {
      continue;
    }
    const match = issue.path.match(PLUGIN_CONFIG_ISSUE_RE);
    const pluginId = match?.[1];
    if (!pluginId || seen.has(pluginId)) {
      continue;
    }
    seen.add(pluginId);
    hits.push({
      pluginId,
      pathLabel: `plugins.entries.${pluginId}.config`,
    });
  }
  return hits;
}

export function maybeRepairInvalidPluginConfig(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanInvalidPluginConfig(cfg);
  if (hits.length === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const entries = asObjectRecord(next.plugins?.entries);
  if (!entries) {
    return { config: cfg, changes: [] };
  }

  const quarantined: string[] = [];
  for (const hit of hits) {
    const entry = asObjectRecord(entries[hit.pluginId]);
    if (!entry) {
      continue;
    }
    if ("config" in entry) {
      delete entry.config;
    }
    entry.enabled = false;
    quarantined.push(hit.pluginId);
  }

  if (quarantined.length === 0) {
    return { config: cfg, changes: [] };
  }

  return {
    config: next,
    changes: [
      sanitizeForLog(
        `- plugins.entries: quarantined ${quarantined.length} invalid plugin config${quarantined.length === 1 ? "" : "s"} (${quarantined.join(", ")})`,
      ),
    ],
  };
}
