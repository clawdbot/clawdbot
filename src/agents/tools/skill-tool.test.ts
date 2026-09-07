import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SkillRow } from "../../infra/skills-mysql.js";

vi.mock("../skills/refresh-state.js", () => ({
  bumpSkillsSnapshotVersion: vi.fn(),
}));

vi.mock("../../infra/skills-mysql.js", async (importActual) => {
  const actual = await importActual<typeof import("../../infra/skills-mysql.js")>();
  return {
    ...actual,
    getSkillByName: vi.fn(),
    createSkill: vi.fn(),
    updateSkill: vi.fn(),
    listSkills: vi.fn(),
    materializeSkillsForUser: vi.fn(),
    invalidateSkillsMaterializeCache: vi.fn(),
  };
});

const { bumpSkillsSnapshotVersion } = await import("../skills/refresh-state.js");
const skillsMysql = await import("../../infra/skills-mysql.js");
const { createSkillSaveTool, createSkillGetTool, createSkillListTool } =
  await import("./skill-tool.js");

const getSkillByName = vi.mocked(skillsMysql.getSkillByName);
const createSkill = vi.mocked(skillsMysql.createSkill);
const updateSkill = vi.mocked(skillsMysql.updateSkill);
const listSkills = vi.mocked(skillsMysql.listSkills);
const materializeSkillsForUser = vi.mocked(skillsMysql.materializeSkillsForUser);
const invalidateSkillsMaterializeCache = vi.mocked(skillsMysql.invalidateSkillsMaterializeCache);
const bump = vi.mocked(bumpSkillsSnapshotVersion);

// A guardian session key whose 4th segment is the numeric skills user id.
const SESSION_KEY = "agent:rabbitmq-1749:rabbitmq:1749:session_abc";
const WORKSPACE = "/tmp/ws";

function row(over: Partial<SkillRow> = {}): SkillRow {
  return {
    id: 1,
    user_id: 1749,
    name: "flow",
    description: "d",
    content: "c",
    source: "workspace",
    category: null,
    is_enable: 1,
    references: null,
    scripts: null,
    created_at: new Date(0),
    updated_at: new Date(0),
    ...over,
  };
}

function saveTool() {
  return createSkillSaveTool({ agentSessionKey: SESSION_KEY, workspaceDir: WORKSPACE });
}

function parse(result: Awaited<ReturnType<NonNullable<ReturnType<typeof saveTool>["execute"]>>>) {
  const text = result.content.find((c) => c.type === "text");
  return JSON.parse((text as { text: string }).text);
}

beforeEach(() => {
  vi.clearAllMocks();
  materializeSkillsForUser.mockResolvedValue([]);
  listSkills.mockResolvedValue({ skills: [], total: 0 });
});

describe("skill_save", () => {
  it("rejects sessions without a numeric user id", async () => {
    const tool = createSkillSaveTool({
      agentSessionKey: "agent:main:main",
      workspaceDir: WORKSPACE,
    });
    await expect(
      tool.execute?.("id", { name: "flow", description: "d", content: "c" }),
    ).rejects.toThrow(/per-user agent session/);
  });

  it.each([["bad name"], [".."], ["a/b"], ["a\\b"], [""]])(
    "rejects unsafe name %j",
    async (name) => {
      await expect(
        saveTool().execute?.("id", { name, description: "d", content: "c" }),
      ).rejects.toThrow();
    },
  );

  it("rejects oversized content", async () => {
    const content = "x".repeat(200_001);
    await expect(
      saveTool().execute?.("id", { name: "flow", description: "d", content }),
    ).rejects.toThrow(/content too large/);
  });

  it("rejects oversized description", async () => {
    await expect(
      saveTool().execute?.("id", { name: "flow", description: "d".repeat(1025), content: "c" }),
    ).rejects.toThrow(/description too long/);
  });

  it("rejects oversized category", async () => {
    await expect(
      saveTool().execute?.("id", {
        name: "flow",
        description: "d",
        content: "c",
        category: "c".repeat(129),
      }),
    ).rejects.toThrow(/category too long/);
  });

  it("resolves the user id from the agentId fallback when no session key", async () => {
    getSkillByName.mockResolvedValue(null);
    createSkill.mockResolvedValue(row({ id: 5 }));
    const tool = createSkillSaveTool({ agentId: "rabbitmq-2024", workspaceDir: WORKSPACE });

    await tool.execute?.("id", { name: "flow", description: "d", content: "c" });
    expect(createSkill).toHaveBeenCalledWith(expect.anything(), 2024);
  });

  it("returns a sanitized error (no raw DB detail) when the lookup fails", async () => {
    getSkillByName.mockRejectedValue(new Error("Access denied for user 'btclaw'@'10.0.0.5'"));
    await expect(
      saveTool().execute?.("id", { name: "flow", description: "d", content: "c" }),
    ).rejects.toThrow(/Could not reach the skill library/);
  });

  it("returns a sanitized error (no raw DB detail) when the write fails", async () => {
    getSkillByName.mockResolvedValue(null);
    createSkill.mockRejectedValue(new Error("Access denied for user 'btclaw'@'10.0.0.5'"));
    await expect(
      saveTool().execute?.("id", { name: "flow", description: "d", content: "c" }),
    ).rejects.toThrow(/Could not save the skill/);
  });

  it("requires description and content when creating a brand-new skill", async () => {
    getSkillByName.mockResolvedValue(null);
    await expect(saveTool().execute?.("id", { name: "flow", content: "c" })).rejects.toThrow(
      /both description and content are required/,
    );
    expect(createSkill).not.toHaveBeenCalled();
  });

  it("creates a new skill when none exists, tagging source=workspace", async () => {
    getSkillByName.mockResolvedValue(null);
    createSkill.mockResolvedValue(row({ id: 42 }));

    const result = await saveTool().execute?.("id", {
      name: "my-flow",
      description: "summarize the daily report",
      content: "# do the thing",
      category: "reports",
    });

    expect(createSkill).toHaveBeenCalledWith(
      {
        name: "my-flow",
        slug: "my-flow",
        description: "summarize the daily report",
        content: "# do the thing",
        source: "workspace",
        category: "reports",
      },
      1749,
    );
    expect(updateSkill).not.toHaveBeenCalled();
    const payload = parse(result);
    expect(payload).toMatchObject({ ok: true, action: "created", id: 42, name: "my-flow" });
  });

  it("overwrites an existing same-named skill (upsert)", async () => {
    getSkillByName.mockResolvedValue(row({ id: 7 }));
    updateSkill.mockResolvedValue(row({ id: 7 }));

    const result = await saveTool().execute?.("id", {
      name: "flow",
      description: "new desc",
      content: "new body",
    });

    expect(updateSkill).toHaveBeenCalledWith(
      7,
      expect.objectContaining({
        slug: "flow",
        description: "new desc",
        is_enable: 1,
        source: "workspace",
      }),
      1749,
    );
    expect(createSkill).not.toHaveBeenCalled();
    expect(parse(result)).toMatchObject({ action: "updated", id: 7 });
  });

  it("edits only the supplied fields on an existing skill", async () => {
    getSkillByName.mockResolvedValue(row({ id: 7, description: "old desc", content: "old body" }));
    updateSkill.mockResolvedValue(row({ id: 7 }));

    await saveTool().execute?.("id", { name: "flow", description: "new desc" });

    const [, patch] = updateSkill.mock.calls[0] ?? [];
    expect(patch).toMatchObject({ slug: "flow", description: "new desc", is_enable: 1 });
    expect(patch).not.toHaveProperty("name");
    expect(patch).not.toHaveProperty("content");
    expect(patch).not.toHaveProperty("category");
  });

  it("refreshes visibility: invalidate + materialize + bump version", async () => {
    getSkillByName.mockResolvedValue(null);
    createSkill.mockResolvedValue(row({ id: 1 }));

    await saveTool().execute?.("id", { name: "flow", description: "d", content: "c" });

    expect(invalidateSkillsMaterializeCache).toHaveBeenCalledOnce();
    expect(materializeSkillsForUser).toHaveBeenCalledWith(WORKSPACE, "1749");
    expect(bump).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceDir: WORKSPACE, changedPath: "skills/flow/SKILL.md" }),
    );
  });

  it("still succeeds when the post-save materialize fails", async () => {
    getSkillByName.mockResolvedValue(null);
    createSkill.mockResolvedValue(row({ id: 1 }));
    materializeSkillsForUser.mockRejectedValue(new Error("db down"));

    const result = await saveTool().execute?.("id", {
      name: "flow",
      description: "d",
      content: "c",
    });
    expect(parse(result)).toMatchObject({ ok: true, action: "created" });
    expect(bump).toHaveBeenCalledOnce();
  });
});

describe("skill_get", () => {
  it("returns the stored body so an edit round-trips through the catalog", async () => {
    getSkillByName.mockResolvedValue(
      row({
        id: 9,
        slug: "flow",
        name: "中文显示名称",
        description: "d",
        content: "# stored body",
      }),
    );
    const result = await createSkillGetTool({ agentSessionKey: SESSION_KEY }).execute?.("id", {
      name: "flow",
    });
    expect(parse(result)).toMatchObject({
      ok: true,
      found: true,
      id: 9,
      name: "flow",
      title: "中文显示名称",
      content: "# stored body",
    });
    expect(getSkillByName).toHaveBeenCalledWith("flow", 1749);
  });

  it("reports a miss instead of inventing content", async () => {
    getSkillByName.mockResolvedValue(null);
    const result = await createSkillGetTool({ agentSessionKey: SESSION_KEY }).execute?.("id", {
      name: "nope",
    });
    expect(parse(result)).toMatchObject({ ok: true, found: false, name: "nope" });
  });

  it("returns a sanitized error when the lookup fails", async () => {
    getSkillByName.mockRejectedValue(new Error("ETIMEDOUT 10.0.0.5:3306"));
    await expect(
      createSkillGetTool({ agentSessionKey: SESSION_KEY }).execute?.("id", { name: "flow" }),
    ).rejects.toThrow(/Could not reach the skill library/);
  });
});

describe("skill_list", () => {
  it("lists the user's skills", async () => {
    listSkills.mockResolvedValue({
      skills: [row({ id: 3, name: "alpha", description: "a", is_enable: 1, source: "agent" })],
      total: 1,
    });
    const tool = createSkillListTool({ agentSessionKey: SESSION_KEY });
    const result = await tool.execute?.("id", {});
    const text = result.content.find((c) => c.type === "text") as { text: string };
    const payload = JSON.parse(text.text);
    expect(payload).toMatchObject({
      ok: true,
      total: 1,
      skills: [{ id: 3, name: "alpha", description: "a", enabled: true, source: "agent" }],
    });
    expect(listSkills).toHaveBeenCalledWith(1749, { limit: undefined });
  });

  it("passes a positive limit through", async () => {
    listSkills.mockResolvedValue({ skills: [], total: 0 });
    await createSkillListTool({ agentSessionKey: SESSION_KEY }).execute?.("id", { limit: 10 });
    expect(listSkills).toHaveBeenCalledWith(1749, { limit: 10 });
  });

  it("returns a sanitized error when listing fails", async () => {
    listSkills.mockRejectedValue(new Error("ETIMEDOUT 10.0.0.5:3306"));
    await expect(
      createSkillListTool({ agentSessionKey: SESSION_KEY }).execute?.("id", {}),
    ).rejects.toThrow(/Could not list skills/);
  });
});
