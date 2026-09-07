import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ execute: vi.fn(), end: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createPool: () => mocks } }));
const { closePool, updateSkill } = await import("./skills-mysql.js");
const row = {
  id: 312,
  user_id: 126,
  slug: "stable-skill",
  name: "旧中文名称",
  category: "builtin",
  is_enable: 1,
};
beforeEach(() => {
  mocks.execute.mockReset();
});
afterEach(async () => {
  await closePool();
});

it.each([
  { slug: "changed-slug" },
  { category: "private" },
  { content: "---\nname: different\n---\nbody" },
  { content: "No frontmatter" },
])("rejects changes to built-in identity before any write: %j", async (patch) => {
  mocks.execute.mockResolvedValueOnce([[row]]);
  await expect(updateSkill(312, patch, 126)).rejects.toThrow(/skill|Skill/u);
  expect(mocks.execute).toHaveBeenCalledTimes(1);
});

it("allows a Chinese title change while preserving the fixed slug", async () => {
  const content = '---\nname: stable-skill\ntitle: "新中文名称"\n---\nbody';
  mocks.execute
    .mockResolvedValueOnce([[row]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[{ ...row, content }]]);
  expect((await updateSkill(312, { content }, 126))?.content).toBe(content);
  const [sql, values] = mocks.execute.mock.calls[1];
  expect(sql).toContain("SET name");
  expect(values).toContain("新中文名称");
  expect(values).toContain("stable-skill");
});

it("retains custom skill renaming and checks ownership", async () => {
  mocks.execute.mockResolvedValueOnce([[]]);
  expect(await updateSkill(312, { name: "other" }, 999)).toBeNull();
  expect(mocks.execute).toHaveBeenCalledTimes(1);
  mocks.execute
    .mockResolvedValueOnce([[{ ...row, user_id: 999, category: null }]])
    .mockResolvedValueOnce([{ affectedRows: 1 }])
    .mockResolvedValueOnce([[{ ...row, user_id: 999, category: null, name: "中文" }]]);
  expect((await updateSkill(312, { name: "中文" }, 999))?.name).toBe("中文");
});
