import fs from "node:fs";
import path from "node:path";

import {
  formatSkillsForPrompt,
  loadSkillsFromDir,
  type Skill,
} from "@mariozechner/pi-coding-agent";

import type { ClawdbotConfig } from "../../config/config.js";
import { CONFIG_DIR, resolveUserPath } from "../../utils.js";
import { resolveBundledSkillsDir } from "./bundled-dir.js";
import { shouldIncludeSkill } from "./config.js";
import {
  parseFrontmatter,
  resolveClawdbotMetadata,
  resolveSkillInvocationPolicy,
} from "./frontmatter.js";
import { serializeByKey } from "./serialize.js";
import type {
  ParsedSkillFrontmatter,
  SkillEligibilityContext,
  SkillCommandSpec,
  SkillEntry,
  SkillSnapshot,
} from "./types.js";

const fsp = fs.promises;

function filterSkillEntries(
  entries: SkillEntry[],
  config?: ClawdbotConfig,
  skillFilter?: string[],
  eligibility?: SkillEligibilityContext,
): SkillEntry[] {
  let filtered = entries.filter((entry) => shouldIncludeSkill({ entry, config, eligibility }));
  // If skillFilter is provided, only include skills in the filter list.
  if (skillFilter !== undefined) {
    const normalized = skillFilter.map((entry) => String(entry).trim()).filter(Boolean);
    const label = normalized.length > 0 ? normalized.join(", ") : "(none)";
    console.log(`[skills] Applying skill filter: ${label}`);
    filtered =
      normalized.length > 0
        ? filtered.filter((entry) => normalized.includes(entry.skill.name))
        : [];
    console.log(`[skills] After filter: ${filtered.map((entry) => entry.skill.name).join(", ")}`);
  }
  return filtered;
}

const SKILL_COMMAND_MAX_LENGTH = 32;
const SKILL_COMMAND_FALLBACK = "skill";
// Discord command descriptions must be ≤100 characters
const SKILL_COMMAND_DESCRIPTION_MAX_LENGTH = 100;

function sanitizeSkillCommandName(raw: string): string {
  const normalized = raw
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  const trimmed = normalized.slice(0, SKILL_COMMAND_MAX_LENGTH);
  return trimmed || SKILL_COMMAND_FALLBACK;
}

function resolveUniqueSkillCommandName(base: string, used: Set<string>): string {
  const normalizedBase = base.toLowerCase();
  if (!used.has(normalizedBase)) return base;
  for (let index = 2; index < 1000; index += 1) {
    const suffix = `_${index}`;
    const maxBaseLength = Math.max(1, SKILL_COMMAND_MAX_LENGTH - suffix.length);
    const trimmedBase = base.slice(0, maxBaseLength);
    const candidate = `${trimmedBase}${suffix}`;
    const candidateKey = candidate.toLowerCase();
    if (!used.has(candidateKey)) return candidate;
  }
  const fallback = `${base.slice(0, Math.max(1, SKILL_COMMAND_MAX_LENGTH - 2))}_x`;
  return fallback;
}

function loadSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  const loadSkills = (params: { dir: string; source: string }): Skill[] => {
    const loaded = loadSkillsFromDir(params);
    if (Array.isArray(loaded)) return loaded;
    if (
      loaded &&
      typeof loaded === "object" &&
      "skills" in loaded &&
      Array.isArray((loaded as { skills?: unknown }).skills)
    ) {
      return (loaded as { skills: Skill[] }).skills;
    }
    return [];
  };

  const managedSkillsDir = opts?.managedSkillsDir ?? path.join(CONFIG_DIR, "skills");
  const workspaceSkillsDir = path.join(workspaceDir, "skills");
  const bundledSkillsDir = opts?.bundledSkillsDir ?? resolveBundledSkillsDir();
  const extraDirsRaw = opts?.config?.skills?.load?.extraDirs ?? [];
  const extraDirs = extraDirsRaw
    .map((d) => (typeof d === "string" ? d.trim() : ""))
    .filter(Boolean);

  const bundledSkills = bundledSkillsDir
    ? loadSkills({
        dir: bundledSkillsDir,
        source: "clawdbot-bundled",
      })
    : [];
  const extraSkills = extraDirs.flatMap((dir) => {
    const resolved = resolveUserPath(dir);
    return loadSkills({
      dir: resolved,
      source: "clawdbot-extra",
    });
  });
  const managedSkills = loadSkills({
    dir: managedSkillsDir,
    source: "clawdbot-managed",
  });
  const workspaceSkills = loadSkills({
    dir: workspaceSkillsDir,
    source: "clawdbot-workspace",
  });

  const merged = new Map<string, Skill>();
  // Precedence: extra < bundled < managed < workspace
  for (const skill of extraSkills) merged.set(skill.name, skill);
  for (const skill of bundledSkills) merged.set(skill.name, skill);
  for (const skill of managedSkills) merged.set(skill.name, skill);
  for (const skill of workspaceSkills) merged.set(skill.name, skill);

  const skillEntries: SkillEntry[] = Array.from(merged.values()).map((skill) => {
    let frontmatter: ParsedSkillFrontmatter = {};
    try {
      const raw = fs.readFileSync(skill.filePath, "utf-8");
      frontmatter = parseFrontmatter(raw);
    } catch {
      // ignore malformed skills
    }
    return {
      skill,
      frontmatter,
      clawdbot: resolveClawdbotMetadata(frontmatter),
      invocation: resolveSkillInvocationPolicy(frontmatter),
    };
  });
  return skillEntries;
}

export function buildWorkspaceSkillSnapshot(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    snapshotVersion?: number;
  },
): SkillSnapshot {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const resolvedSkills = promptEntries.map((entry) => entry.skill);
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  const prompt = [remoteNote, formatSkillsForPrompt(resolvedSkills)].filter(Boolean).join("\n");
  return {
    prompt,
    skills: eligible.map((entry) => ({
      name: entry.skill.name,
      primaryEnv: entry.clawdbot?.primaryEnv,
    })),
    resolvedSkills,
    version: opts?.snapshotVersion,
  };
}

export function buildWorkspaceSkillsPrompt(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    /** If provided, only include skills with these names */
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
  },
): string {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const promptEntries = eligible.filter(
    (entry) => entry.invocation?.disableModelInvocation !== true,
  );
  const remoteNote = opts?.eligibility?.remote?.note?.trim();
  return [remoteNote, formatSkillsForPrompt(promptEntries.map((entry) => entry.skill))]
    .filter(Boolean)
    .join("\n");
}

export function resolveSkillsPromptForRun(params: {
  skillsSnapshot?: SkillSnapshot;
  entries?: SkillEntry[];
  config?: ClawdbotConfig;
  workspaceDir: string;
}): string {
  const snapshotPrompt = params.skillsSnapshot?.prompt?.trim();
  if (snapshotPrompt) return snapshotPrompt;
  if (params.entries && params.entries.length > 0) {
    const prompt = buildWorkspaceSkillsPrompt(params.workspaceDir, {
      entries: params.entries,
      config: params.config,
    });
    return prompt.trim() ? prompt : "";
  }
  return "";
}

export function loadWorkspaceSkillEntries(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
  },
): SkillEntry[] {
  return loadSkillEntries(workspaceDir, opts);
}

export async function syncSkillsToWorkspace(params: {
  sourceWorkspaceDir: string;
  targetWorkspaceDir: string;
  config?: ClawdbotConfig;
  managedSkillsDir?: string;
  bundledSkillsDir?: string;
}) {
  const sourceDir = resolveUserPath(params.sourceWorkspaceDir);
  const targetDir = resolveUserPath(params.targetWorkspaceDir);
  if (sourceDir === targetDir) return;

  await serializeByKey(`syncSkills:${targetDir}`, async () => {
    const targetSkillsDir = path.join(targetDir, "skills");

    const entries = loadSkillEntries(sourceDir, {
      config: params.config,
      managedSkillsDir: params.managedSkillsDir,
      bundledSkillsDir: params.bundledSkillsDir,
    });

    await fsp.rm(targetSkillsDir, { recursive: true, force: true });
    await fsp.mkdir(targetSkillsDir, { recursive: true });

    for (const entry of entries) {
      const dest = path.join(targetSkillsDir, entry.skill.name);
      try {
        await fsp.cp(entry.skill.baseDir, dest, {
          recursive: true,
          force: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : JSON.stringify(error);
        console.warn(`[skills] Failed to copy ${entry.skill.name} to sandbox: ${message}`);
      }
    }
  });
}

export function filterWorkspaceSkillEntries(
  entries: SkillEntry[],
  config?: ClawdbotConfig,
): SkillEntry[] {
  return filterSkillEntries(entries, config);
}

export function buildWorkspaceSkillCommandSpecs(
  workspaceDir: string,
  opts?: {
    config?: ClawdbotConfig;
    managedSkillsDir?: string;
    bundledSkillsDir?: string;
    entries?: SkillEntry[];
    skillFilter?: string[];
    eligibility?: SkillEligibilityContext;
    reservedNames?: Set<string>;
  },
): SkillCommandSpec[] {
  const skillEntries = opts?.entries ?? loadSkillEntries(workspaceDir, opts);
  const eligible = filterSkillEntries(
    skillEntries,
    opts?.config,
    opts?.skillFilter,
    opts?.eligibility,
  );
  const userInvocable = eligible.filter((entry) => entry.invocation?.userInvocable !== false);
  const used = new Set<string>();
  for (const reserved of opts?.reservedNames ?? []) {
    used.add(reserved.toLowerCase());
  }

  const specs: SkillCommandSpec[] = [];
  for (const entry of userInvocable) {
    const base = sanitizeSkillCommandName(entry.skill.name);
    const unique = resolveUniqueSkillCommandName(base, used);
    used.add(unique.toLowerCase());
    const rawDescription = entry.skill.description?.trim() || entry.skill.name;
    const description =
      rawDescription.length > SKILL_COMMAND_DESCRIPTION_MAX_LENGTH
        ? rawDescription.slice(0, SKILL_COMMAND_DESCRIPTION_MAX_LENGTH - 1) + "…"
        : rawDescription;
    specs.push({
      name: unique,
      skillName: entry.skill.name,
      description,
    });
  }
  return specs;
}
