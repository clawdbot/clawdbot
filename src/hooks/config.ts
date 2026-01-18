import fs from "node:fs";
import path from "node:path";
import type { ClawdbotConfig, HookConfig } from "../config/config.js";
import { resolveHookKey } from "./frontmatter.js";
import type { HookEligibilityContext, HookEntry } from "./types.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "workspace.dir": true,
};

function isTruthy(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.trim().length > 0;
  return true;
}

export function resolveConfigPath(config: ClawdbotConfig | undefined, pathStr: string) {
  const parts = pathStr.split(".").filter(Boolean);
  let current: unknown = config;
  for (const part of parts) {
    if (typeof current !== "object" || current === null) return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

export function isConfigPathTruthy(config: ClawdbotConfig | undefined, pathStr: string): boolean {
  const value = resolveConfigPath(config, pathStr);
  if (value === undefined && pathStr in DEFAULT_CONFIG_VALUES) {
    return DEFAULT_CONFIG_VALUES[pathStr] === true;
  }
  return isTruthy(value);
}

export function resolveHookConfig(
  config: ClawdbotConfig | undefined,
  hookKey: string,
): HookConfig | undefined {
  const hooks = config?.hooks?.internal?.entries;
  if (!hooks || typeof hooks !== "object") return undefined;
  const entry = (hooks as Record<string, HookConfig | undefined>)[hookKey];
  if (!entry || typeof entry !== "object") return undefined;
  return entry;
}

export function resolveRuntimePlatform(): string {
  return process.platform;
}

export function hasBinary(bin: string): boolean {
  const pathEnv = process.env.PATH ?? "";
  const parts = pathEnv.split(path.delimiter).filter(Boolean);
  for (const part of parts) {
    const candidate = path.join(part, bin);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      // keep scanning
    }
  }
  return false;
}

export function shouldIncludeHook(params: {
  entry: HookEntry;
  config?: ClawdbotConfig;
  eligibility?: HookEligibilityContext;
}): boolean {
  const { entry, config, eligibility } = params;
  const hookKey = resolveHookKey(entry.hook.name, entry);
  const hookConfig = resolveHookConfig(config, hookKey);
  const pluginManaged = entry.hook.source === "clawdbot-plugin";
  const osList = entry.clawdbot?.os ?? [];
  const remotePlatforms = eligibility?.remote?.platforms ?? [];

  // Check if explicitly disabled
  if (!pluginManaged && hookConfig?.enabled === false) return false;

  // Check OS requirement
  if (
    osList.length > 0 &&
    !osList.includes(resolveRuntimePlatform()) &&
    !remotePlatforms.some((platform) => osList.includes(platform))
  ) {
    return false;
  }

  // If marked as 'always', bypass all other checks
  if (entry.clawdbot?.always === true) {
    return true;
  }

  // Check required binaries (all must be present)
  const requiredBins = entry.clawdbot?.requires?.bins ?? [];
  if (requiredBins.length > 0) {
    for (const bin of requiredBins) {
      if (hasBinary(bin)) continue;
      if (eligibility?.remote?.hasBin?.(bin)) continue;
      return false;
    }
  }

  // Check anyBins (at least one must be present)
  const requiredAnyBins = entry.clawdbot?.requires?.anyBins ?? [];
  if (requiredAnyBins.length > 0) {
    const anyFound =
      requiredAnyBins.some((bin) => hasBinary(bin)) ||
      eligibility?.remote?.hasAnyBin?.(requiredAnyBins);
    if (!anyFound) return false;
  }

  // Check required environment variables
  const requiredEnv = entry.clawdbot?.requires?.env ?? [];
  if (requiredEnv.length > 0) {
    for (const envName of requiredEnv) {
      if (process.env[envName]) continue;
      if (hookConfig?.env?.[envName]) continue;
      return false;
    }
  }

  // Check required config paths
  const requiredConfig = entry.clawdbot?.requires?.config ?? [];
  if (requiredConfig.length > 0) {
    for (const configPath of requiredConfig) {
      if (!isConfigPathTruthy(config, configPath)) return false;
    }
  }

  return true;
}
