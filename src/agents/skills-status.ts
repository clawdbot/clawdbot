import path from "node:path";

import type { ClawdbotConfig } from "../config/config.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveConfigPath,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";

export type SkillStatusConfigCheck = {
  path: string;
  value: unknown;
  satisfied: boolean;
};

export type SkillInstallOption = {
  id: string;
  kind: SkillInstallSpec["kind"];
  label: string;
  bins: string[];
};

export type SkillStatusEntry = {
  name: string;
  description: string;
  source: string;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  eligible: boolean;
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
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  skills: SkillStatusEntry[];
};

function resolveSkillKey(entry: SkillEntry): string {
  return entry.clawdbot?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) return undefined;
  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");

  if (prefs.preferBrew && hasBinary("brew") && brewSpec) return brewSpec;
  if (uvSpec) return uvSpec;
  if (nodeSpec) return nodeSpec;
  if (brewSpec) return brewSpec;
  if (goSpec) return goSpec;
  return indexed[0];
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  const install = entry.clawdbot?.install ?? [];
  if (install.length === 0) return [];
  const preferred = selectPreferredInstallSpec(install, prefs);
  if (!preferred) return [];
  const { spec, index } = preferred;
  const id = (spec.id ?? `${spec.kind}-${index}`).trim();
  const bins = spec.bins ?? [];
  let label = (spec.label ?? "").trim();
  if (spec.kind === "node" && spec.package) {
    label = `Install ${spec.package} (${prefs.nodeManager})`;
  }
  if (!label) {
    if (spec.kind === "brew" && spec.formula) {
      label = `Install ${spec.formula} (brew)`;
    } else if (spec.kind === "node" && spec.package) {
      label = `Install ${spec.package} (${prefs.nodeManager})`;
    } else if (spec.kind === "go" && spec.module) {
      label = `Install ${spec.module} (go)`;
    } else if (spec.kind === "uv" && spec.package) {
      label = `Install ${spec.package} (uv)`;
    } else {
      label = "Run installer";
    }
  }
  return [
    {
      id,
      kind: spec.kind,
      label,
      bins,
    },
  ];
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: ClawdbotConfig,
  prefs?: SkillsInstallPreferences,
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const always = entry.clawdbot?.always === true;
  const emoji = entry.clawdbot?.emoji ?? entry.frontmatter.emoji;
  const homepageRaw =
    entry.clawdbot?.homepage ??
    entry.frontmatter.homepage ??
    entry.frontmatter.website ??
    entry.frontmatter.url;
  const homepage = homepageRaw?.trim() ? homepageRaw.trim() : undefined;

  const requiredBins = entry.clawdbot?.requires?.bins ?? [];
  const requiredAnyBins = entry.clawdbot?.requires?.anyBins ?? [];
  const requiredEnv = entry.clawdbot?.requires?.env ?? [];
  const requiredConfig = entry.clawdbot?.requires?.config ?? [];
  const requiredOs = entry.clawdbot?.os ?? [];

  const missingBins = requiredBins.filter((bin) => !hasBinary(bin));
  const missingAnyBins =
    requiredAnyBins.length > 0 && !requiredAnyBins.some((bin) => hasBinary(bin))
      ? requiredAnyBins
      : [];
  const missingOs =
    requiredOs.length > 0 && !requiredOs.includes(process.platform)
      ? requiredOs
      : [];

  const missingEnv: string[] = [];
  for (const envName of requiredEnv) {
    if (process.env[envName]) continue;
    if (skillConfig?.env?.[envName]) continue;
    if (skillConfig?.apiKey && entry.clawdbot?.primaryEnv === envName) {
      continue;
    }
    missingEnv.push(envName);
  }

  const configChecks: SkillStatusConfigCheck[] = requiredConfig.map(
    (pathStr) => {
      const value = resolveConfigPath(config, pathStr);
      const satisfied = isConfigPathTruthy(config, pathStr);
      return { path: pathStr, value, satisfied };
    },
  );
  const missingConfig = configChecks
    .filter((check) => !check.satisfied)
    .map((check) => check.path);

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
    !blockedByAllowlist &&
    (always ||
      (missing.bins.length === 0 &&
        missing.anyBins.length === 0 &&
        missing.env.length === 0 &&
        missing.config.length === 0 &&
        missing.os.length === 0));

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: entry.skill.source,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.clawdbot?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    eligible,
    requirements: {
      bins: requiredBins,
      anyBins: requiredAnyBins,
      env: requiredEnv,
      config: requiredConfig,
      os: requiredOs,
    },
    missing,
    configChecks,
    install: normalizeInstallOptions(
      entry,
      prefs ?? resolveSkillsInstallPreferences(config),
    ),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
  },
): SkillStatusReport {
  const managedSkillsDir =
    opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const skillEntries =
    opts?.entries ?? loadWorkspaceSkillEntries(workspaceDir, opts);
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  return {
    workspaceDir,
    managedSkillsDir,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(entry, opts?.config, prefs),
    ),
  };
}
