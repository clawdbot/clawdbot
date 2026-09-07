import fs from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  mergeVisibleSkillRows,
  PUBLIC_SKILL_NAMES,
  PUBLIC_SKILL_OWNER_ID,
  resolveSkillUserId,
  sanitizeSkillSegment,
  type SkillRow,
} from "./skills-mysql.js";

function skillRow(id: number, userId: number, name: string): SkillRow {
  return {
    id,
    user_id: userId,
    name,
    description: name,
    content: `---\nname: ${name}\n---\n`,
    source: "workspace",
    category: null,
    is_enable: 1,
    references: "",
    scripts: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  };
}

describe("resolveSkillUserId", () => {
  it("extracts userId from a guardian sessionKey", () => {
    expect(resolveSkillUserId("agent:rabbitmq-1749:rabbitmq:1749:session_abc")).toBe("1749");
  });

  it("falls back to the trailing number of the agentId", () => {
    expect(resolveSkillUserId(undefined, "rabbitmq-42")).toBe("42");
  });

  it("prefers the sessionKey segment over the agentId", () => {
    expect(resolveSkillUserId("agent:rabbitmq-1749:rabbitmq:1749:s1", "rabbitmq-999")).toBe("1749");
  });

  it("returns undefined when neither yields a numeric userId", () => {
    expect(resolveSkillUserId("agent:main:main", "main")).toBeUndefined();
    expect(resolveSkillUserId(undefined, undefined)).toBeUndefined();
  });
});

describe("sanitizeSkillSegment (path-traversal guard)", () => {
  it("keeps safe filenames", () => {
    expect(sanitizeSkillSegment("find-sessions.sh")).toBe("find-sessions.sh");
    expect(sanitizeSkillSegment("SKILL.md")).toBe("SKILL.md");
    expect(sanitizeSkillSegment("tmux")).toBe("tmux");
  });

  it("strips directory components and traversal", () => {
    expect(sanitizeSkillSegment("../../etc/passwd")).toBe("passwd");
    expect(sanitizeSkillSegment("/abs/path/evil.sh")).toBe("evil.sh");
    expect(sanitizeSkillSegment("nested\\win\\evil.sh")).toBe("evil.sh");
  });

  it("rejects empty/dot-only names", () => {
    expect(sanitizeSkillSegment("")).toBe("");
    expect(sanitizeSkillSegment(".")).toBe("");
    expect(sanitizeSkillSegment("..")).toBe("");
    expect(sanitizeSkillSegment(null)).toBe("");
    expect(sanitizeSkillSegment(undefined)).toBe("");
  });

  it("replaces unsafe characters with underscores", () => {
    expect(sanitizeSkillSegment("a b;rm -rf.sh")).toBe("a_b_rm_-rf.sh");
  });
});

describe("mergeVisibleSkillRows", () => {
  it("shares newly published administrator skills with a stable prompt order", () => {
    const published = { ...skillRow(50, 126, "new-builtin"), category: "builtin" };
    const rows = [
      skillRow(51, 999, "new-builtin"),
      published,
      { ...skillRow(52, 777, "other-public"), category: "builtin" },
      skillRow(53, 126, "admin-private"),
      { ...skillRow(54, 126, "disabled-public"), category: "builtin", is_enable: 0 },
      skillRow(55, 999, "my-skill"),
      { ...skillRow(56, 126, "old-shared-skill"), category: "public" },
    ];
    expect(mergeVisibleSkillRows(rows, 999).map((row) => row.id)).toEqual([55, 50]);
    expect(mergeVisibleSkillRows(rows.toReversed(), 999)).toEqual(mergeVisibleSkillRows(rows, 999));
  });

  it("publishes only the five reserved owner-126 skills to another user", () => {
    expect(PUBLIC_SKILL_OWNER_ID).toBe(126);
    expect(PUBLIC_SKILL_NAMES).toEqual([
      "institution-violation-judgment",
      "gov-public-opinion-analysis-agent",
      "ai-public-opinion-brief",
      "ai-collaboration-diagnostic",
      "infringement-judgment",
    ]);

    const rows = [
      skillRow(1, 999, "my-private-skill"),
      skillRow(2, 126, "ai-public-opinion-brief"),
      skillRow(3, 126, "infringement-judgment"),
      skillRow(4, 126, "owner-private-skill"),
    ];

    expect(mergeVisibleSkillRows(rows, 999).map((row) => row.id)).toEqual([2, 3, 1]);
  });

  it("makes the public owner row win over a user's same-named custom row", () => {
    const rows = [
      skillRow(10, 999, "ai-public-opinion-brief"),
      skillRow(11, 126, "ai-public-opinion-brief"),
      skillRow(12, 999, "my-private-skill"),
    ];

    const merged = mergeVisibleSkillRows(rows, 999);
    expect(merged.find((row) => row.name === "ai-public-opinion-brief")?.id).toBe(11);
    expect(merged.find((row) => row.name === "my-private-skill")?.id).toBe(12);
  });

  it("does not duplicate public rows for owner 126", () => {
    const rows = [skillRow(20, 126, "ai-collaboration-diagnostic")];
    expect(mergeVisibleSkillRows(rows, 126).map((row) => row.id)).toEqual([20]);
  });

  it("isolates public files from a user's same-named workspace directory", async () => {
    const source = await fs.readFile(new URL("./skills-mysql.ts", import.meta.url), "utf8");
    expect(source).toMatch(/path\.join\(workspaceDir, "\.openclaw-public-skills"\)/u);
    expect(source).toMatch(
      /await fs\.cp\(path\.join\(bundledSkillsDir, rowSlug\(row\)\), baseDir/u,
    );
  });
});
