// Legacy web-search config migration from tools.web.search to plugin-owned config.
import {
  defineLegacyConfigMigration,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import {
  listLegacyWebSearchConfigPaths,
  migrateLegacyWebSearchConfig,
} from "./legacy-web-search-migrate.js";

const LEGACY_WEB_SEARCH_RULES: LegacyConfigRule[] = [
  {
    path: ["tools", "web", "search"],
    message:
      'tools.web.search provider-owned config moved to plugins.entries.<plugin>.config.webSearch. Run "openclaw doctor --fix".',
    match: (_value, root) => listLegacyWebSearchConfigPaths(root).length > 0,
    requireSourceLiteral: true,
  },
];

function replaceRootRecord(
  target: Record<string, unknown>,
  replacement: Record<string, unknown>,
): void {
  for (const key of Object.keys(target)) {
    delete target[key];
  }
  Object.assign(target, replacement);
}

/** Legacy config migration specs for web-search provider config. */
export const LEGACY_CONFIG_MIGRATIONS_WEB_SEARCH: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "tools.web.search-provider-config->plugins.entries",
    describe:
      "Move legacy tools.web.search provider-owned config into plugins.entries.<plugin>.config.webSearch",
    legacyRules: LEGACY_WEB_SEARCH_RULES,
    apply: (raw, changes) => {
      const migrated = migrateLegacyWebSearchConfig(raw);
      if (migrated.changes.length === 0) {
        return;
      }
      replaceRootRecord(raw, migrated.config);
      changes.push(...migrated.changes);
    },
  }),
];
