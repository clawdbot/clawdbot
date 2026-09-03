// Codex plugin module implements plan behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  canonicalPathFromExistingAncestor,
  isPathInside,
} from "openclaw/plugin-sdk/file-access-runtime";
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
import { extractErrorCode } from "openclaw/plugin-sdk/security-runtime";
import { asBoolean, isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { CODEX_PLUGINS_MARKETPLACE_NAME } from "../app-server/config.js";
import { buildCodexAuthItems } from "./auth.js";
import { exists, sanitizeName } from "./helpers.js";
import type { CodexMemorySource, CodexSkillSource } from "./source-files.js";
import {
  codexPluginMigrationSubscriptionWarning,
  discoverCodexSource,
  hasCodexSource,
  type CodexPluginSource,
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
const MIGRATION_REASON_TARGET_NOT_REGULAR = "target is not a regular file";

export type CodexPluginMigrationConfigEntry = {
  configKey: string;
  pluginName: string;
  enabled: boolean;
  allowDestructiveActions?: "auto" | "ask";
};

async function lstatIfExists(filePath: string) {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    const code = extractErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return undefined;
    }
    throw error;
  }
}

async function buildCodexMemoryItems(params: {
  memoryFiles: readonly CodexMemorySource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const items: MigrationItem[] = [];
  for (const memory of params.memoryFiles) {
    const target = path.join(
      params.workspaceDir,
      "memory",
      "imports",
      "codex",
      path.basename(memory.path),
    );
    const targetStat = await lstatIfExists(target);
    const targetNotRegular = targetStat !== undefined && !targetStat.isFile();
    if (!targetNotRegular) {
      const [source, workspace, destination] = await Promise.all([
        fs.realpath(path.dirname(memory.path)),
        canonicalPathFromExistingAncestor(params.workspaceDir),
        canonicalPathFromExistingAncestor(target),
      ]);
      if (!isPathInside(workspace, destination)) {
        throw new Error("Codex memory import destination must stay in the selected workspace.");
      }
      if (isPathInside(source, destination) || isPathInside(destination, source)) {
        throw new Error(
          "Codex memory source and OpenClaw import destination must be separate paths.",
        );
      }
    }
    const targetConflict = targetStat !== undefined && !params.overwrite;
    items.push(
      createMigrationItem({
        id: memory.id,
        kind: "memory",
        action: "copy",
        source: memory.path,
        target,
        status: targetNotRegular || targetConflict ? "conflict" : "planned",
        reason: targetNotRegular
          ? MIGRATION_REASON_TARGET_NOT_REGULAR
          : targetConflict
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: "Copy consolidated Codex memory into the OpenClaw memory index.",
        details: {
          sourceType: "codex-memory",
          sourceLabel: memory.label,
          collectionId: "codex",
          collectionLabel: "Codex",
          relativePath: path.basename(memory.path),
        },
      }),
    );
  }
  return items;
}

function uniqueSkillName(skill: CodexSkillSource, counts: Map<string, number>): string {
  const base = sanitizeName(skill.name) || "codex-skill";
  if ((counts.get(base) ?? 0) <= 1) {
    return base;
  }
  const parent = sanitizeName(path.basename(path.dirname(skill.source)));
  return sanitizeName(["codex", parent, base].filter(Boolean).join("-")) || base;
}

async function buildCodexSkillItems(params: {
  skills: CodexSkillSource[];
  workspaceDir: string;
  overwrite?: boolean;
}): Promise<MigrationItem[]> {
  const counts = new Map<string, number>();
  for (const skill of params.skills) {
    const base = sanitizeName(skill.name) || "codex-skill";
    counts.set(base, (counts.get(base) ?? 0) + 1);
  }
  const planned = params.skills.map((skill) => {
    const name = uniqueSkillName(skill, counts);
    return { skill, name, target: path.join(params.workspaceDir, "skills", name) };
  });
  const resolvedCounts = planned.reduce((resolved, item) => {
    resolved.set(item.name, (resolved.get(item.name) ?? 0) + 1);
    return resolved;
  }, new Map<string, number>());
  return await Promise.all(
    planned.map(async (item) => {
      const collision = (resolvedCounts.get(item.name) ?? 0) > 1;
      const targetExists = await exists(item.target);
      const conflict = collision || (targetExists && !params.overwrite);
      return createMigrationItem({
        id: `skill:${item.name}`,
        kind: "skill",
        action: "copy",
        source: item.skill.source,
        target: item.target,
        status: conflict ? "conflict" : "planned",
        reason: collision
          ? `multiple Codex skills normalize to "${item.name}"`
          : conflict
            ? MIGRATION_REASON_TARGET_EXISTS
            : undefined,
        message: `Copy ${item.skill.sourceLabel} into this OpenClaw agent workspace.`,
        details: { skillName: item.name, sourceLabel: item.skill.sourceLabel },
      });
    }),
  );
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
  nextEntry: Record<string, unknown>,
): boolean {
  const existingEntry = existingEntries[configKey];
  if (existingEntry !== undefined) {
    return !isLegacyDestructivePolicyRepair(existingEntry, nextEntry);
  }
  return Object.values(existingEntries).some((entry) => {
    if (!isRecord(entry)) {
      return false;
    }
    return entry.pluginName === pluginName;
  });
}

function isLegacyDestructivePolicyRepair(
  existing: unknown,
  nextEntry: Record<string, unknown>,
): boolean {
  const existingEntry = isRecord(existing) ? existing : undefined;
  if (
    existingEntry?.allow_destructive_actions !== "on-request" ||
    nextEntry.allow_destructive_actions !== "auto"
  ) {
    return false;
  }
  const normalizedExisting = { ...existingEntry, allow_destructive_actions: "auto" };
  const normalizedEntries = Object.entries(normalizedExisting);
  return (
    normalizedEntries.length === Object.keys(nextEntry).length &&
    normalizedEntries.every(([key, value]) => nextEntry[key] === value)
  );
}

function readExistingPluginAllowDestructiveActions(
  existing: unknown,
  pluginName: string,
): "auto" | "ask" | undefined {
  const existingEntry = isRecord(existing) ? existing : undefined;
  if (existingEntry?.pluginName !== pluginName) {
    return undefined;
  }
  const normalized = normalizeExistingAllowDestructiveActions(
    existingEntry.allow_destructive_actions,
  );
  return normalized === "auto" || normalized === "ask" ? normalized : undefined;
}

function buildPluginItems(
  ctx: MigrationProviderContext,
  plugins: readonly CodexPluginSource[],
): MigrationItem[] {
  const existingPluginEntries = readExistingCodexPluginEntries(ctx.config);
  let manualIndex = 0;
  const items: MigrationItem[] = [];
  for (const plugin of plugins) {
    if (
      plugin.migratable &&
      plugin.marketplaceName === CODEX_PLUGINS_MARKETPLACE_NAME &&
      plugin.pluginName
    ) {
      const configKey = plugin.pluginName;
      const plannedEntry = {
        enabled: true,
        marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
        pluginName: plugin.pluginName,
        ...(() => {
          const allowDestructiveActions = readExistingPluginAllowDestructiveActions(
            existingPluginEntries[configKey],
            plugin.pluginName,
          );
          return allowDestructiveActions
            ? { allow_destructive_actions: allowDestructiveActions }
            : {};
        })(),
      };
      const conflict =
        !ctx.overwrite &&
        hasExistingCodexPluginEntry(
          existingPluginEntries,
          configKey,
          plugin.pluginName,
          plannedEntry,
        );
      items.push(
        createMigrationItem({
          id: `plugin:${configKey}`,
          kind: "plugin",
          action: "install",
          status: conflict ? "conflict" : "planned",
          reason: conflict ? MIGRATION_REASON_PLUGIN_EXISTS : undefined,
          applyPhase: "after-promotion",
          source: plugin.source,
          target: `plugins.entries.codex.config.codexPlugins.plugins.${configKey}`,
          message: `Install Codex plugin "${plugin.pluginName}" in the OpenClaw-managed Codex app-server runtime.`,
          details: {
            configKey,
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: plugin.pluginName,
            sourceInstalled: plugin.installed === true,
            sourceEnabled: plugin.enabled === true,
            ...(plannedEntry.allow_destructive_actions === "auto" ||
            plannedEntry.allow_destructive_actions === "ask"
              ? { allowDestructiveActions: plannedEntry.allow_destructive_actions }
              : {}),
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
          details: {
            pluginName: plugin.pluginName,
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            ...(plugin.migrationBlock.apps ? { apps: plugin.migrationBlock.apps } : {}),
            ...(plugin.migrationBlock.error ? { error: plugin.migrationBlock.error } : {}),
          },
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
          "Review the plugin bundle first, then install trusted compatible plugins with openclaw plugins install <path> --force.",
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
  const allowDestructiveActions = item.details?.allowDestructiveActions;
  return {
    configKey,
    pluginName,
    enabled,
    ...(allowDestructiveActions === "auto" || allowDestructiveActions === "ask"
      ? { allowDestructiveActions }
      : {}),
  };
}

function readExistingAllowDestructiveActions(
  config: MigrationProviderContext["config"],
): boolean | "auto" | "ask" | undefined {
  const value = readMigrationConfigPath(config as Record<string, unknown>, [
    ...CODEX_PLUGIN_NATIVE_CONFIG_PATH,
    "allow_destructive_actions",
  ]);
  return normalizeExistingAllowDestructiveActions(value);
}

function normalizeExistingAllowDestructiveActions(
  value: unknown,
): boolean | "auto" | "ask" | undefined {
  if (value === "auto" || value === "on-request") {
    return "auto";
  }
  if (value === "ask") {
    return "ask";
  }
  return asBoolean(value);
}

function readExistingPluginPolicyRepairs(
  config: MigrationProviderContext["config"],
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(readExistingCodexPluginEntries(config)).flatMap(([configKey, entry]) => {
      const pluginEntry = isRecord(entry) ? entry : undefined;
      if (pluginEntry?.allow_destructive_actions !== "on-request") {
        return [];
      }
      return [[configKey, { ...pluginEntry, allow_destructive_actions: "auto" }]];
    }),
  );
}

export function buildCodexPluginsConfigValue(
  entries: readonly CodexPluginMigrationConfigEntry[],
  config: MigrationProviderContext["config"],
): Record<string, unknown> {
  const plugins = {
    ...readExistingPluginPolicyRepairs(config),
    ...Object.fromEntries(
      entries
        .toSorted((a, b) => a.configKey.localeCompare(b.configKey))
        .map((entry) => [
          entry.configKey,
          {
            enabled: entry.enabled,
            marketplaceName: CODEX_PLUGINS_MARKETPLACE_NAME,
            pluginName: entry.pluginName,
            ...(entry.allowDestructiveActions
              ? { allow_destructive_actions: entry.allowDestructiveActions }
              : {}),
          },
        ]),
    ),
  };
  const pluginConfig: Record<string, unknown> = {
    codexPlugins: {
      enabled: true,
      allow_destructive_actions: readExistingAllowDestructiveActions(config) ?? true,
      plugins,
    },
  };
  return {
    enabled: true,
    config: pluginConfig,
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
  const existingAllowDestructiveActions = normalizeExistingAllowDestructiveActions(
    existingNativeConfig.allow_destructive_actions,
  );
  if (
    existingNativeConfig.allow_destructive_actions !== undefined &&
    existingAllowDestructiveActions !== allowDestructiveActions
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
      plugin,
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
  const value = buildCodexPluginsConfigValue(entries, ctx.config);
  const conflict = !ctx.overwrite && hasCodexPluginConfigConflict(ctx.config, value);
  return createMigrationItem({
    id: CODEX_PLUGIN_CONFIG_ITEM_ID,
    kind: "config",
    action: "merge",
    target: "plugins.entries.codex.config.codexPlugins",
    status: conflict ? "conflict" : "planned",
    reason: conflict ? MIGRATION_REASON_TARGET_EXISTS : undefined,
    applyPhase: "after-promotion",
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
  const memoryOnly =
    ctx.itemKinds !== undefined &&
    ctx.itemKinds.length > 0 &&
    ctx.itemKinds.every((kind) => kind === "memory");
  const source = await discoverCodexSource({
    input: ctx.source,
    memoryOnly,
    evaluatePluginMigrationEligibility: !memoryOnly,
    verifyPluginApps: shouldVerifyPluginApps(ctx),
  });
  if (!hasCodexSource(source)) {
    throw new Error(
      `Codex state was not found at ${source.root}. Pass --from <path> if it lives elsewhere.`,
    );
  }
  const items: MigrationItem[] = [];
  items.push(
    ...(await buildCodexMemoryItems({
      memoryFiles: source.memoryFiles,
      workspaceDir: targets.workspaceDir,
      overwrite: ctx.overwrite,
    })),
  );
  if (!memoryOnly) {
    items.push(...(await buildCodexAuthItems({ ctx, source, targets })));
    items.push(
      ...(await buildCodexSkillItems({
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
  }
  const warnings = [
    ...(!ctx.includeSecrets && items.some((item) => item.kind === "auth")
      ? [
          "Auth credentials were detected but skipped. Re-run interactively or pass --include-secrets to import supported credentials.",
        ]
      : []),
    ...(items.some((item) => item.status === "conflict")
      ? [
          "Conflicts were found. Re-run with --overwrite to replace conflicting migration targets after item-level backups.",
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
  ];
  return {
    providerId: "codex",
    source: source.root,
    target: targets.workspaceDir,
    summary: summarizeMigrationItems(items),
    items,
    warnings,
    nextSteps: memoryOnly
      ? []
      : [
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
