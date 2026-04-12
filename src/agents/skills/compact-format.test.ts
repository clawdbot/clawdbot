import os from "node:os";
import { formatSkillsForPrompt as upstreamFormatSkillsForPrompt } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { createCanonicalFixtureSkill } from "../skills.test-helpers.js";
import { formatSkillsForPrompt, type Skill } from "./skill-contract.js";
import type { SkillEntry } from "./types.js";
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

describe("formatSkillsCompact", () => {
  it("keeps the full-format XML output aligned with the upstream formatter for visible skills", () => {
    const skills = [
      makeSkill("weather", "Get weather <data> & forecasts"),
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

  it("omits description, keeps name and location", () => {
    const out = formatSkillsCompact([makeSkill("weather", "Get weather data")]);
    expect(out).toContain("<name>weather</name>");
    expect(out).toContain("<location>/skills/weather/SKILL.md</location>");
    expect(out).not.toContain("Get weather data");
    expect(out).not.toContain("<description>");
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
    const skills = Array.from({ length: 50 }, (_, i) =>
      makeSkill(`skill-${i}`, "A moderately long description that takes up space in the prompt"),
    );
    const compact = formatSkillsCompact(skills);
    expect(compact.length).toBeLessThan(6000);
  });
});

describe("applySkillsPromptLimits (via buildWorkspaceSkillsPrompt)", () => {
  let previousHome: string | undefined;
  let previousOpenClawHome: string | undefined;
  let previousUserProfile: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
    previousOpenClawHome = process.env.OPENCLAW_HOME;
    previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = "/Users/openclaw-test-user";
    delete process.env.OPENCLAW_HOME;
    delete process.env.USERPROFILE;
    vi.spyOn(os, "homedir").mockReturnValue("/Users/openclaw-test-user");
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (previousHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = previousHome;
    }
    if (previousOpenClawHome === undefined) {
      delete process.env.OPENCLAW_HOME;
    } else {
      process.env.OPENCLAW_HOME = previousOpenClawHome;
    }
    if (previousUserProfile === undefined) {
      delete process.env.USERPROFILE;
    } else {
      process.env.USERPROFILE = previousUserProfile;
    }
  });

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
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(200)));
    const fullLen = formatSkillsForPrompt(skills).length;
    const compactLen = formatSkillsCompact(skills).length;
    const budget = Math.floor((fullLen + compactLen) / 2);
    // Verify preconditions: full exceeds budget, compact fits within overhead-adjusted budget
    expect(fullLen).toBeGreaterThan(budget);
    expect(compactLen + 150).toBeLessThan(budget);
    const prompt = buildPrompt(skills, { maxChars: budget });
    expect(prompt).not.toContain("<description>");
    // All skills preserved — distinct message, no "included X of Y"
    expect(prompt).toContain("compact format (descriptions omitted)");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-19");
  });

  it("tier 3: compact + binary search when compact also exceeds budget", () => {
    const skills = Array.from({ length: 100 }, (_, i) => makeSkill(`skill-${i}`, "description"));
    const prompt = buildPrompt(skills, { maxChars: 2000 });
    expect(prompt).toContain("compact format, descriptions omitted");
    expect(prompt).not.toContain("<description>");
    expect(prompt).toContain("skill-0");
    const match = prompt.match(/included (\d+) of (\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBeLessThan(Number(match![2]));
    expect(Number(match![1])).toBeGreaterThan(0);
  });

  it("compact preserves all skills where full format would drop some", () => {
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(200)));
    const compactLen = formatSkillsCompact(skills).length;
    const budget = compactLen + 250;
    // Verify precondition: full format must not fit so tier 2 is actually exercised
    expect(formatSkillsForPrompt(skills).length).toBeGreaterThan(budget);
    const prompt = buildPrompt(skills, { maxChars: budget });
    // All 50 fit in compact — no truncation, just compact notice
    expect(prompt).toContain("compact format");
    expect(prompt).not.toContain("included");
    expect(prompt).toContain("skill-0");
    expect(prompt).toContain("skill-49");
  });

  it("count truncation + compact: shows included X of Y with compact note", () => {
    // 30 skills but maxCount=10, and full format of 10 exceeds budget
    const skills = Array.from({ length: 30 }, (_, i) => makeSkill(`skill-${i}`, "A".repeat(200)));
    const tenSkills = skills.slice(0, 10);
    const fullLen = formatSkillsForPrompt(tenSkills).length;
    const compactLen = formatSkillsCompact(tenSkills).length;
    const budget = compactLen + 200;
    // Verify precondition: full format of 10 skills exceeds budget
    expect(fullLen).toBeGreaterThan(budget);
    const prompt = buildPrompt(skills, { maxChars: budget, maxCount: 10 });
    // Count-truncated (30→10) AND compact (full format of 10 exceeds budget)
    expect(prompt).toContain("included 10 of 30");
    expect(prompt).toContain("compact format, descriptions omitted");
    expect(prompt).not.toContain("<description>");
  });

  it("extreme budget: even a single compact skill overflows", () => {
    const skills = [makeSkill("only-one", "desc")];
    // Budget so small that even one compact skill can't fit
    const prompt = buildPrompt(skills, { maxChars: 10 });
    expect(prompt).not.toContain("only-one");
    const match = prompt.match(/included (\d+) of (\d+)/);
    expect(match).toBeTruthy();
    expect(Number(match![1])).toBe(0);
  });

  it("count truncation only: shows included X of Y without compact note", () => {
    const skills = Array.from({ length: 20 }, (_, i) => makeSkill(`skill-${i}`, "short"));
    const prompt = buildPrompt(skills, { maxChars: 50_000, maxCount: 5 });
    expect(prompt).toContain("included 5 of 20");
    expect(prompt).not.toContain("compact");
    expect(prompt).toContain("<description>");
  });

  it("compact budget reserves space for the warning line", () => {
    // Build skills whose compact output exactly equals the char budget.
    // Without overhead reservation the compact block would fit, but the
    // warning line prepended by the caller would push the total over budget.
    const skills = Array.from({ length: 50 }, (_, i) => makeSkill(`s-${i}`, "A".repeat(200)));
    const compactLen = formatSkillsCompact(skills).length;
    // Set budget = compactLen + 50 — less than the 150-char overhead reserve.
    // The function should NOT choose compact-only because the warning wouldn't fit.
    const prompt = buildPrompt(skills, { maxChars: compactLen + 50 });
    // Should fall through to compact + binary search (some skills dropped)
    expect(prompt).toContain("included");
    expect(prompt).not.toContain("<description>");
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
        "A".repeat(200),
        `${home}/.openclaw/workspace/skills/skill-${i}/SKILL.md`,
      ),
    );
    // Compute compacted lengths (what the prompt will actually contain)
    const compactedSkills = skills.map((s) => ({
      ...s,
      filePath: s.filePath.replace(home, "~"),
    }));
    const compactedCompactLen = formatSkillsCompact(compactedSkills).length;
    const canonicalCompactLen = formatSkillsCompact(skills).length;
    // Sanity: canonical paths are longer than compacted paths
    expect(canonicalCompactLen).toBeGreaterThan(compactedCompactLen);
    // Set budget between compacted and canonical lengths — only fits if
    // budget check uses compacted paths (correct) not canonical (wrong).
    const budget = Math.floor((compactedCompactLen + canonicalCompactLen) / 2) + 150;
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
    expect(snapshot.resolvedSkills).toBeDefined();
    for (const skill of snapshot.resolvedSkills!) {
      expect(skill.filePath).toContain(home);
      expect(skill.filePath).not.toMatch(/^~\//);
    }
  });
});
