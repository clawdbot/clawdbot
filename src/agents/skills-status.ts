import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../shared/requirements.js";
import { CONFIG_DIR } from "../utils.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isConfigPathTruthy,
  loadWorkspaceSkillEntries,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
  type SkillEntry,
  type SkillEligibilityContext,
  type SkillInstallSpec,
  type SkillsInstallPreferences,
} from "./skills.js";
import { resolveEffectiveAgentSkillFilter } from "./skills/agent-filter.js";
import { resolveBundledSkillsContext } from "./skills/bundled-context.js";
import { resolveSkillSource } from "./skills/source.js";

export type SkillStatusConfigCheck = RequirementConfigCheck;

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
  bundled: boolean;
  filePath: string;
  baseDir: string;
  skillKey: string;
  primaryEnv?: string;
  emoji?: string;
  homepage?: string;
  always: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  blockedByAgentFilter: boolean;
  eligible: boolean;
  modelVisible: boolean;
  userInvocable: boolean;
  commandVisible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: SkillStatusConfigCheck[];
  install: SkillInstallOption[];
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  agentSkillFilter?: string[];
  skills: SkillStatusEntry[];
};

function resolveSkillKey(entry: SkillEntry): string {
  return entry.metadata?.skillKey ?? entry.skill.name;
}

function selectPreferredInstallSpec(
  install: SkillInstallSpec[],
  prefs: SkillsInstallPreferences,
): { spec: SkillInstallSpec; index: number } | undefined {
  if (install.length === 0) {
    return undefined;
  }

  const indexed = install.map((spec, index) => ({ spec, index }));
  const findKind = (kind: SkillInstallSpec["kind"]) =>
    indexed.find((item) => item.spec.kind === kind);

  const brewSpec = findKind("brew");
  const nodeSpec = findKind("node");
  const goSpec = findKind("go");
  const uvSpec = findKind("uv");
  const downloadSpec = findKind("download");
  const brewAvailable = hasBinary("brew");

  // Table-driven preference chain; first match wins.
  const pickers: Array<() => { spec: SkillInstallSpec; index: number } | undefined> = [
    () => (prefs.preferBrew && brewAvailable ? brewSpec : undefined),
    () => uvSpec,
    () => nodeSpec,
    // Only prefer brew when available to avoid guaranteed failure on Linux/Docker.
    () => (brewAvailable ? brewSpec : undefined),
    () => goSpec,
    // Prefer download over an unavailable brew spec.
    () => downloadSpec,
    // Last resort: surface descriptive brew-missing error instead of "no installer found".
    () => brewSpec,
    () => indexed[0],
  ];

  for (const pick of pickers) {
    const selected = pick();
    if (selected) {
      return selected;
    }
  }

  return undefined;
}

function normalizeInstallOptions(
  entry: SkillEntry,
  prefs: SkillsInstallPreferences,
): SkillInstallOption[] {
  // If the skill is explicitly OS-scoped, don't surface install actions on unsupported platforms.
  // (Installers run locally; remote OS eligibility is handled separately.)
  const requiredOs = entry.metadata?.os ?? [];
  if (requiredOs.length > 0 && !requiredOs.includes(process.platform)) {
    return [];
  }

  const install = entry.metadata?.install ?? [];
  if (install.length === 0) {
    return [];
  }

  const platform = process.platform;
  const filtered = install.filter((spec) => {
    const osList = spec.os ?? [];
    return osList.length === 0 || osList.includes(platform);
  });
  if (filtered.length === 0) {
    return [];
  }

  const toOption = (spec: SkillInstallSpec, index: number): SkillInstallOption => {
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
      } else if (spec.kind === "download" && spec.url) {
        const url = spec.url.trim();
        const last = url.split("/").pop();
        label = `Download ${last && last.length > 0 ? last : url}`;
      } else {
        label = "Run installer";
      }
    }
    return { id, kind: spec.kind, label, bins };
  };

  const allDownloads = filtered.every((spec) => spec.kind === "download");
  if (allDownloads) {
    return filtered.map((spec, index) => toOption(spec, index));
  }

  const preferred = selectPreferredInstallSpec(filtered, prefs);
  if (!preferred) {
    return [];
  }
  return [toOption(preferred.spec, preferred.index)];
}

function isSkillVisibleInAvailableSkillsPrompt(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return (
      entry.exposure.includeInAvailableSkillsPrompt ||
      !("includeInAvailableSkillsPrompt" in entry.exposure)
    );
  }
  if (entry.invocation) {
    return !entry.invocation.disableModelInvocation;
  }
  return !entry.skill.disableModelInvocation;
}

function isSkillUserInvocable(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.userInvocable || !("userInvocable" in entry.exposure);
  }
  if (entry.invocation) {
    return entry.invocation.userInvocable || !("userInvocable" in entry.invocation);
  }
  return true;
}

function buildSkillStatus(
  entry: SkillEntry,
  config?: OpenClawConfig,
  prefs?: SkillsInstallPreferences,
  eligibility?: SkillEligibilityContext,
  bundledNames?: Set<string>,
  agentSkillFilter?: string[],
): SkillStatusEntry {
  const skillKey = resolveSkillKey(entry);
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const allowBundled = resolveBundledAllowlist(config);
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const blockedByAgentFilter =
    agentSkillFilter !== undefined && !agentSkillFilter.includes(entry.skill.name);
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isConfigPathTruthy(config, pathStr);
  const skillSource = resolveSkillSource(entry.skill);
  const bundled =
    skillSource === "openclaw-bundled" ||
    (skillSource === "unknown" && bundledNames?.has(entry.skill.name) === true);

  const { emoji, homepage, required, missing, requirementsSatisfied, configChecks } =
    evaluateEntryRequirementsForCurrentPlatform({
      always,
      entry,
      hasLocalBin: hasBinary,
      remote: eligibility?.remote,
      isEnvSatisfied,
      isConfigSatisfied,
    });
  const eligible = !disabled && !blockedByAllowlist && requirementsSatisfied;
  const availableToAgent = eligible && !blockedByAgentFilter;
  const userInvocable = isSkillUserInvocable(entry);

  return {
    name: entry.skill.name,
    description: entry.skill.description,
    source: skillSource,
    bundled,
    filePath: entry.skill.filePath,
    baseDir: entry.skill.baseDir,
    skillKey,
    primaryEnv: entry.metadata?.primaryEnv,
    emoji,
    homepage,
    always,
    disabled,
    blockedByAllowlist,
    blockedByAgentFilter,
    eligible,
    modelVisible: availableToAgent && isSkillVisibleInAvailableSkillsPrompt(entry),
    userInvocable,
    commandVisible: availableToAgent && userInvocable,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry, prefs ?? resolveSkillsInstallPreferences(config)),
  };
}

export function buildWorkspaceSkillStatus(
  workspaceDir: string,
  opts?: {
    config?: OpenClawConfig;
    managedSkillsDir?: string;
    entries?: SkillEntry[];
    eligibility?: SkillEligibilityContext;
    agentId?: string;
  },
): SkillStatusReport {
  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const bundledContext = resolveBundledSkillsContext();
  const agentSkillFilter = opts?.agentId
    ? resolveEffectiveAgentSkillFilter(opts.config, opts.agentId)
    : undefined;
  const skillEntries =
    opts?.entries ??
    loadWorkspaceSkillEntries(workspaceDir, {
      config: opts?.config,
      managedSkillsDir,
      bundledSkillsDir: bundledContext.dir,
    });
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  return {
    workspaceDir,
    managedSkillsDir,
    agentId: opts?.agentId,
    agentSkillFilter,
    skills: skillEntries.map((entry) =>
      buildSkillStatus(
        entry,
        opts?.config,
        prefs,
        opts?.eligibility,
        bundledContext.names,
        agentSkillFilter,
      ),
    ),
  };
}
