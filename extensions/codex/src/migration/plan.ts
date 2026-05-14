import path from "node:path";
import {
  createMigrationItem,
  createMigrationManualItem,
  hasMigrationConfigPatchConflict,
  MIGRATION_REASON_TARGET_EXISTS,
  readMigrationConfigPath,
  summarizeMigrationItems,
} from "openclaw/plugin-sdk/migration";
import type {
  MigrationItem,
  MigrationPlan,
  MigrationProviderContext,
} from "openclaw/plugin-sdk/plugin-entry";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { exists, sanitizeName } from "./helpers.js";
import {
  codexPluginMigrationSubscriptionWarning,
  discoverCodexSource,
  hasCodexSource,
  type CodexPluginSource,
  type CodexSkillSource,
} from "./source.js";
import { resolveCodexMigrationTargets } from "./targets.js";

export const CODEX_PLUGIN_CONFIG_ITEM_ID = "config:codex-plugins";
export const CODEX_PLUGIN_CONFIG_PATH = ["plugins", "entries", "codex"] as const;
const CODEX_PLUGIN_ENABLED_PATH = ["plugins", "entries", "codex", "enabled"] as const;
const CODEX_PLUGIN_NATIVE_CONFIG_PATH = [
  "plugins",
  "entries",
  "codex",
  "config",
  "codexPlugins",
] as const;
const MIGRATION_REASON_PLUGIN_EXISTS = "plugin exists";
const CODEX_PLUGIN_SOURCE_APP_VERIFICATION_UNVERIFIED = "not_run";

export type CodexPluginMigrationConfigEntry = {
  configKey: string;
  pluginName: string;
  enabled: boolean;
};

type CodexPluginMigrationBlockSkipDetails = {
  pluginName: string;
  marketplaceName: typeof CODEX_PLUGINS_MARKETPLACE_NAME;
  apps?: NonNullable<CodexPluginSource["migrationBlock"]>["apps"];
  error?: string;
};

function uniqueSkillName(skill: CodexSkillSource, counts: Map<string, number>): string {
  const base = sanitizeName(skill.name) || "codex-skill";
  if ((counts.get(base) ?? 0) <= 1) {
    return base;
  }
  const parent = sanitizeName(path.basename(path.dirname(skill.source)));
  return sanitizeName(["codex", parent, base].filter(Boolean).join("-")) || base;
}

async function buildSkillItems(params: {
  skills: CodexSkillSource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const baseCounts = new Map<string, number>();
  for (const skill of params.skills) {
    const base = sanitizeName(skill.name) || "codex-skill";
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const resolvedCounts = new Map<string, number>();
  const planned = params.skills.map((skill) => {
    const name = uniqueSkillName(skill, baseCounts);
    resolvedCounts.set(name, (resolvedCounts.get(name) ?? 0) + 1);
    return { skill, name, target: path.join(params.workspaceDir, "skills", name) };
  });
  const items: MigrationItem[] = [];
  for (const item of planned) {
    const collides = (resolvedCounts.get(item.name) ?? 0) > 1;
    const targetExists = await exists(item.target);
    items.push(
      createMigrationItem({
        id: `skill:${item.name}`,
        kind: "skill",
        action: "copy",
        source: item.skill.source,
        target: item.target,
        status: collides ? "conflict" : targetExists && !params.overwrite ? "conflict" : "planned",
        reason: collides
          ? `multiple Codex skills normalize to "${item.name}"`
          : targetExists && !params.overwrite
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
        details: {
          skillName: item.name,
          sourceLabel: item.skill.sourceLabel,
        },
      }),
    );
  }
  return items;
}

function uniquePluginConfigKey(
  plugin: CodexPluginSource,
  counts: Map<string, number>,
  usedCounts: Map<string, number>,
): string {
  const base = sanitizeName(plugin.pluginName ?? plugin.name) || "codex-plugin";
  const total = counts.get(base) ?? 0;
  if (total <= 1) {
    return base;
  }
  const next = (usedCounts.get(base) ?? 0) + 1;
  usedCounts.set(base, next);
  return sanitizeName(`${base}-${next}`) || base;
}

function readExistingCodexPluginEntries(
  config: MigrationProviderContext["config"],
): Record<string, unknown> {
  const entries = readMigrationConfigPath(config as Record<string, unknown>, [
    ...CODEX_PLUGIN_NATIVE_CONFIG_PATH,
    "plugins",
  ]);
  return isRecord(entries) ? entries : {};
}

function hasExistingCodexPluginEntry(
  existingEntries: Record<string, unknown>,
  configKey: string,
  pluginName: string,
): boolean {
  if (existingEntries[configKey] !== undefined) {
    return true;
  }
  return Object.values(existingEntries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return entry.pluginName === pluginName;
  });
}

function buildPluginItems(
  ctx: MigrationProviderContext,
  plugins: readonly CodexPluginSource[],
): MigrationItem[] {
  const baseCounts = new Map<string, number>();
  for (const plugin of plugins.filter((entry) => entry.migratable)) {
    const base = sanitizeName(plugin.pluginName ?? plugin.name) || "codex-plugin";
    baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }
  const existingPluginEntries = readExistingCodexPluginEntries(ctx.config);
  const usedCounts = new Map<string, number>();
  let manualIndex = 0;
  const items: MigrationItem[] = [];
  for (const plugin of plugins) {
    if (
      plugin.migratable &&
      plugin.marketplaceName === CODEX_PLUGINS_MARKETPLACE_NAME &&
      plugin.pluginName
    ) {
      const configKey = uniquePluginConfigKey(plugin, baseCounts, usedCounts);
      const conflict =
        !ctx.overwrite &&
        hasExistingCodexPluginEntry(existingPluginEntries, configKey, plugin.pluginName);
      items.push(
        createMigrationItem({
          id: `plugin:${configKey}`,
          kind: "plugin",
          action: "install",
          status: conflict ? "conflict" : "planned",
          reason: conflict ? MIGRATION_REASON_PLUGIN_EXISTS : undefined,
          source: plugin.source,
          target: `plugins.entries.codex.config.codexPlugins.plugins.${configKey}`,
          message: `Install Codex plugin "${plugin.pluginName}" in the OpenClaw-managed Codex app-server runtime.`,
          details: {
            configKey,
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: plugin.pluginName,
            sourceInstalled: plugin.installed === true,
            sourceEnabled: plugin.enabled === true,
            ...(plugin.apps && plugin.apps.length > 0 && !shouldVerifyPluginApps(ctx)
              ? { sourceAppVerification: CODEX_PLUGIN_SOURCE_APP_VERIFICATION_UNVERIFIED }
              : {}),
          },
        }),
      );
      continue;
    }

    manualIndex += 1;
    if (plugin.migrationBlock && plugin.pluginName) {
      const details: CodexPluginMigrationBlockSkipDetails = {
        pluginName: plugin.pluginName,
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        ...(plugin.migrationBlock.apps ? { apps: plugin.migrationBlock.apps } : {}),
        ...(plugin.migrationBlock.error ? { error: plugin.migrationBlock.error } : {}),
      };
      items.push(
        createMigrationItem({
          id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${manualIndex}`,
          kind: "manual",
          action: "manual",
          source: plugin.source,
          status: "skipped",
          reason: plugin.migrationBlock.code,
          message:
            plugin.message ??
            `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
          details: { ...details },
        }),
      );
      continue;
    }
    items.push(
      createMigrationManualItem({
        id: `plugin:${sanitizeName(plugin.name) || sanitizeName(path.basename(plugin.source))}:${manualIndex}`,
        source: plugin.source,
        message:
          plugin.message ??
          `Codex native plugin "${plugin.name}" was found but not activated automatically.`,
        recommendation:
          "Review the plugin bundle first, then install trusted compatible plugins with openclaw plugins install <path>.",
      }),
    );
  }
  return items;
}

function shouldVerifyPluginApps(ctx: MigrationProviderContext): boolean {
  return ctx.providerOptions?.verifyPluginApps === true;
}

export function readCodexPluginMigrationConfigEntry(
  item: MigrationItem,
  enabled: boolean,
): CodexPluginMigrationConfigEntry | undefined {
  const configKey = item.details?.configKey;
  const marketplaceName = item.details?.marketplaceName;
  const pluginName = item.details?.pluginName;
  if (
    item.kind !== "plugin" ||
    item.action !== "install" ||
    typeof configKey !== "string" ||
    marketplaceName !== CODEX_PLUGINS_MARKETPLACE_NAME ||
    typeof pluginName !== "string"
  ) {
    return undefined;
  }
  return { configKey, pluginName, enabled };
}

function readExistingAllowDestructiveActions(
  config: MigrationProviderContext["config"],
): boolean | undefined {
  const value = readMigrationConfigPath(config as Record<string, unknown>, [
    ...CODEX_PLUGIN_NATIVE_CONFIG_PATH,
    "allow_destructive_actions",
  ]);
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function buildCodexPluginsConfigValue(
  entries: readonly CodexPluginMigrationConfigEntry[],
  params: {
    config?: MigrationProviderContext["config"];
  } = {},
): Record<string, unknown> {
  const plugins = Object.fromEntries(
    entries
      .toSorted((a, b) => a.configKey.localeCompare(b.configKey))
      .map((entry) => [
        entry.configKey,
        {
          enabled: entry.enabled,
          marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
          pluginName: entry.pluginName,
        },
      ]),
  );
  const config: Record<string, unknown> = {
    codexPlugins: {
      enabled: true,
      allow_destructive_actions:
        params.config === undefined
          ? true
          : (readExistingAllowDestructiveActions(params.config) ?? true),
      plugins,
    },
  };
  return {
    enabled: true,
    config,
  };
}

export function hasCodexPluginConfigConflict(
  config: MigrationProviderContext["config"],
  value: Record<string, unknown>,
): boolean {
  const enabled = readMigrationConfigPath(
    config as Record<string, unknown>,
    CODEX_PLUGIN_ENABLED_PATH,
  );
  if (enabled !== undefined && enabled !== true) {
    return true;
  }
  const nativeConfig = (value.config as Record<string, unknown> | undefined)?.codexPlugins;
  if (!isRecord(nativeConfig)) {
    return hasMigrationConfigPatchConflict(config, CODEX_PLUGIN_NATIVE_CONFIG_PATH, nativeConfig);
  }
  const existingNativeConfig = readMigrationConfigPath(
    config as Record<string, unknown>,
    CODEX_PLUGIN_NATIVE_CONFIG_PATH,
  );
  if (existingNativeConfig === undefined) {
    return false;
  }
  if (!isRecord(existingNativeConfig)) {
    return true;
  }
  if (existingNativeConfig.enabled !== undefined && existingNativeConfig.enabled !== true) {
    return true;
  }
  const allowDestructiveActions = nativeConfig.allow_destructive_actions;
  if (
    existingNativeConfig.allow_destructive_actions !== undefined &&
    existingNativeConfig.allow_destructive_actions !== allowDestructiveActions
  ) {
    return true;
  }
  const plugins = nativeConfig.plugins;
  if (!isRecord(plugins)) {
    return false;
  }
  return Object.entries(plugins).some(([configKey, plugin]) => {
    if (!isRecord(plugin)) {
      return existingNativeConfig[configKey] !== undefined;
    }
    return hasExistingCodexPluginEntry(
      readExistingCodexPluginEntries(config),
      configKey,
      typeof plugin.pluginName === "string" ? plugin.pluginName : configKey,
    );
  });
}

function buildPluginConfigItem(
  ctx: MigrationProviderContext,
  pluginItems: readonly MigrationItem[],
): MigrationItem | undefined {
  const entries = pluginItems
    .filter((item) => item.status === "planned")
    .map((item) => readCodexPluginMigrationConfigEntry(item, true))
    .filter((entry): entry is CodexPluginMigrationConfigEntry => entry !== undefined);
  if (entries.length === 0) {
    return undefined;
  }
  const value = buildCodexPluginsConfigValue(entries, { config: ctx.config });
  const conflict = !ctx.overwrite && hasCodexPluginConfigConflict(ctx.config, value);
  return createMigrationItem({
    id: CODEX_PLUGIN_CONFIG_ITEM_ID,
    kind: "config",
    action: "merge",
    target: "plugins.entries.codex.config.codexPlugins",
    status: conflict ? "conflict" : "planned",
    reason: conflict ? MIGRATION_REASON_TARGET_EXISTS : undefined,
    message:
      "Enable OpenClaw's Codex plugin integration and record migrated source-installed curated plugins.",
    details: {
      path: [...CODEX_PLUGIN_CONFIG_PATH],
      value,
    },
  });
}

export async function buildCodexMigrationPlan(
  ctx: MigrationProviderContext,
): Promise<MigrationPlan> {
  const targets = resolveCodexMigrationTargets(ctx);
  const source = await discoverCodexSource({
    input: ctx.source,
    evaluatePluginMigrationEligibility: true,
    verifyPluginApps: shouldVerifyPluginApps(ctx),
  });
  if (!hasCodexSource(source)) {
    throw new Error(
      `Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const items: MigrationItem[] = [];
  items.push(
    ...(await buildSkillItems({
      skills: source.skills,
      workspaceDir: targets.workspaceDir,
      overwrite: ctx.overwrite,
    })),
  );
  const pluginItems = buildPluginItems(ctx, source.plugins);
  items.push(...pluginItems);
  const pluginConfigItem = buildPluginConfigItem(ctx, pluginItems);
  if (pluginConfigItem) {
    items.push(pluginConfigItem);
  }
  for (const archivePath of source.archivePaths) {
    items.push(
      createMigrationItem({
        id: archivePath.id,
        kind: "archive",
        action: "archive",
        source: archivePath.path,
        message:
          archivePath.message ??
          "Archived in the migration report for manual review; not imported into live config.",
        details: { archiveRelativePath: archivePath.relativePath },
      }),
    );
  }
  const warnings = [
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting migration targets after item-level backups.",
        ]
      : []),
    ...(source.plugins.some((plugin) => plugin.migratable)
      ? [
          "Codex source-installed openai-curated plugins are planned for native activation; cached plugin bundles remain manual-review only.",
        ]
      : []),
    ...(source.plugins.some(
      (plugin) => plugin.migratable && plugin.apps && plugin.apps.length > 0,
    ) && !shouldVerifyPluginApps(ctx)
      ? [
          "Codex app-backed plugins were planned without source app accessibility verification. Re-run with --verify-plugin-apps to force a fresh source app/list check before planning native plugin activation.",
        ]
      : []),
    ...(source.pluginDiscoveryError
      ? [
          `Codex app-server plugin inventory discovery failed: ${source.pluginDiscoveryError}. Cached plugin bundles, if any, are advisory only.`,
        ]
      : []),
    ...(source.plugins.some(
      (plugin) => plugin.migrationBlock?.code === "codex_subscription_required",
    )
      ? [codexPluginMigrationSubscriptionWarning()]
      : []),
    ...(source.archivePaths.length > 0
      ? [
          "Codex config and hook files are archive-only. They are preserved in the migration report, not loaded into OpenClaw automatically.",
        ]
      : []),
  ];
  return {
    providerId: "codex",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: [
      "Run openclaw doctor after applying the migration.",
      "Review skipped or auth-required Codex plugin/config/hook items before exposing them in OpenClaw sessions.",
    ],
    metadata: {
      agentDir: targets.agentDir,
      codexHome: source.codexHome,
      codexSkillsDir: source.codexSkillsDir,
      personalAgentsSkillsDir: source.personalAgentsSkillsDir,
    },
  };
}
