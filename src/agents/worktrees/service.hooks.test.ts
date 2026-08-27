import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import { ManagedWorktreeService } from "./service.js";
import { initializeManagedWorktreeTestRepository } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

describe("ManagedWorktreeService repository code isolation", () => {
  let root: string;
  let repo: string;
  let sentinel: string;
  let service: ManagedWorktreeService;

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-worktree-hooks-")));
    repo = await initializeManagedWorktreeTestRepository(root);
    sentinel = path.join(repo, ".hook-ran");
    const hooks = path.join(repo, "git-hooks");
    await fs.mkdir(hooks);
    for (const hook of ["reference-transaction", "post-checkout"]) {
      await fs.writeFile(path.join(hooks, hook), `#!/bin/sh\nprintf hook >> '${sentinel}'\n`, {
        mode: 0o755,
      });
    }
    await execFileAsync("git", ["-C", repo, "config", "core.hooksPath", "git-hooks"]);
    service = new ManagedWorktreeService({
      env: { ...process.env, OPENCLAW_STATE_DIR: path.join(root, "state") },
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  it("never executes repository hooks when creating a worktree with setup enabled", async () => {
    const created = await service.create({ repoRoot: repo, name: "default", baseRef: "HEAD" });

    await expect(fs.stat(created.path)).resolves.toBeDefined();
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when creating a worktree with setup disabled", async () => {
    await service.create({
      repoRoot: repo,
      name: "without-setup",
      baseRef: "HEAD",
      runSetupScript: false,
    });

    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when snapshotting and removing a worktree", async () => {
    const created = await service.create({ repoRoot: repo, name: "remove", baseRef: "HEAD" });
    await fs.rm(sentinel, { force: true });

    await expect(service.remove({ id: created.id, reason: "test" })).resolves.toMatchObject({
      removed: true,
      snapshotRef: expect.any(String),
    });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes repository hooks when restoring a removed worktree", async () => {
    const created = await service.create({ repoRoot: repo, name: "restore", baseRef: "HEAD" });
    await service.remove({ id: created.id, reason: "test" });
    await fs.rm(sentinel, { force: true });

    await expect(service.restore({ id: created.id })).resolves.toMatchObject({ id: created.id });
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never executes a repository filesystem monitor during lossless removal", async () => {
    const created = await service.create({ repoRoot: repo, name: "fsmonitor", baseRef: "HEAD" });
    await fs.rm(sentinel, { force: true });
    const monitor = path.join(repo, "fsmonitor.sh");
    await fs.writeFile(
      monitor,
      `#!/bin/sh\nprintf fsmonitor >> '${sentinel}'\nprintf 'token\\0'\n`,
      {
        mode: 0o755,
      },
    );
    await execFileAsync("git", ["-C", repo, "config", "core.fsmonitor", monitor]);

    await expect(service.removeIfLossless(created.id)).resolves.toBe(true);
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("still executes the explicitly enabled worktree setup script", async () => {
    const setup = path.join(repo, ".openclaw");
    await fs.mkdir(setup);
    await fs.writeFile(
      path.join(setup, "worktree-setup.sh"),
      "#!/bin/sh\nprintf setup > setup-ran.txt\n",
      { mode: 0o755 },
    );

    const created = await service.create({ repoRoot: repo, name: "setup", baseRef: "HEAD" });

    await expect(fs.readFile(path.join(created.path, "setup-ran.txt"), "utf8")).resolves.toBe(
      "setup",
    );
    await expect(fs.access(sentinel)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
