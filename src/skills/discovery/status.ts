// Skill discovery status helpers summarize installed, workspace, and bundled skills.
import path from "node:path";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { evaluateEntryRequirementsForCurrentPlatform } from "../../shared/entry-status.js";
import type { RequirementConfigCheck, Requirements } from "../../shared/requirements.js";
import { CONFIG_DIR } from "../../utils.js";
import {
  readClawHubSkillsLockfileStatusSync,
  resolveClawHubSkillStatusLinkSync,
  resolveLocalSkillCardStatusSync,
  type ClawHubSkillStatusLink,
  type ClawHubSkillsLockfileStatusRead,
  type LocalSkillCardStatus,
} from "../lifecycle/clawhub.js";
import { resolveBundledSkillsContext } from "../loading/bundled-context.js";
import {
  hasBinary,
  isBundledSkillAllowed,
  isSkillConfigPathTruthy,
  resolveBundledAllowlist,
  resolveSkillConfig,
  resolveSkillsInstallPreferences,
} from "../loading/config.js";
import { loadWorkspaceSkillEntries } from "../loading/workspace.js";
import { mergeRemoteNodeSkillEntries } from "../runtime/remote-skills.js";
import type {
  SkillEntry,
  SkillEligibilityContext,
  SkillInstallSpec,
  SkillsInstallPreferences,
} from "../types.js";
import { resolveEffectiveAgentSkillFilter } from "./agent-filter.js";
import {
  buildSkillIndexEntries,
  normalizeSkillIndexName,
  type SkillIndexEntry,
} from "./skill-index.js";

type SkillInstallOption = {
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
  /**
   * True when the skill declares an OS requirement that does not include the
   * current platform (e.g. a macOS-only skill on Linux/Windows). Such skills are
   * inapplicable by design rather than broken installs, so callers can surface
   * them separately from genuine "missing requirements".
   */
  platformIncompatible: boolean;
  modelVisible: boolean;
  userInvocable: boolean;
  commandVisible: boolean;
  requirements: Requirements;
  missing: Requirements;
  configChecks: RequirementConfigCheck[];
  install: SkillInstallOption[];
  clawhub?: ClawHubSkillStatusLink;
  skillCard?: LocalSkillCardStatus;
};

export type SkillStatusReport = {
  workspaceDir: string;
  managedSkillsDir: string;
  agentId?: string;
  agentSkillFilter?: string[];
  skills: SkillStatusEntry[];
};

export function resolveSkillStatusEntry(
  skills: readonly SkillStatusEntry[],
  requestedName: string,
): SkillStatusEntry | null {
  const raw = requestedName.trim();
  if (!raw) {
    return null;
  }

  const lower = raw.toLowerCase();
  const normalized = normalizeSkillIndexName(raw);
  let caseInsensitiveMatch: SkillStatusEntry | null = null;
  let caseInsensitiveMatches = 0;
  let normalizedMatch: SkillStatusEntry | null = null;
  let normalizedMatches = 0;

  for (const skill of skills) {
    if (skill.name === raw || skill.skillKey === raw) {
      return skill;
    }

    const nameLower = skill.name.toLowerCase();
    const keyLower = skill.skillKey.toLowerCase();
    if (nameLower === lower || keyLower === lower) {
      caseInsensitiveMatch = skill;
      caseInsensitiveMatches += 1;
      continue;
    }

    if (
      normalized &&
      (normalizeSkillIndexName(skill.name) === normalized ||
        normalizeSkillIndexName(skill.skillKey) === normalized)
    ) {
      normalizedMatch = skill;
      normalizedMatches += 1;
    }
  }

  if (caseInsensitiveMatches > 1) {
    return null;
  }
  if (caseInsensitiveMatches === 1) {
    return caseInsensitiveMatch;
  }
  if (normalizedMatches === 1) {
    return normalizedMatch;
  }
  return null;
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

type BuildSkillStatusContext = {
  config?: OpenClawConfig;
  prefs: SkillsInstallPreferences;
  eligibility?: SkillEligibilityContext;
  allowBundled: ReadonlySet<string> | undefined;
  agentSkillFilter?: string[];
  workspaceDir: string;
  clawhubLockRead: ClawHubSkillsLockfileStatusRead;
};

function buildSkillStatus(
  indexed: SkillIndexEntry,
  context: BuildSkillStatusContext,
): SkillStatusEntry {
  const entry = indexed.entry;
  const skillKey = indexed.skillKey;
  const { config, prefs, eligibility, allowBundled, agentSkillFilter, workspaceDir } = context;
  const skillConfig = resolveSkillConfig(config, skillKey);
  const disabled = skillConfig?.enabled === false;
  const blockedByAllowlist = !isBundledSkillAllowed(entry, allowBundled);
  const blockedByAgentFilter = agentSkillFilter !== undefined && !indexed.agentAllowed;
  const always = entry.metadata?.always === true;
  const isEnvSatisfied = (envName: string) =>
    Boolean(
      process.env[envName] ||
      skillConfig?.env?.[envName] ||
      (skillConfig?.apiKey && entry.metadata?.primaryEnv === envName),
    );
  const isConfigSatisfied = (pathStr: string) => isSkillConfigPathTruthy(config, pathStr);
  const skillSource = indexed.source;
  const bundled = indexed.bundled;

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
  // Resolve platform incompatibility through the shared requirement evaluator's
  // `missing.os` (which already accounts for remote macOS node eligibility)
  // rather than a local-only process.platform check, so a macOS-only skill a
  // remote node can satisfy is not flagged incompatible.
  const platformIncompatible = missing.os.length > 0;
  const availableToAgent = eligible && !blockedByAgentFilter;
  const userInvocable = indexed.userInvocable;

  const clawhub =
    workspaceDir && !bundled
      ? resolveClawHubSkillStatusLinkSync({
          workspaceDir,
          skillDir: entry.skill.baseDir,
          skillKey,
          lockRead: context.clawhubLockRead,
        })
      : undefined;
  const skillCard = resolveLocalSkillCardStatusSync(entry.skill.baseDir);

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
    platformIncompatible,
    modelVisible: availableToAgent && indexed.promptVisible,
    userInvocable,
    commandVisible: availableToAgent && userInvocable,
    requirements: required,
    missing,
    configChecks,
    install: normalizeInstallOptions(entry, prefs),
    ...(clawhub ? { clawhub } : {}),
    ...(skillCard ? { skillCard } : {}),
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
  // Status reports every skill (disabled/ineligible included) with flags, so
  // the loader must stay unfiltered; node-hosted skills merge in separately.
  const skillEntries = mergeRemoteNodeSkillEntries(
    opts?.entries ??
      loadWorkspaceSkillEntries(workspaceDir, {
        config: opts?.config,
        managedSkillsDir,
        bundledSkillsDir: bundledContext.dir,
        includeArchived: true,
      }),
    {
      canExec: opts?.eligibility?.nodeSkills?.canExec,
      node: opts?.eligibility?.nodeSkills?.node,
    },
  );
  const prefs = resolveSkillsInstallPreferences(opts?.config);
  const allowBundled = resolveBundledAllowlist(opts?.config);
  const clawhubLockRead = readClawHubSkillsLockfileStatusSync(workspaceDir);
  const skillIndexEntries = buildSkillIndexEntries(skillEntries, {
    bundledNames: bundledContext.names,
    agentSkillFilter,
  });
  return {
    workspaceDir,
    managedSkillsDir,
    agentId: opts?.agentId,
    agentSkillFilter,
    skills: skillIndexEntries.map((entry) =>
      buildSkillStatus(entry, {
        config: opts?.config,
        prefs,
        eligibility: opts?.eligibility,
        allowBundled,
        agentSkillFilter,
        workspaceDir,
        clawhubLockRead,
      }),
    ),
  };
}
