// Skill loading config helpers resolve configured skill sources and enablement.
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "@openclaw/normalization-core/string-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { SkillConfig } from "../../config/types.skills.js";
import {
  evaluateRuntimeEligibility,
  hasBinary,
  isConfigPathTruthyWithDefaults,
  resolveConfigPath,
  resolveRuntimePlatform,
} from "../../shared/config-eval.js";
import type { SkillEligibilityContext, SkillEntry, SkillsInstallPreferences } from "../types.js";
import { resolveSkillKey } from "./frontmatter.js";
import { resolveSkillSource } from "./source.js";

const DEFAULT_CONFIG_VALUES: Record<string, boolean> = {
  "browser.enabled": true,
  "browser.evaluateEnabled": true,
};

/** Platform helpers re-exported for skill loading callers and tests. */
export { hasBinary, resolveConfigPath, resolveRuntimePlatform };

export function resolveSkillsInstallPreferences(config?: OpenClawConfig): SkillsInstallPreferences {
  const raw = config?.skills?.install;
  const preferBrew = raw?.preferBrew ?? true;
  const manager = normalizeLowercaseStringOrEmpty(normalizeOptionalString(raw?.nodeManager));
  const nodeManager: SkillsInstallPreferences["nodeManager"] =
    manager === "pnpm" || manager === "yarn" || manager === "bun" || manager === "npm"
      ? manager
      : "npm";
  return { preferBrew, nodeManager };
}

export function isConfigPathTruthy(config: OpenClawConfig | undefined, pathStr: string): boolean {
  return isConfigPathTruthyWithDefaults(config, pathStr, DEFAULT_CONFIG_VALUES);
}

export function resolveSkillConfig(
  config: OpenClawConfig | undefined,
  skillKey: string,
): SkillConfig | undefined {
  const skills = config?.skills?.entries;
  if (!skills || typeof skills !== "object") {
    return undefined;
  }
  const entry = (skills as Record<string, SkillConfig | undefined>)[skillKey];
  if (!entry || typeof entry !== "object") {
    return undefined;
  }
  return entry;
}

function normalizeAllowlist(input: unknown): ReadonlySet<string> | undefined {
  if (!input) {
    return undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const normalized = normalizeStringEntries(input);
  return normalized.length > 0 ? new Set(normalized) : undefined;
}

const BUNDLED_SOURCES = new Set(["openclaw-bundled"]);

function isBundledSkill(entry: SkillEntry): boolean {
  return BUNDLED_SOURCES.has(resolveSkillSource(entry.skill));
}

export function resolveBundledAllowlist(config?: OpenClawConfig): ReadonlySet<string> | undefined {
  return normalizeAllowlist(config?.skills?.allowBundled);
}

export function isBundledSkillAllowed(entry: SkillEntry, allowlist?: ReadonlySet<string>): boolean {
  if (!allowlist || allowlist.size === 0) {
    return true;
  }
  if (!isBundledSkill(entry)) {
    return true;
  }
  const key = resolveSkillKey(entry.skill, entry);
  return allowlist.has(key) || allowlist.has(entry.skill.name);
}

export function shouldIncludeSkill(params: {
  entry: SkillEntry;
  config?: OpenClawConfig;
  bundledAllowlist: ReadonlySet<string> | undefined;
  eligibility?: SkillEligibilityContext;
}): boolean {
  const { entry, config, bundledAllowlist, eligibility } = params;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const skillConfig = resolveSkillConfig(config, skillKey);

  if (skillConfig?.enabled === false) {
    return false;
  }
  if (!isBundledSkillAllowed(entry, bundledAllowlist)) {
    return false;
  }
  return evaluateRuntimeEligibility({
    os: entry.metadata?.os,
    remotePlatforms: eligibility?.remote?.platforms,
    always: entry.metadata?.always,
    requires: entry.metadata?.requires,
    hasBin: hasBinary,
    hasRemoteBin: eligibility?.remote?.hasBin,
    hasAnyRemoteBin: eligibility?.remote?.hasAnyBin,
    hasEnv: (envName) =>
      Boolean(
        process.env[envName] ||
        skillConfig?.env?.[envName] ||
        (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
      ),
    isConfigPathTruthy: (configPath) => isConfigPathTruthy(config, configPath),
  });
}
