import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { closePool, materializeSkillsForUser, type SkillRow } from "./skills-mysql.js";

const db = vi.hoisted(() => ({ execute: vi.fn(), end: vi.fn() }));
vi.mock("mysql2/promise", () => ({ default: { createPool: () => db } }));
const directories: string[] = [];

afterEach(async () => {
  await closePool();
  for (const directory of directories.splice(0)) {
    await fs.rm(directory, { recursive: true, force: true });
  }
  vi.clearAllMocks();
});

it("materializes new public skills without a bundled folder and preserves prompt order across turns", async () => {
  let rows: SkillRow[] = ["z-public", "a-public"].map((name, index) => ({
    id: index + 1,
    user_id: 126,
    name,
    description: name,
    content: `---\nname: ${name}\ndescription: ${name}\n---\nOriginal instructions\n`,
    source: "workspace",
    category: "builtin",
    is_enable: 1,
    references: "",
    scripts: null,
    created_at: new Date(0),
    updated_at: new Date(0),
  }));
  db.execute.mockImplementation(async (sql: string) => {
    if (sql.includes("FROM skills")) {
      return [rows];
    }
    return [[]];
  });
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "public-skill-materialization-"));
  directories.push(workspace);
  const first = await materializeSkillsForUser(workspace, "999");
  expect(first.map((entry) => entry.skill.name)).toEqual(["a-public", "z-public"]);
  for (const row of rows) {
    expect(
      await fs.readFile(
        path.join(workspace, ".openclaw-public-skills", row.name, "SKILL.md"),
        "utf8",
      ),
    ).toBe(row.content);
  }
  // Expire the per-turn cache without sleeping; the database returns a new order.
  rows = rows.toReversed();
  const now = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(now + 6000);
  try {
    const second = await materializeSkillsForUser(workspace, "999");
    expect(second).toEqual(first);
  } finally {
    clock.mockRestore();
  }
});
