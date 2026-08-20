// Workspace skill prompt tests cover catalog budgets, ordering, and compact paths.
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnv } from "../../test-utils/env.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry } from "../types.js";
import {
  formatSkillsCompactForPrompt as formatSkillsCompact,
  formatSkillsForPromptCore,
  type Skill,
} from "./skill-contract.js";
import { buildSkillSnapshot } from "./workspace-skill-prompt.js";

const buildWorkspaceSkillsPrompt = (
  workspaceDir: string,
  opts?: Parameters<typeof buildSkillSnapshot>[1],
): string => buildSkillSnapshot(workspaceDir, opts).prompt;

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
    const fullLen = formatSkillsForPromptCore(skills).length;
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
    expect(formatSkillsForPromptCore(skills).length).toBeGreaterThan(budget);

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
    const fullLen = formatSkillsForPromptCore(tenSkills).length;
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
    expect(prompt).toBe("");
  });

  it.each([0, 1, 10, 64])("never exceeds a tiny configured prompt budget of %i", (maxChars) => {
    const prompt = buildPrompt([makeSkill("only-one", "desc")], { maxChars });

    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    expect(prompt).toBe("");
  });

  it("drops an oversized optional remote note before discarding a complete fitting skill catalog", () => {
    const skill = makeSkill("weather", "Get weather data");
    const maxChars = formatSkillsForPromptCore([skill]).length;
    const remoteNote = `REMOTE_NOTE_${"x".repeat(maxChars + 512)}`;
    const prompt = buildWorkspaceSkillsPrompt("/fake", {
      entries: [makeEntry(skill)],
      config: {
        skills: {
          limits: { maxSkillsPromptChars: maxChars },
        },
      } satisfies OpenClawConfig,
      eligibility: {
        remote: {
          platforms: [],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: remoteNote,
        },
      },
    });

    expect(prompt.length).toBeLessThanOrEqual(maxChars);
    expect(prompt).toContain("<name>weather</name>");
    expect(prompt).toContain("</available_skills>");
    expect(prompt).not.toContain("REMOTE_NOTE_");
  });

  it("preserves the exact full-catalog bytes when a remote note fits", () => {
    const skill = makeSkill("weather", "Get weather data");
    const remoteNote = "Remote node skills are available.";
    const catalog = formatSkillsForPromptCore([skill]);
    const expected = [remoteNote, catalog].join("\n");
    const prompt = buildWorkspaceSkillsPrompt("/fake", {
      entries: [makeEntry(skill)],
      config: {
        skills: { limits: { maxSkillsPromptChars: expected.length } },
      } satisfies OpenClawConfig,
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: () => false,
          note: remoteNote,
        },
      },
    });

    expect(prompt).toBe(expected);
    expect(prompt.length).toBeLessThanOrEqual(expected.length);
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
    const snapshot = buildSkillSnapshot("/fake", {
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

describe("compactSkillPaths", () => {
  function buildPromptForFixtureSkill(params: {
    workspaceRoot: string;
    skillDir: string;
    name: string;
    description: string;
  }) {
    return buildWorkspaceSkillsPrompt(params.workspaceRoot, {
      entries: [
        {
          skill: createCanonicalFixtureSkill({
            name: params.name,
            description: params.description,
            filePath: path.join(params.skillDir, "SKILL.md"),
            baseDir: params.skillDir,
            source: "test",
          }),
          frontmatter: {},
          metadata: undefined,
          invocation: { disableModelInvocation: false, userInvocable: true },
          exposure: {
            includeInRuntimeRegistry: true,
            includeInAvailableSkillsPrompt: true,
            userInvocable: true,
          },
        },
      ],
    });
  }

  it("replaces home directory prefix with ~ in skill locations", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills", "test-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "test-skill",
      description: "A test skill for path compaction",
    });

    expect(prompt).not.toContain(home + path.sep);
    expect(prompt).toContain("~/");
    expect(prompt).toContain("test-skill");
    expect(prompt).toContain("A test skill for path compaction");
  });

  it("does not compact explicit state-root managed skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "world-cup-soccer-openclaw-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    const prompt = withEnv(
      {
        HOME: osHome,
        OPENCLAW_HOME: osHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "world-cup-soccer-openclaw-skill",
          description: "World Cup standings lookup",
        }),
    );

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/skills/world-cup-soccer-openclaw-skill/SKILL.md");
  });

  it("does not compact explicit state-root plugin skill paths to OS-home tilde paths", () => {
    const root = path.parse(os.homedir()).root;
    const osHome = path.join(root, "data");
    const stateDir = path.join(osHome, ".openclaw");
    const skillDir = path.join(stateDir, "plugin-skills", "calendar-plugin-skill");
    const skillFile = path.join(skillDir, "SKILL.md");

    const prompt = withEnv(
      {
        HOME: osHome,
        OPENCLAW_HOME: osHome,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "calendar-plugin-skill",
          description: "Calendar plugin skill",
        }),
    );

    expect(prompt).toContain(`<location>${skillFile}</location>`);
    expect(prompt).not.toContain("~/.openclaw/plugin-skills/calendar-plugin-skill/SKILL.md");
  });

  it("compacts managed skill paths when OS-home tilde reaches the same path", () => {
    const home = os.homedir();
    const stateDir = path.join(home, ".openclaw");
    const skillDir = path.join(stateDir, "skills", "home-managed-skill");

    const prompt = withEnv(
      {
        HOME: home,
        OPENCLAW_STATE_DIR: stateDir,
        OPENCLAW_HOME: undefined,
      },
      () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(home, "workspace"),
          skillDir,
          name: "home-managed-skill",
          description: "Home managed skill",
        }),
    );

    expect(prompt).toContain("<location>~/.openclaw/skills/home-managed-skill/SKILL.md</location>");
    expect(prompt).not.toContain(`<location>${path.join(skillDir, "SKILL.md")}</location>`);
  });

  it("preserves POSIX literal backslashes after home compaction", () => {
    const home = os.homedir();
    const skillDir = path.join(home, ".openclaw-test-skills\\literal-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: home,
      skillDir,
      name: "literal-skill",
      description: "POSIX literal backslash skill",
    });

    const locationMatch = prompt.match(/<location>([^<]+)<\/location>/);
    if (!locationMatch) {
      throw new Error("expected prompt location tag");
    }
    expect(locationMatch[1]).toContain("~/");
    expect(locationMatch[1]).toContain("\\literal-skill");
  });

  it("preserves paths outside home directory", () => {
    const outsideHome = path.join(path.parse(os.homedir()).root, "openclaw-external-skills");
    const skillDir = path.join(outsideHome, "skills", "ext-skill");

    const prompt = buildPromptForFixtureSkill({
      workspaceRoot: outsideHome,
      skillDir,
      name: "ext-skill",
      description: "External skill",
    });

    expect(prompt).toMatch(/<location>[^<]+SKILL\.md<\/location>/);
    expect(prompt).toContain(path.join(skillDir, "SKILL.md"));
  });

  it("loads skills when the shared state database is unavailable", () => {
    const root = fsSync.realpathSync(
      fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-skill-load-")),
    );
    const blockedParent = path.join(root, "state-blocker");
    fsSync.writeFileSync(blockedParent, "not a directory", "utf8");
    const skillDir = path.join(root, "workspace", "skills", "available-skill");

    try {
      const prompt = withEnv({ OPENCLAW_STATE_DIR: path.join(blockedParent, "state") }, () =>
        buildPromptForFixtureSkill({
          workspaceRoot: path.join(root, "workspace"),
          skillDir,
          name: "available-skill",
          description: "Available despite missing lifecycle state",
        }),
      );

      expect(prompt).toContain("available-skill");
      expect(prompt).toContain("Available despite missing lifecycle state");
    } finally {
      fsSync.rmSync(root, { recursive: true, force: true });
    }
  });
});
