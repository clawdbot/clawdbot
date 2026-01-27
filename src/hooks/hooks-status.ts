import path from "node:path";

import type { MoltbotConfig } from "../config/config.js";
import { CONFIG_DIR } from "../utils.js";
import { hasBinary, isConfigPathTruthy, resolveConfigPath, resolveHookConfig } from "./config.js";
import type { HookEligibilityContext, HookEntry, HookInstallSpec } from "./types.js";
import { loadWorkspaceHookEntries } from "./workspace.js";

export type HookStatusConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type HookInstallOption = {
  id: string;
  kind: HookInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type HookStatusEntry = {
  name: string;
  description: string;
  source: string;
  pluginId?: string;
  filePath: string;
  baseDir: string;
  handlerPath: string;
  hookKey: string;
  emoji?: string;
  homepage?: string;
  events: string[];
  always: boolean;
  disabled: boolean;
  eligible: boolean;
  managedByPlugin: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  configChecks: HookStatusConfigCheck[];
  install: HookInstallOption[];
};

export type HookStatusReport = {
  workspaceDir: string;
  managedHooksDir: string;
  hooks: HookStatusEntry[];
};

function resolveHookKey(entry: HookEntry): string {
  return entry.metadata?.hookKey ?? entry.hook.name;
}

function normalizeInstallOptions(entry: HookEntry): HookInstallOption[] {
  const install = entry.metadata?.install ?? [];
  if (install.length === 0) return [];

  // For hooks, we just list all install options
  return install.map((spec, index) => {
    const id = (spec.id ?? `${spec.kind}-${index}`).trim();
    const bins = spec.bins ?? [];
    let label = (spec.label ?? "").trim();

    if (!label) {
      if (spec.kind === "bundled") {
        label = "Bundled with Moltbot";
      } else if (spec.kind === "npm" && spec.package) {
        label = `Install ${spec.package} (npm)`;
      } else if (spec.kind === "git" && spec.repository) {
        label = `Install from ${spec.repository}`;
      } else {
        label = "Run installer";
      }
    }

    return { id, kind: spec.kind, label, bins };
  });
}

function buildHookStatus(
  entry: HookEntry,
  config?: MoltbotConfig,
  eligibility?: HookEligibilityContext,
): HookStatusEntry {
  const hookKey = resolveHookKey(entry);
  const hookConfig = resolveHookConfig(config, hookKey);
  const managedByPlugin = entry.hook.source === "moltbot-plugin";
  const disabled = managedByPlugin ? false : hookConfig?.enabled === false;
  const always = entry.metadata?.always === true;
  const emoji = entry.metadata?.emoji ?? entry.frontmatter.emoji;
  const homepageRaw =
    entry.metadata?.homepage ??
    entry.frontmatter.homepage ??
    entry.frontmatter.website ??
    entry.frontmatter.url;
  const homepage = homepageRaw?.trim() ? homepageRaw.trim() : undefined;
  const events = entry.metadata?.events ?? [];

  const requiredBins = entry.metadata?.requires?.bins ?? [];
  const requiredAnyBins = entry.metadata?.requires?.anyBins ?? [];
  const requiredEnv = entry.metadata?.requires?.env ?? [];
  const requiredConfig = entry.metadata?.requires?.config ?? [];
  const requiredOs = entry.metadata?.os ?? [];

  const missingBins = requiredBins.filter((bin) => {
    if (hasBinary(bin)) return false;
    if (eligibility?.remote?.hasBin?.(bin)) return false;
    return true;
  });

  const missingAnyBins =
    requiredAnyBins.length > 0 &&
    !(
      requiredAnyBins.some((bin) => hasBinary(bin)) ||
      eligibility?.remote?.hasAnyBin?.(requiredAnyBins)
    )
      ? requiredAnyBins
      : [];

  const missingOs =
    requiredOs.length > 0 &&
    !requiredOs.includes(process.platform) &&
    !eligibility?.remote?.platforms?.some((platform) => requiredOs.includes(platform))
      ? requiredOs
      : [];

  const missingEnv: string[] = [];
  for (const envName of requiredEnv) {
    if (process.env[envName]) continue;
    if (hookConfig?.env?.[envName]) continue;
    missingEnv.push(envName);
  }

  const configChecks: HookStatusConfigCheck[] = requiredConfig.map((pathStr) => {
    const value = resolveConfigPath(config, pathStr);
    const satisfied = isConfigPathTruthy(config, pathStr);
    return { path: pathStr, value, satisfied };
  });

  const missingConfig = configChecks.filter((check) => !check.satisfied).map((check) => check.path);

  const missing = always
    ? { bins: [], anyBins: [], env: [], config: [], os: [] }
    : {
        bins: missingBins,
        anyBins: missingAnyBins,
        env: missingEnv,
        config: missingConfig,
        os: missingOs,
      };

  const eligible =
    !disabled &&
    (always ||
      (missing.bins.length === 0 &&
        missing.anyBins.length === 0 &&
        missing.env.length === 0 &&
        missing.config.length === 0 &&
        missing.os.length === 0));

  return {
    name: entry.hook.name,
    description: entry.hook.description,
    source: entry.hook.source,
    pluginId: entry.hook.pluginId,
    filePath: entry.hook.filePath,
    baseDir: entry.hook.baseDir,
    handlerPath: entry.hook.handlerPath,
    hookKey,
    emoji,
    homepage,
    events,
    always,
    disabled,
    eligible,
    managedByPlugin,
    requirements: {
      bins: requiredBins,
      anyBins: requiredAnyBins,
      env: requiredEnv,
      config: requiredConfig,
      os: requiredOs,
    },
    missing,
    configChecks,
    install: normalizeInstallOptions(entry),
  };
}

export function buildWorkspaceHookStatus(
  workspaceDir: string,
  opts?: {
    config?: MoltbotConfig;
    managedHooksDir?: string;
    entries?: HookEntry[];
    eligibility?: HookEligibilityContext;
  },
): HookStatusReport {
  const managedHooksDir = opts?.managedHooksDir ?? path.join(CONFIG_DIR, "hooks");
  const hookEntries = opts?.entries ?? loadWorkspaceHookEntries(workspaceDir, opts);

  return {
    workspaceDir,
    managedHooksDir,
    hooks: hookEntries.map((entry) => buildHookStatus(entry, opts?.config, opts?.eligibility)),
  };
}
