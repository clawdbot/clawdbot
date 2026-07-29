// Legacy provider runtime config migrations for plugin ids and bundled discovery policy.
import {
  defineLegacyConfigMigration,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { isRecord } from "./legacy-config-record-shared.js";
import {
  migrateLegacyXSearchConfig,
  resolveLegacyXSearchModelTarget,
} from "./legacy-x-search-migrate.js";

const LEGACY_OPENAI_CODEX_PLUGIN_ID = "openai-codex";
const OPENAI_PLUGIN_ID = "openai";
const LEGACY_CODEX_SUPERVISOR_PLUGIN_ID = "codex-supervisor";
const CODEX_PLUGIN_ID = "codex";

function normalizePluginIdForMigration(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toLowerCase() : undefined;
}

const X_SEARCH_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "apiKey"],
  message:
    'tools.web.x_search.apiKey moved to the xAI plugin; use plugins.entries.xai.config.webSearch.apiKey instead. Run "openclaw doctor --fix".',
};

const X_SEARCH_MODEL_RULE: LegacyConfigRule = {
  path: ["tools", "web", "x_search", "model"],
  message:
    'tools.web.x_search.model uses a retired xAI model; run "openclaw doctor --fix" to repair it.',
  requireSourceLiteral: true,
  match: (value) => resolveLegacyXSearchModelTarget(value) !== undefined,
};

function rewritePluginIdList(
  value: unknown,
  legacyPluginId: string,
  replacementPluginId?: string,
): { next: unknown; changed: boolean } {
  if (!Array.isArray(value)) {
    return { next: value, changed: false };
  }
  let changed = false;
  const seen = new Set<string>();
  const next: unknown[] = [];
  for (const entry of value) {
    const matchesLegacy = normalizePluginIdForMigration(entry) === legacyPluginId;
    if (matchesLegacy && replacementPluginId === undefined) {
      changed = true;
      continue;
    }
    const replacement = matchesLegacy ? replacementPluginId : entry;
    if (replacement !== entry) {
      changed = true;
    }
    if (typeof replacement === "string") {
      const normalizedReplacement = normalizePluginIdForMigration(replacement) ?? replacement;
      if (seen.has(normalizedReplacement)) {
        changed = true;
        continue;
      }
      seen.add(normalizedReplacement);
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
    const rewritten = rewritePluginIdList(
      plugins[key],
      LEGACY_OPENAI_CODEX_PLUGIN_ID,
      OPENAI_PLUGIN_ID,
    );
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

function migrateLegacyCodexSupervisorEntry(
  entries: Record<string, unknown>,
  legacySupervisorDenied: boolean,
): "migrated" | "removed-invalid" | null {
  const legacyEntryKey = Object.keys(entries).find(
    (key) => normalizePluginIdForMigration(key) === LEGACY_CODEX_SUPERVISOR_PLUGIN_ID,
  );
  if (!legacyEntryKey) {
    return null;
  }

  const rawLegacyEntry = entries[legacyEntryKey];
  if (!isRecord(rawLegacyEntry)) {
    delete entries[legacyEntryKey];
    return "removed-invalid";
  }
  const legacyEntry = rawLegacyEntry;
  const migratedEnabled = legacyEntry.enabled === true && !legacySupervisorDenied;

  const codexEntryKey =
    Object.keys(entries).find((key) => normalizePluginIdForMigration(key) === CODEX_PLUGIN_ID) ??
    CODEX_PLUGIN_ID;
  const rawCodexEntry = entries[codexEntryKey];
  let codexEntry: Record<string, unknown>;
  if (isRecord(rawCodexEntry)) {
    codexEntry = rawCodexEntry;
  } else {
    codexEntry = {};
    entries[codexEntryKey] = codexEntry;
  }
  // Top-level false disables the Codex harness too; inactive supervision must
  // stay nested while active migrated supervision explicitly activates Codex.
  if (migratedEnabled && codexEntry.enabled === undefined) {
    codexEntry.enabled = true;
  }

  const codexConfig = isRecord(codexEntry.config) ? codexEntry.config : {};
  codexEntry.config = codexConfig;
  const supervision = isRecord(codexConfig.supervision) ? codexConfig.supervision : {};
  codexConfig.supervision = supervision;

  const legacyConfig = isRecord(legacyEntry.config) ? legacyEntry.config : undefined;
  const migratedSupervision: Record<string, unknown> = {
    enabled: migratedEnabled,
  };
  if (Array.isArray(legacyConfig?.endpoints)) {
    migratedSupervision.endpoints = legacyConfig.endpoints;
  }
  if (typeof legacyConfig?.allowRawTranscripts === "boolean") {
    migratedSupervision.allowRawTranscripts = legacyConfig.allowRawTranscripts;
  }
  if (typeof legacyConfig?.allowWriteControls === "boolean") {
    migratedSupervision.allowWriteControls = legacyConfig.allowWriteControls;
  }
  mergeMissing(supervision, migratedSupervision);

  delete entries[legacyEntryKey];
  return "migrated";
}

function migrateLegacyCodexSupervisorPlugin(raw: Record<string, unknown>): string[] {
  const plugins = isRecord(raw.plugins) ? raw.plugins : undefined;
  if (!plugins) {
    return [];
  }

  const changes: string[] = [];
  const legacySupervisorDenied =
    Array.isArray(plugins.deny) &&
    plugins.deny.some(
      (entry) => normalizePluginIdForMigration(entry) === LEGACY_CODEX_SUPERVISOR_PLUGIN_ID,
    );
  const entries = isRecord(plugins.entries) ? plugins.entries : undefined;
  const entryMigration = entries
    ? migrateLegacyCodexSupervisorEntry(entries, legacySupervisorDenied)
    : null;
  if (entryMigration === "migrated") {
    changes.push(
      "Moved plugins.entries.codex-supervisor to plugins.entries.codex.config.supervision.",
    );
  } else if (entryMigration === "removed-invalid") {
    changes.push("Removed invalid plugins.entries.codex-supervisor config.");
  }

  const rewrittenAllow = rewritePluginIdList(
    plugins.allow,
    LEGACY_CODEX_SUPERVISOR_PLUGIN_ID,
    CODEX_PLUGIN_ID,
  );
  if (rewrittenAllow.changed) {
    plugins.allow = rewrittenAllow.next;
    changes.push("Rewrote plugins.allow codex-supervisor references to codex.");
  }

  // A Supervisor deny must not become a Codex deny because that would disable
  // the whole harness. The nested enabled flag now owns supervision policy.
  const rewrittenDeny = rewritePluginIdList(plugins.deny, LEGACY_CODEX_SUPERVISOR_PLUGIN_ID);
  if (rewrittenDeny.changed) {
    plugins.deny = rewrittenDeny.next;
    changes.push("Removed plugins.deny codex-supervisor references.");
  }

  return changes;
}

/** Legacy config migration specs for provider/plugin runtime config compatibility. */
export const LEGACY_CONFIG_MIGRATIONS_RUNTIME_PROVIDERS: LegacyConfigMigrationSpec[] = [
  defineLegacyConfigMigration({
    id: "plugins.codex-supervisor->plugins.codex.config.supervision",
    describe: "Move retired Codex Supervisor config into the Codex plugin",
    legacyRules: [
      {
        path: ["plugins"],
        message:
          'plugins.entries.codex-supervisor and related plugin policy references are retired; use plugins.entries.codex.config.supervision. Run "openclaw doctor --fix".',
        requireSourceLiteral: true,
        match: (_value, root) =>
          migrateLegacyCodexSupervisorPlugin(structuredClone(root)).length > 0,
      },
    ],
    apply: (raw, changes) => {
      changes.push(...migrateLegacyCodexSupervisorPlugin(raw));
    },
  }),
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
    id: "tools.web.x_search.apiKey->plugins.entries.xai.config.webSearch.apiKey",
    describe: "Move legacy x_search auth and repair retired xAI model defaults",
    legacyRules: [X_SEARCH_RULE, X_SEARCH_MODEL_RULE],
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
