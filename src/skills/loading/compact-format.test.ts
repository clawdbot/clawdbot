// Compact format tests cover compact skill prompt serialization.
import os from "node:os";
import { formatSkillsForPrompt as upstreamFormatSkillsForPrompt } from "openclaw/plugin-sdk/agent-sessions";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import { formatSkillsForPrompt, type Skill } from "./skill-contract.js";
import {
  formatSkillsCompact,
  buildWorkspaceSkillsPrompt,
  buildWorkspaceSkillSnapshot,
} from "./workspace.js";

function makeSkill(name: string, desc = "A skill", filePath = `/skills/${name}/SKILL.md`): Skill {
  return createCanonicalFixtureSkill({
    name,
    description: desc,
    filePath,
    baseDir: `/skills/${name}`,
    source: "workspace",
  });
}

function makeEntry(skill: Skill): SkillEntry {
  return {
    skill,
    frontmatter: {},
    exposure: {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: true,
      userInvocable: true,
    },
  };
}

function buildPrompt(
  skills: Skill[],
  limits: { maxChars?: number; maxCount?: number } = {},
): string {
  return buildWorkspaceSkillsPrompt("/fake", {
    entries: skills.map(makeEntry),
    config: {
      skills: {
        limits: {
          ...(limits.maxChars !== undefined && { maxSkillsPromptChars: limits.maxChars }),
          ...(limits.maxCount !== undefined && { maxSkillsInPrompt: limits.maxCount }),
        },
      },
    } satisfies OpenClawConfig,
  });
}

function requireIncludedCounts(prompt: string): [included: number, total: number] {
  const match = prompt.match(/included (\d+) of (\d+)/);
  if (!match) {
    throw new Error(`expected included count in prompt: ${prompt}`);
  }
  return [Number(match[1]), Number(match[2])];
}

const COMPACT_OMITTED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions omitted). Run `openclaw skills check` to audit.";
const COMPACT_SHORTENED_NOTICE =
  "⚠️ Skills catalog using compact format (descriptions shortened). Run `openclaw skills check` to audit.";

describe("formatSkillsCompact", () => {
  it("keeps the full-format XML output aligned with the upstream formatter for visible skills", () => {
    const skills = [
      { ...makeSkill("weather", "Get weather <data> & forecasts"), promptVersion: "sha256:abc123" },
      makeSkill("notes", "Summarize notes", "/tmp/notes/SKILL.md"),
    ];
    expect(formatSkillsForPrompt(skills)).toBe(upstreamFormatSkillsForPrompt(skills));
  });

  it("renders all passed skills in the full formatter without reapplying visibility policy", () => {
    const hidden: Skill = { ...makeSkill("hidden"), disableModelInvocation: true };
    const out = formatSkillsForPrompt([makeSkill("visible"), hidden]);
    expect(out).toContain("visible");
    expect(out).toContain("hidden");
  });

  it("returns empty string for no skills", () => {
    expect(formatSkillsCompact([])).toBe("");
  });

  it("keeps compact descriptions with name, location, and version", () => {
    const out = formatSkillsCompact([
      { ...makeSkill("weather", "Get weather data"), promptVersion: "sha256:abc123" },
    ]);
    expect(out).toContain("<name>weather</name>");
    expect(out).toContain("<description>Get weather data</description>");
    expect(out).toContain("<location>/skills/weather/SKILL.md</location>");
    expect(out).toContain("<version>sha256:abc123</version>");
  });

  it("omits descriptions when their compact budget is zero", () => {
    const out = formatSkillsCompact([makeSkill("weather", "Get weather data")], {
      descriptionMaxChars: 0,
    });
    expect(out).toContain("<name>weather</name>");
    expect(out).not.toContain("<description>");
  });

  it("preserves location notes when compact descriptions are omitted", () => {
    const out = formatSkillsCompact(
      [
        {
          ...makeSkill("remote", "Remote skill"),
          locationNote: "Load with exec host=node node=node-1.",
        },
      ],
      { descriptionMaxChars: 0 },
    );

    expect(out).toContain("<location_note>Load with exec host=node node=node-1.</location_note>");
  });

  it("truncates descriptions without splitting emoji surrogate pairs", () => {
    const out = formatSkillsCompact([makeSkill("emoji", `${"A".repeat(16)}😀 trailing`)], {
      descriptionMaxChars: 20,
    });

    expect(out).toContain(`<description>${"A".repeat(16)}...</description>`);
    expect(out).not.toMatch(/[\uD800-\uDFFF]/u);
  });

  it("renders all passed skills without reapplying visibility policy", () => {
    const hidden: Skill = { ...makeSkill("hidden"), disableModelInvocation: true };
    const out = formatSkillsCompact([makeSkill("visible"), hidden]);
    expect(out).toContain("visible");
    expect(out).toContain("hidden");
  });

  it("escapes XML special characters", () => {
    const out = formatSkillsCompact([makeSkill("a<b&c")]);
    expect(out).toContain("a&lt;b&amp;c");
  });

  it("is significantly smaller than full format", () => {
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const compact = formatSkillsCompact(skills);
    expect(compact.length).toBeLessThan(formatSkillsForPrompt(skills).length / 2);
  });
});

describe("applySkillsPromptLimits (via buildWorkspaceSkillsPrompt)", () => {
  let envSnapshot: SkillsHomeEnvSnapshot;

  beforeEach(() => {
    envSnapshot = setMockSkillsHomeEnv("/Users/openclaw-test-user");
  });

  afterEach(() => restoreMockSkillsHomeEnv(envSnapshot));

  it("respects explicit exposure metadata before compact formatting", () => {
    const hidden = makeEntry({ ...makeSkill("hidden"), disableModelInvocation: true });
    hidden.exposure = {
      includeInRuntimeRegistry: true,
      includeInAvailableSkillsPrompt: false,
      userInvocable: true,
    };

    const prompt = buildWorkspaceSkillsPrompt("/fake", {
      entries: [makeEntry(makeSkill("visible")), hidden],
      config: {
        skills: {
          limits: {
            maxSkillsPromptChars: 4_000,
          },
        },
      } satisfies OpenClawConfig,
    });

    expect(prompt).toContain("visible");
    expect(prompt).not.toContain("hidden");
  });

  it("tier 1: uses full format when under budget", () => {
    const skills = [makeSkill("weather", "Get weather data")];
    const prompt = buildPrompt(skills, { maxChars: 50_000 });
    expect(prompt).toContain("<description>");
    expect(prompt).toContain("Get weather data");
    expect(prompt).not.toContain("⚠️");
  });

  it("tier 2: compact when full exceeds budget but compact fits", () => {
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const fullLen = formatSkillsForPrompt(skills).length;
    const compactLen = formatSkillsCompact(skills).length;
    const budget = `${COMPACT_SHORTENED_NOTICE}\n${formatSkillsCompact(skills)}`.length;
    expect(fullLen).toBeGreaterThan(budget);
    expect(compactLen).toBeLessThan(budget);
    const prompt = buildPrompt(skills, { maxChars: budget });
    expect(prompt).toContain("<description>");
    expect(prompt).toContain("compact format (descriptions shortened)");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-19");
  });

  it("tier 3: compact + binary search when compact also exceeds budget", () => {
    const skills = Array.from({ length: 100 }, (_, i) => makeSkill(`skill-${i}`, "description"));
    const prompt = buildPrompt(skills, { maxChars: 2000 });
    expect(prompt).toContain("compact format");
    expect(prompt).toContain("skill-0");
    const [included, total] = requireIncludedCounts(prompt);
    expect(included).toBeLessThan(total);
    expect(total).toBe(skills.length);
    expect(prompt.match(/<skill>/g)?.length ?? 0).toBe(included);
  });

  it("preserves every identity before allocating description budget", () => {
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const identityCatalog = formatSkillsCompact(skills, { descriptionMaxChars: 0 });
    const budget = `${COMPACT_OMITTED_NOTICE}\n${identityCatalog}`.length;
    expect(formatSkillsForPrompt(skills).length).toBeGreaterThan(budget);

    const prompt = buildPrompt(skills, { maxChars: budget });

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain(COMPACT_OMITTED_NOTICE);
    expect(prompt).not.toContain("<description>");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-49");
  });

  it("uses leftover compact budget for descriptions without dropping identities", () => {
    const skills = Array.from({ length: 8 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const identityCatalog = formatSkillsCompact(skills, { descriptionMaxChars: 0 });
    const budget = `${COMPACT_OMITTED_NOTICE}\n${identityCatalog}`.length + 500;

    const prompt = buildPrompt(skills, { maxChars: budget });

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain(COMPACT_SHORTENED_NOTICE);
    expect(prompt).toContain("<description>");
    expect(prompt).not.toContain("included");
    expect(prompt.match(/<skill>/g)).toHaveLength(skills.length);
  });

  it("count truncation + compact: shows included X of Y with compact note", () => {
    // 30 skills but maxCount=10, and full format of 10 exceeds budget
    const skills = Array.from({ length: 30 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(800)));
    const tenSkills = skills.slice(0, 10);
    const fullLen = formatSkillsForPrompt(tenSkills).length;
    const truncatedNotice =
      "⚠️ Skills truncated: included 10 of 30 (compact format, descriptions shortened). Run `openclaw skills check` to audit.";
    const budget = `${truncatedNotice}\n${formatSkillsCompact(tenSkills)}`.length;
    // Verify precondition: full format of 10 skills exceeds budget
    expect(fullLen).toBeGreaterThan(budget);
    const prompt = buildPrompt(skills, { maxChars: budget, maxCount: 10 });
    // Count-truncated (30→10) AND compact (full format of 10 exceeds budget)
    expect(prompt).toContain("included 10 of 30");
    expect(prompt).toContain("compact format, descriptions shortened");
    expect(prompt).toContain("<description>");
  });

  it("extreme budget: even a single compact skill overflows", () => {
    const skills = [makeSkill("only-one", "desc")];
    // Budget so small that even one compact skill can't fit
    const prompt = buildPrompt(skills, { maxChars: 10 });
    expect(prompt).not.toContain("only-one");
    const [included] = requireIncludedCounts(prompt);
    expect(included).toBe(0);
  });

  it("budgets the final rendered prompt including versions and limit notices", () => {
    const skills = Array.from({ length: 24 }, (_, i) => ({
      ...makeSkill(`skill-${i}`, "A".repeat(160)),
      promptVersion: `sha256:${String(i).padStart(16, "0")}`,
    }));
    const budget = 2_200;

    const prompt = buildPrompt(skills, { maxChars: budget });

    expect(prompt.length).toBeLessThanOrEqual(budget);
    expect(prompt).toContain("<version>sha256:");
    expect(prompt).toContain("included");
  });

  it("keeps no-skill catalogs empty instead of emitting version guidance", () => {
    const prompt = buildWorkspaceSkillsPrompt("/fake", {
      entries: [],
    });

    expect(prompt).toBe("");
  });

  it("count truncation only: shows included X of Y without compact note", () => {
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`, "short"));
    const prompt = buildPrompt(skills, { maxChars: 50_000, maxCount: 5 });
    expect(prompt).toContain("included 5 of 20");
    expect(prompt).not.toContain("compact");
    expect(prompt).toContain("<description>");
  });

  it("budget check uses compacted home-dir paths, not canonical paths", () => {
    // Skills with home-dir prefix get compacted (e.g. /home/user/... → ~/...).
    // Budget check must use the compacted length, not the longer canonical path.
    // If it used canonical paths, it would overestimate and potentially drop
    // skills that actually fit after compaction.
    const home = os.homedir();
    const skills = Array.from({ length: 30 }, (_, i) =>
      makeSkill(
        `skill-${i}`,
        "A".repeat(800),
        `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`,
      ),
    );
    // Compute compacted lengths (what the prompt will actually contain)
    const compactedSkills = skills.map((s) => ({
      ...s,
      filePath: s.filePath.replace(home, "~"),
    }));
    const compactedCompactLen = formatSkillsCompact(compactedSkills, {
      descriptionMaxChars: 0,
    }).length;
    const canonicalCompactLen = formatSkillsCompact(skills, { descriptionMaxChars: 0 }).length;
    // Sanity: canonical paths are longer than compacted paths
    expect(canonicalCompactLen).toBeGreaterThan(compactedCompactLen);
    // Set budget between compacted and canonical lengths — only fits if
    // budget check uses compacted paths (correct) not canonical (wrong).
    const budget =
      Math.floor((compactedCompactLen + canonicalCompactLen) / 2) +
      COMPACT_OMITTED_NOTICE.length +
      1;
    const prompt = buildPrompt(skills, { maxChars: budget });
    // All 30 skills should be preserved in compact form (tier 2, no dropping)
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-29");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("compact format");
    // Verify paths in output are compacted
    expect(prompt).toContain("~/");
    expect(prompt).not.toContain(home);
  });

  it("skills are sorted alphabetically regardless of entry insertion order", () => {
    // Entries provided in reverse alphabetical order should still produce
    // an alphabetically sorted prompt (fixes #64167).
    const entries = ["zoo", "apple", "mango", "banana"].map((n) =>
      makeEntry(makeSkill(n, `${n} skill`)),
    );
    const prompt = buildWorkspaceSkillsPrompt("/fake", {
      entries,
      config: { skills: { limits: { maxSkillsPromptChars: 50_000 } } } satisfies OpenClawConfig,
    });
    const nameMatches = [...prompt.matchAll(/<name>(\w+)<\/name>/g)].map((m) => m[1]);
    expect(nameMatches).toEqual(["apple", "banana", "mango", "zoo"]);
  });

  it("resolvedSkills in snapshot keeps canonical paths, not compacted", () => {
    const home = os.homedir();
    const skills = Array.from({ length: 5 }, (_, i) =>
      makeSkill(`skill-${i}`, "A skill", `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`),
    );
    const snapshot = buildWorkspaceSkillSnapshot("/fake", {
      entries: skills.map(makeEntry),
    });
    // Prompt should use compacted paths
    expect(snapshot.prompt).toContain("~/");
    // resolvedSkills should preserve canonical (absolute) paths
    expect(snapshot.resolvedSkills).toHaveLength(5);
    for (const skill of snapshot.resolvedSkills ?? []) {
      expect(skill.filePath).toContain(home);
      expect(skill.filePath).not.toMatch(/^~\//);
    }
  });
});
