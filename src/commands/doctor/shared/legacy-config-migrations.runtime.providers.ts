import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isRecord } from "./legacy-config-record-shared.js";
import { migrateLegacyXSearchConfig } from "./legacy-x-search-migrate.js";

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

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

export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "plugins.allow->plugins.bundledDiscovery.compat",
    describe: "Preserve legacy bundled provider discovery for existing restrictive allowlists",
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
