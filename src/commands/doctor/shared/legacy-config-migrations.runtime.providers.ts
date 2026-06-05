// Legacy provider runtime config migrations for plugin ids and bundled discovery policy.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isRecord } from "./legacy-config-record-shared.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const LEGACY_OPENAI_CODEX_PLUGIN_ID = "openai-codex";
const OPENAI_PLUGIN_ID = "openai";

const BUNDLED_DISCOVERY_COMPAT_RULE: LegacyConfigRule = {
  path: ["plugins", "allow"],
  message:
    'plugins.allow now gates bundled provider discovery by default; run "openclaw doctor --fix" to preserve legacy bundled provider compatibility as plugins.bundledDiscovery="compat", or set plugins.bundledDiscovery="allowlist" to keep the stricter behavior.',
  requireSourceLiteral: true,
  match: (value, root) => {
    if (!Array.isArray(value) || value.length === 0) {
      return false;
    }
    const plugins = isRecord(root.plugins) ? root.plugins : undefined;
    return plugins?.bundledDiscovery === undefined;
  },
};

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

function rewritePluginIdList(value: unknown): { next: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { next: value, changed: false };
  }
  let changed = false;
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const entry of value) {
    const replacement = entry === LEGACY_OPENAI_CODEX_PLUGIN_ID ? OPENAI_PLUGIN_ID : entry;
    if (replacement !== entry) {
      changed = true;
    }
    if (typeof replacement === "string") {
      if (seen.has(replacement)) {
        changed = true;
        continue;
      }
      seen.add(replacement);
    }
    next.push(replacement);
  }
  return { next, changed };
}

function rewritePluginSlots(value: unknown): boolean {
  if (!isRecord(value)) {
    return false;
  }
  let changed = false;
  for (const [slot, pluginId] of Object.entries(value)) {
    if (pluginId === LEGACY_OPENAI_CODEX_PLUGIN_ID) {
      value[slot] = OPENAI_PLUGIN_ID;
      changed = true;
    }
  }
  return changed;
}

function rewritePluginEntries(value: unknown): boolean {
  if (!isRecord(value) || !(LEGACY_OPENAI_CODEX_PLUGIN_ID in value)) {
    return false;
  }
  if (!(OPENAI_PLUGIN_ID in value)) {
    value[OPENAI_PLUGIN_ID] = value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
  }
  delete value[LEGACY_OPENAI_CODEX_PLUGIN_ID];
  return true;
}

function rewriteLegacyOpenAICodexPluginPolicy(raw: Record<string, unknown>): string[] {
  const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
  if (!plugins) {
    return [];
  }
  const changes: string[] = [];
  for (const key of ["allow", "deny"] as const) {
    const rewritten = rewritePluginIdList(plugins[key]);
    if (rewritten.changed) {
      plugins[key] = rewritten.next;
      changes.push(`Rewrote plugins.${key} openai-codex references to openai.`);
    }
  }
  if (rewritePluginEntries(plugins.entries)) {
    changes.push("Rewrote plugins.entries.openai-codex to plugins.entries.openai.");
  }
  if (rewritePluginSlots(plugins.slots)) {
    changes.push("Rewrote plugins.slots openai-codex references to openai.");
  }
  return changes;
}

/** Legacy config migration specs for provider/plugin runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "plugins.openai-codex->plugins.openai",
    describe: "Rewrite retired OpenAI Codex plugin policy ids",
    legacyRules: [
      {
        path: ["plugins"],
        message:
          'plugins.openai-codex references are retired; use the openai plugin id. Run "openclaw doctor --fix".',
        requireSourceLiteral: true,
        match: (_value, root) =>
          rewriteLegacyOpenAICodexPluginPolicy(structuredClone(root)).length > 0,
      },
    ],
    apply: (raw, changes) => {
      changes.push(...rewriteLegacyOpenAICodexPluginPolicy(raw));
    },
  }),
  defineLegacyConfigMigration({
    id: "plugins.allow->plugins.bundledDiscovery.compat",
    describe: "Preserve bundled provider discovery for existing restrictive allowlists",
    legacyRules: [BUNDLED_DISCOVERY_COMPAT_RULE],
    apply: (raw, changes) => {
      const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
      if (!plugins || plugins.bundledDiscovery !== undefined) {
        return;
      }
      const allow = plugins.allow;
      if (!Array.isArray(allow) || allow.length === 0) {
        return;
      }
      plugins.bundledDiscovery = "compat";
      changes.push(
        'Set plugins.bundledDiscovery="compat" to preserve legacy bundled provider discovery for this restrictive plugins.allow config.',
      );
    },
  }),
  defineLegacyConfigMigration({
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    describe: "Move legacy x_search auth into the xAI plugin webSearch config",
    legacyRules: [X_SEARCH_RULE],
    apply: (raw, changes) => {
      const migrated = migrateLegacyXSearchConfig(raw);
      if (!migrated.changes.length) {
        return;
      }
      for (const key of Object.keys(raw)) {
        delete raw[key];
      }
      Object.assign(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
];
