import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  return stdout.trim();
}

describe("ManagedWorktreeService naming", () => {
  let root: string;
  let repo: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    root = await fs.mkdtemp(path.join(tempRoot, "openclaw-worktree-naming-"));
    repo = path.join(root, "repo");
    await fs.mkdir(repo);
    await git(repo, "init", "-b", "main");
    await git(repo, "config", "user.name", "OpenClaw Test");
    await git(repo, "config", "user.email", "openclaw-test@example.invalid");
    await fs.writeFile(path.join(repo, "README.md"), "base\n");
    await git(repo, "add", "README.md");
    await git(repo, "commit", "-m", "initial");
    repo = await fs.realpath(repo);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("uses readable defaults and numbers colliding inferred names", async () => {
    const fallback = await service.create({ repoRoot: repo });
    await service.create({ repoRoot: repo, name: "release-planning" });
    const second = await service.create({ repoRoot: repo, suggestedName: "release-planning" });

    expect(fallback.name).toMatch(
      /^[a-z]+-(?:barnacle|claw|crab|crayfish|krill|langoustine|lobster|prawn|shrimp|shell)$/,
    );
    expect(second.name).toBe("release-planning-2");
  });

  it("numbers inferred names around unmanaged Git and filesystem collisions", async () => {
    const anchor = await service.create({ repoRoot: repo, name: "anchor" });
    await git(repo, "branch", "openclaw/release-planning");
    await fs.mkdir(path.join(path.dirname(anchor.path), "release-planning-2"));

    const created = await service.create({ repoRoot: repo, suggestedName: "release-planning" });

    expect(created.name).toBe("release-planning-3");
  });

  it("serializes concurrent inferred-name creation", async () => {
    const created = await Promise.all([
      service.create({ repoRoot: repo, suggestedName: "concurrent-task" }),
      service.create({ repoRoot: repo, suggestedName: "concurrent-task" }),
    ]);

    expect(created.map((record) => record.name).toSorted()).toEqual([
      "concurrent-task",
      "concurrent-task-2",
    ]);
  });

  it("reuses concurrent inferred names for the same owner", async () => {
    const owner = {
      repoRoot: repo,
      ownerKind: "session" as const,
      ownerId: "agent:main:session-1",
    };
    const created = await Promise.all([
      service.create({ ...owner, suggestedName: "first-session-title" }),
      service.create({ ...owner, suggestedName: "second-session-title" }),
    ]);

    expect(created[0]?.id).toBe(created[1]?.id);
    expect(created[0]?.name).toMatch(/^(?:first|second)-session-title$/);
    expect(
      (await service.list()).filter((record) => record.ownerId === owner.ownerId),
    ).toHaveLength(1);
  });

  it("serializes overlapping numeric suffix families", async () => {
    await service.create({ repoRoot: repo, name: "task" });

    const created = await Promise.all([
      service.create({ repoRoot: repo, suggestedName: "task" }),
      service.create({ repoRoot: repo, suggestedName: "task-2" }),
    ]);
    const names = created.map((record) => record.name);

    expect(new Set(names).size).toBe(2);
    expect(names).toContain("task-2");
    expect(names.every((name) => /^task-(?:2-2|3|2)$/.test(name))).toBe(true);
  });
});
