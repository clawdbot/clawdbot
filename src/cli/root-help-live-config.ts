import fs from "node:fs";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  inspectShippedPluginInstallConfigRecords,
  stripShippedPluginInstallConfigRecords,
} from "../config/plugin-install-config-migration.js";
import type { OpenClawConfig } from "../config/types.js";
import { resolveRequiredHomeDir, resolveUserPath } from "../infra/home-dir.js";
import { normalizeEnvVarKey } from "../infra/host-env-security.js";
import type { RootHelpRenderOptions } from "./program/root-help.js";

/** Env vars that can change which plugins root help renders. */
const PLUGIN_ENV_KEYS = [
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
] as const;

const MAX_DOTENV_FILE_BYTES = 1024 * 1024;
const PLUGIN_RECORD_KEYS = ["slots", "entries", "installs", "load"] as const;
const PLUGIN_KEYS = ["enabled", "allow", "deny", "installs", "load", "slots", "entries"] as const;

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function hasListEntries(value: string[] | undefined): boolean {
  return Array.isArray(value) && value.length > 0;
}

type PluginsConfigShape =
  | {
      enabled?: boolean;
      allow?: string[];
      deny?: string[];
      load?: { paths?: string[] };
      slots?: object;
      entries?: object;
    }
  | undefined;

function pluginsAffectHelp(plugins: PluginsConfigShape): boolean {
  return Boolean(
    plugins &&
    (plugins.enabled === false ||
      hasListEntries(plugins.allow) ||
      hasListEntries(plugins.deny) ||
      hasListEntries(plugins.load?.paths) ||
      hasEntries(plugins.slots) ||
      hasEntries(plugins.entries)),
  );
}

function hasInvalidStringList(value: unknown): boolean {
  return (
    value !== undefined &&
    (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
  );
}

function hasInvalidPluginRecord(plugins: unknown): boolean {
  if (plugins === undefined) {
    return false;
  }
  if (!isRecord(plugins)) {
    return true;
  }
  if (
    Object.keys(plugins).some(
      // SAFETY: PLUGIN_KEYS contains only strings, and includes performs runtime string equality.
      (key) => !PLUGIN_KEYS.includes(key as (typeof PLUGIN_KEYS)[number]),
    ) ||
    (plugins.enabled !== undefined && typeof plugins.enabled !== "boolean") ||
    hasInvalidStringList(plugins.allow) ||
    hasInvalidStringList(plugins.deny)
  ) {
    return true;
  }
  if (PLUGIN_RECORD_KEYS.some((key) => plugins[key] !== undefined && !isRecord(plugins[key]))) {
    return true;
  }
  const load = plugins.load;
  return (
    isRecord(load) &&
    (Object.keys(load).some((key) => key !== "paths") || hasInvalidStringList(load.paths))
  );
}

function envAffectsPluginHelp(env: NodeJS.ProcessEnv): boolean {
  return Boolean(
    env.OPENCLAW_BUNDLED_PLUGINS_DIR?.trim() || env.OPENCLAW_DISABLE_BUNDLED_PLUGINS?.trim(),
  );
}

function configEnvCannotAffectPluginHelp(value: unknown): boolean {
  if (value === undefined) {
    return true;
  }
  if (!isRecord(value) || value.shellEnv !== undefined) {
    return false;
  }
  const vars = value.vars;
  if (vars !== undefined && !isRecord(vars)) {
    return false;
  }
  const entries = [
    ...(vars === undefined ? [] : Object.entries(vars)),
    ...Object.entries(value).filter(([rawKey]) => rawKey !== "vars" && rawKey !== "shellEnv"),
  ];
  return entries.every(([rawKey, envValue]) => {
    if (typeof envValue !== "string") {
      return false;
    }
    const key = normalizeEnvVarKey(rawKey, { portable: true });
    if (!key) {
      return false;
    }
    const platformKey = process.platform === "win32" ? key.toUpperCase() : key;
    return !PLUGIN_ENV_KEYS.some((pluginKey) => pluginKey === platformKey);
  });
}

/**
 * Config dir as `resolveConfigDir` computes it, without importing the config
 * module. Kept deliberately in step with `src/utils.ts`.
 */
function configDirForProbe(env: NodeJS.ProcessEnv): string {
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    return resolveUserPath(stateOverride, env);
  }
  const configPath = env.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    return path.dirname(resolveUserPath(configPath, env));
  }
  return path.join(resolveRequiredHomeDir(env), ".openclaw");
}

function configPathsForProbe(env: NodeJS.ProcessEnv): string[] {
  const override = env.OPENCLAW_CONFIG_PATH?.trim();
  if (override) {
    return [resolveUserPath(override, env)];
  }
  const stateOverride = env.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    const stateDir = resolveUserPath(stateOverride, env);
    return [path.join(stateDir, "openclaw.json"), path.join(stateDir, "clawdbot.json")];
  }
  const home = resolveRequiredHomeDir(env);
  return [
    path.join(home, ".openclaw", "openclaw.json"),
    path.join(home, ".openclaw", "clawdbot.json"),
    path.join(home, ".clawdbot", "openclaw.json"),
    path.join(home, ".clawdbot", "clawdbot.json"),
  ];
}

function readFirstConfigText(env: NodeJS.ProcessEnv): string | null | undefined {
  for (const candidate of configPathsForProbe(env)) {
    try {
      return fs.readFileSync(candidate, "utf8");
    } catch (error) {
      // SAFETY: Node's fs.readFileSync reports filesystem failures as NodeJS.ErrnoException objects.
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
    }
  }
  return null;
}

/**
 * The dotenv files the config read would load, in the same order and under the
 * same state-dir condition as `loadGlobalRuntimeDotEnvFiles`. Reading the config
 * has the side effect of loading these, so the fast path must account for them
 * before it can skip that read.
 */
function dotEnvPathsForProbe(env: NodeJS.ProcessEnv): string[] {
  const paths: string[] = [];
  try {
    paths.push(path.join(process.cwd(), ".env"));
  } catch {
    // Deleted cwd: nothing to read.
  }
  const configDir = configDirForProbe(env);
  const stateEnvPath = path.join(configDir, ".env");
  paths.push(stateEnvPath);
  const home = resolveRequiredHomeDir(env);
  const defaultStateEnvPath = path.join(home, ".openclaw", ".env");
  const hasExplicitNonDefaultStateDir =
    env.OPENCLAW_STATE_DIR?.trim() !== undefined &&
    path.resolve(stateEnvPath) !== path.resolve(defaultStateEnvPath);
  if (!hasExplicitNonDefaultStateDir) {
    paths.push(path.join(home, ".config", "openclaw", "gateway.env"));
  }
  return [...new Set(paths)];
}

async function anyDotEnvMentionsPluginKey(env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const dotEnvPath of dotEnvPathsForProbe(env)) {
    let text: string;
    try {
      const resolved = fs.realpathSync(dotEnvPath);
      // Keep the fs-safe dependency off the common no-dotenv help path.
      const { readRegularFileSync } = await import("../infra/regular-file.js");
      const { buffer } = readRegularFileSync({
        filePath: resolved,
        maxBytes: MAX_DOTENV_FILE_BYTES,
      });
      text = buffer.toString("utf8").toUpperCase();
    } catch {
      continue;
    }
    if (PLUGIN_ENV_KEYS.some((key) => text.includes(key))) {
      return true;
    }
  }
  return false;
}

type ConfigProbeResult = {
  cannotAffectHelp: boolean;
  rawInstallsAffectHelp: boolean;
  rawInstallsConfig?: OpenClawConfig;
};

const CONSERVATIVE_CONFIG_PROBE: ConfigProbeResult = {
  cannotAffectHelp: false,
  rawInstallsAffectHelp: false,
};

/** Inspect raw config facts that must survive canonical snapshot migration. */
function inspectConfigForPluginHelp(env: NodeJS.ProcessEnv): ConfigProbeResult {
  const raw = readFirstConfigText(env);
  if (raw === null) {
    return { cannotAffectHelp: true, rawInstallsAffectHelp: false };
  }
  if (raw === undefined) {
    return CONSERVATIVE_CONFIG_PROBE;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return CONSERVATIVE_CONFIG_PROBE;
  }
  if (!isRecord(parsed)) {
    return CONSERVATIVE_CONFIG_PROBE;
  }
  const plugins = parsed.plugins;
  const installsState = inspectShippedPluginInstallConfigRecords(parsed);
  const rawInstallsAffectHelp =
    installsState.status === "valid" && hasEntries(installsState.records);
  let rawInstallsConfig: OpenClawConfig | undefined;
  if (rawInstallsAffectHelp) {
    // SAFETY: Canonical install inspection validated the raw record before stripping.
    rawInstallsConfig = stripShippedPluginInstallConfigRecords(parsed) as OpenClawConfig;
  }
  // Inspect the decoded representation so JSON escapes cannot hide loader-owned
  // include or environment-substitution syntax from this lightweight probe.
  const decoded = JSON.stringify(parsed);
  if (
    decoded.includes("$include") ||
    decoded.includes("${") ||
    decoded.includes("$(") ||
    !configEnvCannotAffectPluginHelp(parsed.env) ||
    installsState.status === "invalid" ||
    hasInvalidPluginRecord(plugins)
  ) {
    return { cannotAffectHelp: false, rawInstallsAffectHelp, rawInstallsConfig };
  }
  // SAFETY: The guard above rejects every defined plugin value outside PluginsConfigShape.
  const pluginsConfig = plugins as PluginsConfigShape;
  return {
    cannotAffectHelp: !rawInstallsAffectHelp && !pluginsAffectHelp(pluginsConfig),
    rawInstallsAffectHelp,
    rawInstallsConfig,
  };
}

/** Load render options only when config/env can affect plugin help output. */
export async function loadRootHelpRenderOptionsForConfigSensitivePlugins(
  env: NodeJS.ProcessEnv = process.env,
): Promise<RootHelpRenderOptions | null> {
  // Fast path: when nothing reachable through the config file, the dotenv files
  // the config read would load, or the process env can change plugin help, the
  // answer is `null` regardless, so the config module never has to be loaded.
  //
  // Only the real environment is probed. An injected env is a test/diagnostic
  // sandbox that must stay isolated from the host filesystem - the same rule
  // `maybeLoadDotEnvForConfig` applies before it loads dotenv files - so those
  // callers keep taking the full config path.
  let configProbe: ConfigProbeResult | undefined;
  if (
    env === process.env &&
    !envAffectsPluginHelp(env) &&
    !(await anyDotEnvMentionsPluginKey(env))
  ) {
    configProbe = inspectConfigForPluginHelp(env);
    if (configProbe.cannotAffectHelp) {
      return null;
    }
  }
  const configModule = await import("../config/config.js");
  const snapshot = await configModule.readConfigFileSnapshot({
    observe: false,
    skipPluginValidation: true,
  });
  if (!snapshot.valid) {
    return configProbe?.rawInstallsConfig ? { config: configProbe.rawInstallsConfig, env } : null;
  }
  const configAffectsPluginHelp =
    configProbe?.rawInstallsAffectHelp === true || pluginsAffectHelp(snapshot.sourceConfig.plugins);
  if (!envAffectsPluginHelp(env) && !configAffectsPluginHelp) {
    return null;
  }
  return {
    config: snapshot.runtimeConfig,
    env,
  };
}
