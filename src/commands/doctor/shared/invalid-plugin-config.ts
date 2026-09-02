// Doctor quarantine for plugin entries whose config fails plugin-aware validation.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { sanitizeForLog } from "../../../../packages/terminal-core/src/ansi.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { validateConfigObjectWithPlugins } from "../../../config/validation.js";
import { findDoctorLegacyConfigIssues } from "./legacy-config-issues.js";

const PLUGIN_CONFIG_ISSUE_RE = /^plugins\.entries\.([^.]+)\.config(?:\.|$)/;

function scanInvalidPluginConfig(cfg: OpenClawConfig): Set<string> {
  const hits = new Set<string>();
  const validation = validateConfigObjectWithPlugins(cfg);
  if (validation.ok) {
    return hits;
  }
  const legacyIssues = findDoctorLegacyConfigIssues(cfg);
  for (const issue of validation.issues) {
    if (!issue.message.startsWith("invalid config:")) {
      continue;
    }
    const match = issue.path.match(PLUGIN_CONFIG_ISSUE_RE);
    const pluginId = match?.[1];
    if (!pluginId || hits.has(pluginId)) {
      continue;
    }
    // A pending owner migration may still need this invalid config as its source
    // locator. Quarantine must not delete the only way to discover state on retry.
    const configPath = `plugins.entries.${pluginId}.config`;
    if (
      legacyIssues.some(
        (legacy) => legacy.path === configPath || legacy.path.startsWith(`${configPath}.`),
      )
    ) {
      continue;
    }
    hits.add(pluginId);
  }
  return hits;
}

/** Disable plugin entries and clear config when plugin validation marks their config invalid. */
export function maybeRepairInvalidPluginConfig(cfg: OpenClawConfig): {
  config: OpenClawConfig;
  changes: string[];
} {
  const hits = scanInvalidPluginConfig(cfg);
  if (hits.size === 0) {
    return { config: cfg, changes: [] };
  }

  const next = structuredClone(cfg);
  const entries = asNullableRecord(next.plugins?.entries);
  if (!entries) {
    return { config: cfg, changes: [] };
  }

  const quarantined: string[] = [];
  for (const pluginId of hits) {
    const entry = asNullableRecord(entries[pluginId]);
    if (!entry) {
      continue;
    }
    if ("config" in entry) {
      delete entry.config;
    }
    entry.enabled = false;
    quarantined.push(pluginId);
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
