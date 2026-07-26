// Proves when a new state root cannot contain legacy state migration work.
import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  resolveConfigPath,
  resolveLegacyStateDirs,
  resolveStateDir,
} from "../../../config/paths.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { resolveEffectiveHomeDir } from "../../../infra/home-dir.js";
import { tryReadJsonSync } from "../../../infra/json-files.js";
import { inspectBundledPluginStartupMetadata } from "../../../plugins/bundled-plugin-startup-metadata.js";
import { configMayRequireStartupPluginConvergence } from "./startup-plugin-convergence-plan.js";

const STATEFUL_CONFIG_KEYS = new Set([
  "accessGroups",
  "acp",
  "approvals",
  "audio",
  "bindings",
  "broadcast",
  "channels",
  "cloudWorkers",
  "commitments",
  "cron",
  "discovery",
  "env",
  "hooks",
  "marketplaces",
  "mcp",
  "media",
  "memory",
  "messages",
  "nodeHost",
  "proxy",
  "secrets",
  "session",
  "surfaces",
  "talk",
  "tools",
  "transcripts",
  "web",
]);

function containsObjectKey(value: unknown, targetKey: string): boolean {
  if (Array.isArray(value)) {
    return value.some((entry) => containsObjectKey(entry, targetKey));
  }
  if (!isRecord(value)) {
    return false;
  }
  return (
    Object.hasOwn(value, targetKey) ||
    Object.values(value).some((entry) => containsObjectKey(entry, targetKey))
  );
}

function hasOnlyMigrationSafePluginEntries(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean {
  const plugins = config.plugins;
  if (!isRecord(plugins)) {
    return plugins === undefined;
  }
  if (Object.keys(plugins).some((key) => !["enabled", "entries", "allow", "deny"].includes(key))) {
    return false;
  }
  if (!isRecord(plugins.entries)) {
    return plugins.entries === undefined;
  }
  return Object.entries(plugins.entries).every(([pluginId, entry]) => {
    if (!isRecord(entry)) {
      return false;
    }
    if (entry.enabled === false) {
      return true;
    }
    if (entry.config !== undefined) {
      return false;
    }
    const metadata = inspectBundledPluginStartupMetadata({ pluginId, env });
    return Boolean(metadata && !metadata.hasDoctorContract);
  });
}

function configIsPristineCoreStateSafe(config: Record<string, unknown>): boolean {
  if ([...STATEFUL_CONFIG_KEYS].some((key) => Object.hasOwn(config, key))) {
    return false;
  }
  if (containsObjectKey(config.agents, "memorySearch")) {
    return false;
  }
  return true;
}

export type PristineStartupMigrationPlan = {
  skipAllStateMigrations: boolean;
  skipCoreStateMigrations: boolean;
};

/** Revalidates the authored config after startup recovery without rereading physical state. */
export function planPristineStartupConfigMigrations(
  config: unknown,
  env: NodeJS.ProcessEnv = process.env,
): PristineStartupMigrationPlan {
  if (!isRecord(config) || containsObjectKey(config, "$include")) {
    return { skipAllStateMigrations: false, skipCoreStateMigrations: false };
  }
  const skipCoreStateMigrations = configIsPristineCoreStateSafe(config);
  return {
    skipAllStateMigrations: skipCoreStateMigrations && configIsPristineStateSafe(config, env),
    skipCoreStateMigrations,
  };
}

function configIsPristineStateSafe(
  config: Record<string, unknown>,
  env: NodeJS.ProcessEnv,
): boolean {
  if (!configIsPristineCoreStateSafe(config)) {
    return false;
  }
  if (!hasOnlyMigrationSafePluginEntries(config, env)) {
    return false;
  }
  return !configMayRequireStartupPluginConvergence({
    config: config as OpenClawConfig,
    env,
  });
}

function stateDirHasOnlyConfig(stateDir: string, configPath: string): boolean {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(stateDir, { withFileTypes: true });
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
  const resolvedConfigPath = path.resolve(configPath);
  return entries.every((entry) => path.resolve(stateDir, entry.name) === resolvedConfigPath);
}

/**
 * A missing/empty state root plus migration-free bundled config has no legacy data to migrate.
 * Keep ambiguity on the full migration path; this shortcut only accepts a proven new install.
 */
export function canSkipPristineStartupStateMigrations(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return planPristineStartupStateMigrations(env).skipAllStateMigrations;
}

/** Separates provably absent core state from plugin-owned migration work. */
export function planPristineStartupStateMigrations(
  env: NodeJS.ProcessEnv = process.env,
): PristineStartupMigrationPlan {
  const stateDir = resolveStateDir(env);
  const configPath = resolveConfigPath(env, stateDir);
  if (!stateDirHasOnlyConfig(stateDir, configPath)) {
    return { skipAllStateMigrations: false, skipCoreStateMigrations: false };
  }
  const homeDir = resolveEffectiveHomeDir(env);
  if (!homeDir) {
    return { skipAllStateMigrations: false, skipCoreStateMigrations: false };
  }
  const legacyStateAbsent = resolveLegacyStateDirs(() => homeDir).every((legacyDir) => {
    if (path.resolve(legacyDir) === path.resolve(stateDir)) {
      return false;
    }
    return !fs.existsSync(legacyDir);
  });
  if (!legacyStateAbsent) {
    return { skipAllStateMigrations: false, skipCoreStateMigrations: false };
  }
  const configPlan = planPristineStartupConfigMigrations(tryReadJsonSync(configPath), env);
  return {
    skipAllStateMigrations: configPlan.skipAllStateMigrations,
    skipCoreStateMigrations: configPlan.skipCoreStateMigrations,
  };
}
