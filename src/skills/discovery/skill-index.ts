// Skill index helpers map normalized skill names to loaded skill entries.
import { resolveSkillKey } from "../loading/frontmatter.js";
import { resolveSkillSource } from "../loading/source.js";
import type { SkillEntry } from "../types.js";

/** Indexed skill metadata used for runtime visibility and command lookup. */
export type SkillIndexEntry = {
  entry: SkillEntry;
  name: string;
  normalizedName: string;
  skillKey: string;
  normalizedSkillKey: string;
  source: string;
  bundled: boolean;
  agentAllowed: boolean;
  runtimeVisible: boolean;
  promptVisible: boolean;
  userInvocable: boolean;
};

type BuildSkillIndexOptions = {
  bundledNames?: ReadonlySet<string>;
  agentSkillFilter?: readonly string[];
};

/** Normalizes a skill name to the comparable key used by filters and commands. */
export function normalizeSkillIndexName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[\s_/]+/g, "-")
    .replace(/[^a-z0-9-]+/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function isSkillRuntimeVisible(entry: SkillEntry): boolean {
  return entry.exposure?.includeInRuntimeRegistry ?? true;
}

function isSkillPromptVisible(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.includeInAvailableSkillsPrompt ?? true;
  }
  if (entry.invocation) {
    return !entry.invocation.disableModelInvocation;
  }
  return !entry.skill.disableModelInvocation;
}

function isSkillUserInvocable(entry: SkillEntry): boolean {
  if (entry.exposure) {
    return entry.exposure.userInvocable ?? true;
  }
  if (entry.invocation) {
    return entry.invocation.userInvocable ?? true;
  }
  return true;
}

export function filterPromptVisibleSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return entries.filter(isSkillPromptVisible);
}

export function filterUserInvocableSkillEntries(entries: readonly SkillEntry[]): SkillEntry[] {
  return entries.filter(isSkillUserInvocable);
}

export function buildSkillIndexEntries(
  entries: readonly SkillEntry[],
  opts?: BuildSkillIndexOptions,
): SkillIndexEntry[] {
  const agentSkillSet =
    opts?.agentSkillFilter === undefined ? undefined : new Set(opts.agentSkillFilter);
  return entries.map((entry) => createSkillIndexEntry(entry, opts, agentSkillSet));
}

function createSkillIndexEntry(
  entry: SkillEntry,
  opts: BuildSkillIndexOptions | undefined,
  agentSkillSet: ReadonlySet<string> | undefined,
): SkillIndexEntry {
  const name = entry.skill.name;
  const skillKey = resolveSkillKey(entry.skill, entry);
  const source = resolveSkillSource(entry.skill);
  return {
    entry,
    name,
    normalizedName: normalizeSkillIndexName(name),
    skillKey,
    normalizedSkillKey: normalizeSkillIndexName(skillKey),
    source,
    bundled:
      source === "openclaw-bundled" ||
      (source === "unknown" && opts?.bundledNames?.has(name) === true),
    agentAllowed: agentSkillSet === undefined || agentSkillSet.has(name),
    runtimeVisible: isSkillRuntimeVisible(entry),
    promptVisible: isSkillPromptVisible(entry),
    userInvocable: isSkillUserInvocable(entry),
  };
}
