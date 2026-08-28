import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import * as commandRunner from "../../process/exec-runner.js";
import { closeOpenClawStateDatabaseForTest } from "../../state/openclaw-state-db.js";
import {
  deleteRegistryWorktree,
  finalizeWorktreeRemovalRows,
  getRegistryWorktree,
  getRegistryWorktreeProvisionedChunk,
  getRegistryWorktreeProvisionedPaths,
  getRegistryWorktreeProvisionedState,
  listRegistryWorktrees,
} from "./registry.js";
import { IDLE_GC_MS, ManagedWorktreeService } from "./service.js";
import { materializeManagedWorktreeFixture } from "./service.test-support.js";

const execFileAsync = promisify(execFile);

function expectCheckoutTimeouts(
  commandSpy: MockInstance<typeof commandRunner.runCommandWithTimeout>,
  checkoutBases: string[],
) {
  const gitCommands = commandSpy.mock.calls
    .filter(([argv]) => argv[0] === "git")
    .map(([argv, options]) => ({
      checkout: argv[3] === "worktree" && argv[4] === "add",
      base: argv.at(-1),
      timeoutMs: typeof options === "number" ? options : options.timeoutMs,
    }));
  expect(gitCommands.filter((command) => command.checkout)).toEqual(
    checkoutBases.map((base) => ({ checkout: true, base, timeoutMs: 300_000 })),
  );
  expect(
    new Set(gitCommands.filter((command) => !command.checkout).map((command) => command.timeoutMs)),
  ).toEqual(new Set([120_000]));
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
  });
  return stdout.trim();
}

async function gitWithInput(cwd: string, args: string[], input: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    const child = execFile("git", ["-C", cwd, ...args], { encoding: "utf8" }, (error, stdout) => {
      if (error) {
        reject(new Error(error.message, { cause: error }));
      } else {
        resolve(stdout.trim());
      }
    });
    child.stdin?.end(input);
  });
}

async function initializeRepository(
  root: string,
  gitTemplate: string,
  name = "repo",
): Promise<string> {
  const repo = path.join(root, name);
  await fs.mkdir(repo, { recursive: true });
  await git(repo, "init", "-b", "main", `--template=${gitTemplate}`);
  await git(repo, "config", "user.name", "OpenClaw Test");
  await git(repo, "config", "user.email", "openclaw-test@example.invalid");
  await fs.writeFile(path.join(repo, "README.md"), "base\n");
  await git(repo, "add", "README.md");
  await git(repo, "commit", "-m", "initial");
  return await fs.realpath(repo);
}

async function addRemote(root: string, repo: string): Promise<string> {
  const remote = path.join(root, "remote.git");
  await execFileAsync("git", ["clone", "--bare", repo, remote]);
  await git(repo, "remote", "add", "origin", remote);
  await git(repo, "push", "-u", "origin", "main");
  await git(repo, "remote", "set-head", "origin", "-a");
  return remote;
}

describe("ManagedWorktreeService", () => {
  let templateRoot: string;
  let templateRepo: string;
  let gitTemplate: string;
  let stateDir: string;
  let root: string;
  let repo: string;
  let env: NodeJS.ProcessEnv;
  let now: number;
  let service: ManagedWorktreeService;
  let caseOrdinal = 0;

  // Snapshot/removal/GC tests need the real Git-worktree + registry boundary,
  // while create policy and provisioning composition stay covered above.
  async function materializeDownstreamFixture(
    name: string,
    params: {
      ownerKind?: "manual" | "session" | "workboard";
      ownerId?: string;
      provisionedPaths?: readonly string[];
      repoRoot?: string;
    } = {},
  ) {
    return await materializeManagedWorktreeFixture({
      env,
      name,
      now,
      repoRoot: params.repoRoot ?? repo,
      stateDir,
      ...params,
    });
  }

  beforeAll(async () => {
    const tempRoot = await fs.realpath(os.tmpdir());
    templateRoot = await fs.mkdtemp(path.join(tempRoot, "openclaw-managed-worktrees-template-"));
    gitTemplate = path.join(templateRoot, "git-template");
    stateDir = path.join(templateRoot, "state");
    // Keep the hooks directory expected by hook-safety coverage without copying
    // the host's sample hooks into every per-test repository.
    await fs.mkdir(path.join(gitTemplate, "hooks"), { recursive: true });
    templateRepo = await initializeRepository(templateRoot, gitTemplate);
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(templateRoot, { recursive: true, force: true });
  });

  beforeEach(async () => {
    root = path.join(templateRoot, `case-${caseOrdinal++}`);
    await fs.mkdir(root);
    repo = path.join(root, "repo");
    await fs.cp(templateRepo, repo, {
      mode: fsConstants.COPYFILE_FICLONE,
      recursive: true,
    });
    repo = await fs.realpath(repo);
    env = { ...process.env, OPENCLAW_STATE_DIR: stateDir };
    now = 1_700_000_000_000;
    service = new ManagedWorktreeService({ env, now: () => now });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const record of listRegistryWorktrees(env)) {
      finalizeWorktreeRemovalRows(env, record.id);
      deleteRegistryWorktree(env, record.id);
    }
    await fs.rm(path.join(stateDir, "worktrees"), { recursive: true, force: true });
  });

  it("creates from origin HEAD and returns the existing live named worktree", async () => {
    await addRemote(root, repo);
    const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
    const created = await service.create({ repoRoot: repo, name: "remote-task" });
    const repeated = await service.create({ repoRoot: repo, name: "remote-task" });

    expect(created.baseRef).toBe("origin/main");
    expect(created.branch).toBe("openclaw/remote-task");
    expect(created.path).toContain(path.join("worktrees", created.repoFingerprint, "remote-task"));
    expect(await git(created.path, "branch", "--show-current")).toBe(created.branch);
    expect(repeated).toEqual(created);
    expectCheckoutTimeouts(commandSpy, ["origin/main"]);
  });

  it("reads registry records without retiring a temporarily unavailable worktree", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "read-only-list",
      baseRef: "HEAD",
    });
    await fs.rm(created.path, { recursive: true, force: true });

    expect(service.listRegistryRecords()).toEqual([expect.objectContaining({ id: created.id })]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();

    expect(await service.list()).toEqual([]);
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBe(now);
  });

  it("does not remove a worktree owned by another caller", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "session-owned",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "session-1",
    });

    await expect(
      service.removeIfLosslessByPath(created.path, {
        ownerKind: "workboard",
        ownerId: "card-1",
      }),
    ).resolves.toBe(false);
    await expect(fs.stat(created.path)).resolves.toBeDefined();
  });

  it("lists repository branches default-first with deterministic ordering", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "feature-a");
    await git(repo, "push", "origin", "feature-a");
    await git(repo, "branch", "-D", "feature-a");
    await git(repo, "branch", "zeta-local");
    await git(repo, "checkout", "-b", "current-work");

    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBe("main");
    expect(result.headBranch).toBe("current-work");
    // Remote-only branches keep their remote-qualified form so the returned
    // name always resolves as a git worktree base ref.
    expect(result.branches.map((branch) => branch.name)).toEqual([
      "main",
      "current-work",
      "origin/feature-a",
      "zeta-local",
    ]);
    expect(result.branches.find((branch) => branch.name === "origin/feature-a")?.kind).toBe(
      "remote",
    );
    expect(result.branches.find((branch) => branch.name === "main")?.kind).toBe("local");
  });

  it("creates a worktree from a remote-only branch ref returned by the picker", async () => {
    await addRemote(root, repo);
    await git(repo, "checkout", "-b", "remote-only");
    await fs.writeFile(path.join(repo, "remote-only.txt"), "remote\n");
    await git(repo, "add", "remote-only.txt");
    await git(repo, "commit", "-m", "remote only commit");
    await git(repo, "push", "origin", "remote-only");
    const remoteCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");
    await git(repo, "branch", "-D", "remote-only");

    const listed = await service.listRepositoryBranches(repo);
    const remoteRef = listed.branches.find((branch) => branch.kind === "remote")?.name;
    expect(remoteRef).toBe("origin/remote-only");
    const created = await service.create({
      repoRoot: repo,
      name: "from-remote",
      baseRef: remoteRef,
    });
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(remoteCommit);
    expect(
      await git(created.path, "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"),
    ).toBe("origin/remote-only");
  });

  it("lists local branches without a remote", async () => {
    await git(repo, "branch", "side");
    const result = await service.listRepositoryBranches(repo);
    expect(result.defaultBranch).toBeUndefined();
    expect(result.headBranch).toBe("main");
    expect(result.branches.map((branch) => branch.name)).toEqual(["main", "side"]);
    expect(result.branches.every((branch) => branch.kind === "local")).toBe(true);
  });

  it("creates a worktree from an explicit base ref", async () => {
    await git(repo, "checkout", "-b", "base-branch");
    await fs.writeFile(path.join(repo, "base.txt"), "base branch file\n");
    await git(repo, "add", "base.txt");
    await git(repo, "commit", "-m", "base branch commit");
    const baseCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "based-task",
      baseRef: "base-branch",
    });
    expect(created.baseRef).toBe("base-branch");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(baseCommit);
  });

  it("normalizes dashed refs and revision expressions before creating branches", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "history.txt"), "second\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "second commit");
    const secondCommit = await git(repo, "rev-parse", "HEAD");
    await fs.appendFile(path.join(repo, "history.txt"), "third\n");
    await git(repo, "add", "history.txt");
    await git(repo, "commit", "-m", "third commit");
    const thirdCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--force", thirdCommit);
    await git(repo, "reset", "--hard", initialCommit);

    const fromRef = await service.create({
      repoRoot: repo,
      name: "dashed-ref",
      baseRef: "--force",
    });
    const fromExpression = await service.create({
      repoRoot: repo,
      name: "dashed-expression",
      baseRef: "--force~1",
    });

    expect(fromRef.baseRef).toBe("--force");
    expect(await git(fromRef.path, "rev-parse", "HEAD")).toBe(thirdCommit);
    expect(fromExpression.baseRef).toBe("--force~1");
    expect(await git(fromExpression.path, "rev-parse", "HEAD")).toBe(secondCommit);
  });

  it("preserves Git's bare-dash previous-checkout shorthand", async () => {
    await git(repo, "checkout", "-b", "previous");
    await fs.writeFile(path.join(repo, "previous.txt"), "previous\n");
    await git(repo, "add", "previous.txt");
    await git(repo, "commit", "-m", "previous checkout commit");
    const previousCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "checkout", "main");

    const created = await service.create({
      repoRoot: repo,
      name: "previous-checkout",
      baseRef: "-",
    });

    expect(created.baseRef).toBe("-");
    expect(await git(created.path, "rev-parse", "HEAD")).toBe(previousCommit);
  });

  it("rejects ambiguous dashed refs instead of choosing by ref precedence", async () => {
    const initialCommit = await git(repo, "rev-parse", "HEAD");
    await fs.writeFile(path.join(repo, "tag.txt"), "tag\n");
    await git(repo, "add", "tag.txt");
    await git(repo, "commit", "-m", "tag candidate");
    const tagCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "reset", "--hard", initialCommit);
    await fs.writeFile(path.join(repo, "branch.txt"), "branch\n");
    await git(repo, "add", "branch.txt");
    await git(repo, "commit", "-m", "branch candidate");
    const branchCommit = await git(repo, "rev-parse", "HEAD");
    await git(repo, "update-ref", "refs/tags/--ambiguous", tagCommit);
    await git(repo, "update-ref", "refs/heads/--ambiguous", branchCommit);
    await git(repo, "config", "core.warnAmbiguousRefs", "false");

    await expect(
      service.create({
        repoRoot: repo,
        name: "ambiguous-ref",
        baseRef: "--ambiguous",
      }),
    ).rejects.toThrow(/git rev-parse --symbolic-full-name --verify failed/);

    expect(await git(repo, "branch", "--list", "openclaw/ambiguous-ref")).toBe("");
    expect(await service.list()).toEqual([]);
  });

  it.each(["--lock", "--orphan"])(
    "rejects absent dashed base %s without creating worktree state",
    async (baseRef) => {
      const before = await git(repo, "worktree", "list", "--porcelain");
      const name = baseRef.slice(2);

      await expect(service.create({ repoRoot: repo, name, baseRef })).rejects.toThrow(
        /git rev-parse --symbolic-full-name --verify failed/,
      );

      expect(await git(repo, "worktree", "list", "--porcelain")).toBe(before);
      expect(await git(repo, "branch", "--list", `openclaw/${name}`)).toBe("");
      expect(await service.list()).toEqual([]);
      await expect(fs.readdir(path.join(env.OPENCLAW_STATE_DIR!, "worktrees"))).resolves.toEqual(
        [],
      );
    },
  );

  it("rejects name reuse across owners instead of adopting a foreign worktree", async () => {
    await service.create({
      repoRoot: repo,
      name: "shared-name",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    await expect(
      service.create({
        repoRoot: repo,
        name: "shared-name",
        baseRef: "HEAD",
        ownerKind: "session",
        ownerId: "agent:main:dashboard:two",
      }),
    ).rejects.toThrow(/already in use by session/);
    await expect(
      service.create({ repoRoot: repo, name: "shared-name", baseRef: "HEAD" }),
    ).rejects.toThrow(/already in use by session/);
    // The rightful owner still reuses its record.
    const reused = await service.create({
      repoRoot: repo,
      name: "shared-name",
      baseRef: "HEAD",
      ownerKind: "session",
      ownerId: "agent:main:dashboard:one",
    });
    expect(reused.ownerId).toBe("agent:main:dashboard:one");
  });

  it("does not remove a concurrent successful create during remote fallback", async () => {
    await addRemote(root, repo);

    const results = await Promise.allSettled([
      service.create({ repoRoot: repo, name: "concurrent" }),
      service.create({ repoRoot: repo, name: "concurrent" }),
    ]);
    const created = results.find(
      (result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof service.create>>> =>
        result.status === "fulfilled",
    )?.value;

    expect(created).toBeDefined();
    if (!created) {
      throw new Error("expected one concurrent create to succeed");
    }
    expect(await git(repo, "worktree", "list", "--porcelain")).toContain(created.path);
    expect(await git(created.path, "branch", "--show-current")).toBe("openclaw/concurrent");
  });

  it("falls back to local HEAD when fetch fails", async () => {
    await git(repo, "remote", "add", "origin", path.join(root, "missing.git"));
    const created = await service.create({ repoRoot: repo, name: "offline" });
    expect(created.baseRef).toBe("HEAD");
    expect(await fs.readFile(path.join(created.path, "README.md"), "utf8")).toBe("base\n");
  });

  it.each(["active", "aborted", "closed"] as const)(
    "handles stale remote checkout with %s admission",
    async (admission) => {
      await addRemote(root, repo);
      const blob = await git(repo, "rev-parse", "HEAD:README.md");
      const tooLongForCheckout = "x".repeat(300);
      const tree = await gitWithInput(
        repo,
        ["mktree"],
        `100644 blob ${blob}\t${tooLongForCheckout}\n`,
      );
      const remoteCommit = await git(repo, "commit-tree", tree, "-p", "HEAD", "-m", "bad remote");
      await git(repo, "push", "--force", "origin", `${remoteCommit}:refs/heads/main`);
      const runCommand = commandRunner.runCommandWithTimeout;
      const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
      const controller = new AbortController();
      const closed = new Error("admission closed");
      let authorityClosed = false;
      commandSpy.mockImplementation(async (...args) => {
        const result = await runCommand(...args);
        if (args[0][3] === "worktree" && args[0][4] === "add" && result.code !== 0) {
          if (admission === "aborted") {
            controller.abort(closed);
          }
          authorityClosed = admission === "closed";
        }
        return result;
      });
      const creation = service.create({
        repoRoot: repo,
        name: "stale-remote",
        signal: controller.signal,
        commitGuard: () => {
          if (authorityClosed) {
            throw closed;
          }
        },
      });
      if (admission !== "active") {
        await expect(creation).rejects.toMatchObject(
          admission === "aborted" ? { code: "OPENCLAW_STATE_LEASE_ABORTED" } : closed,
        );
        expectCheckoutTimeouts(commandSpy, ["origin/main"]);
        expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("stale-remote");
        expect(await git(repo, "branch", "--list", "openclaw/stale-remote")).toBe("");
        return;
      }
      const created = await creation;
      expect(created.baseRef).toBe("HEAD");
      expect(await git(created.path, "rev-parse", "HEAD")).toBe(
        await git(repo, "rev-parse", "HEAD"),
      );
      expectCheckoutTimeouts(commandSpy, ["origin/main", "HEAD"]);
    },
  );

  it("preserves a pre-existing branch when a managed name collides", async () => {
    await addRemote(root, repo);
    await git(repo, "branch", "openclaw/existing-name", "HEAD");
    const branchTip = await git(repo, "rev-parse", "openclaw/existing-name");

    await expect(service.create({ repoRoot: repo, name: "existing-name" })).rejects.toThrow(
      "branch already exists",
    );

    expect(await git(repo, "rev-parse", "openclaw/existing-name")).toBe(branchTip);
  });

  it("copies only included ignored regular files without following symlinks", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "cache/\nlinked\nlinked-dir/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "cache/*.txt\nlinked\nlinked-dir/**\n");
    await fs.mkdir(path.join(repo, "cache"));
    await fs.writeFile(path.join(repo, "cache", "keep.txt"), "keep\n");
    await fs.chmod(path.join(repo, "cache", "keep.txt"), 0o744);
    await fs.writeFile(path.join(repo, "cache", "skip.bin"), "skip\n");
    const outside = path.join(root, "outside.txt");
    await fs.writeFile(outside, "outside\n");
    await fs.symlink(outside, path.join(repo, "linked"));
    const outsideDir = path.join(root, "outside-dir");
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "escape.txt"), "outside\n");
    await fs.symlink(outsideDir, path.join(repo, "linked-dir"));

    const created = await service.create({ repoRoot: repo, name: "includes", baseRef: "HEAD" });
    const copied = path.join(created.path, "cache", "keep.txt");
    expect(await fs.readFile(copied, "utf8")).toBe("keep\n");
    expect((await fs.stat(copied)).mode & 0o777).toBe(0o744);
    expect(getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual(["cache/keep.txt"]);
    await expect(fs.stat(path.join(created.path, "cache", "skip.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(created.path, "linked"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(
      fs.stat(path.join(created.path, "linked-dir", "escape.txt")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never overwrites a base-ref file with an ignored source candidate", async () => {
    await fs.writeFile(path.join(repo, "collision.txt"), "from base\n", { mode: 0o644 });
    await git(repo, "add", "collision.txt");
    await git(repo, "commit", "-m", "base collision");
    await git(repo, "checkout", "-b", "source");
    await git(repo, "rm", "collision.txt");
    await fs.writeFile(path.join(repo, ".gitignore"), "collision.txt\n");
    await git(repo, "add", ".gitignore");
    await git(repo, "commit", "-m", "ignore local collision");
    await fs.writeFile(path.join(repo, "collision.txt"), "from source\n", { mode: 0o755 });
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "collision.txt\n");

    const created = await service.create({
      repoRoot: repo,
      name: "no-overwrite",
      baseRef: "main",
    });

    expect(await fs.readFile(path.join(created.path, "collision.txt"), "utf8")).toBe("from base\n");
    expect((await fs.stat(path.join(created.path, "collision.txt"))).mode & 0o111).toBe(0);
    expect(getRegistryWorktreeProvisionedPaths(env, created.id)).toEqual([]);
  });

  it("runs an executable setup script with source and worktree paths", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    await fs.writeFile(
      script,
      '#!/bin/sh\nprintf "%s\\n%s\\n" "$OPENCLAW_SOURCE_TREE_PATH" "$OPENCLAW_WORKTREE_PATH" > setup-paths.txt\n',
      { mode: 0o755 },
    );
    const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
    const created = await service.create({ repoRoot: repo, name: "setup", baseRef: "HEAD" });
    expect(
      (await fs.readFile(path.join(created.path, "setup-paths.txt"), "utf8")).split("\n"),
    ).toEqual([repo, created.path, ""]);
    expect(
      commandSpy.mock.calls
        .filter(([argv]) => argv[0] === script)
        .map(([, options]) => (typeof options === "number" ? options : options.timeoutMs)),
    ).toEqual([120_000]);
  });

  it("does not execute repository hooks or setup scripts when setup is disabled", async () => {
    const hookMarker = path.join(root, "checkout-hook-ran");
    const setupMarker = path.join(root, "setup-script-ran");
    await fs.writeFile(
      path.join(repo, ".git", "hooks", "post-checkout"),
      `#!/bin/sh\nprintf ran > "${hookMarker}"\n`,
      { mode: 0o755 },
    );
    await fs.mkdir(path.join(repo, ".openclaw"));
    await fs.writeFile(
      path.join(repo, ".openclaw", "worktree-setup.sh"),
      `#!/bin/sh\nprintf ran > "${setupMarker}"\n`,
      { mode: 0o755 },
    );

    await service.create({
      repoRoot: repo,
      name: "no-repo-code",
      baseRef: "HEAD",
      runSetupScript: false,
    });

    await expect(fs.access(hookMarker)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(setupMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("bounds failed setup diagnostics without losing the fatal detail or cleanup", async () => {
    await fs.mkdir(path.join(repo, ".openclaw"));
    const script = path.join(repo, ".openclaw", "worktree-setup.sh");
    const fatal = "fatal: setup dependency could not be resolved";
    const progress = Array.from(
      { length: 2_000 },
      (_, index) => `Receiving objects: ${index}/2000\r`,
    ).join("");
    await fs.writeFile(
      script,
      `#!/bin/sh\nprintf '%s\\n' "$OPENCLAW_WORKTREE_PATH" > "$OPENCLAW_SOURCE_TREE_PATH/setup-path.txt"\nprintf '%s' '${progress}\n${"x".repeat(65_536)}${fatal}\n' >&2\nexit 23\n`,
      { mode: 0o755 },
    );
    const failure: unknown = await service
      .create({ repoRoot: repo, name: "broken-setup", baseRef: "HEAD" })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) {
      throw new Error("expected setup failure");
    }
    const worktreePath = (await fs.readFile(path.join(repo, "setup-path.txt"), "utf8")).trim();
    await expect(fs.stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "worktree", "list", "--porcelain")).not.toContain("broken-setup");
    expect(await git(repo, "branch", "--list", "openclaw/broken-setup")).toBe("");
    expect(service.listRegistryRecords()).toEqual([]);
    expect.soft(failure.message).toContain(fatal);
    expect.soft(failure.message.length).toBeLessThanOrEqual(2_300);
    expect.soft(/(?:exit|code|status)[^\n]*23/i.test(failure.message)).toBe(true);
  });

  it("restores tracked, untracked, and provisioned ignored files from the snapshot", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), "ignored.txt\nprovisioned.env\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), "provisioned.env\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, "provisioned.env"), "source value\n");
    const mode = (await fs.stat(path.join(repo, "provisioned.env"))).mode & 0o7777;
    const created = await materializeDownstreamFixture("roundtrip", {
      provisionedPaths: ["provisioned.env"],
    });
    const originalHead = await git(created.path, "rev-parse", "HEAD");
    await fs.writeFile(path.join(created.path, "README.md"), "changed\n");
    await fs.writeFile(path.join(created.path, "untracked.txt"), "untracked\n");
    await fs.writeFile(path.join(created.path, "ignored.txt"), "ignored\n");

    const removed = await service.remove({ id: created.id, reason: "test" });
    expect(removed).toMatchObject({ removed: true, snapshotRef: expect.any(String) });
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await git(repo, "show-ref", "--verify", removed.snapshotRef!)).not.toBe("");
    const provisionedState = getRegistryWorktreeProvisionedState(env, created.id)!;
    expect(provisionedState).toEqual([{ path: "provisioned.env", mode, chunks: 1 }]);
    const snapshotFiles = await git(repo, "ls-tree", "-r", "--name-only", removed.snapshotRef!);
    expect(snapshotFiles).not.toContain("ignored.txt");
    expect(snapshotFiles).not.toContain("provisioned.env");
    await fs.writeFile(path.join(repo, "provisioned.env"), "new source value\n");

    now += IDLE_GC_MS + 1;
    const commandSpy = vi.spyOn(commandRunner, "runCommandWithTimeout");
    const restored = await service.restore({ id: created.id });
    expectCheckoutTimeouts(commandSpy, [removed.snapshotRef!]);
    expect(restored.removedAt).toBeUndefined();
    expect(restored.lastActiveAt).toBe(now);
    expect((await service.gc()).removed).toEqual([]);
    expect(await git(restored.path, "branch", "--show-current")).toBe(created.branch);
    expect(await git(restored.path, "rev-parse", "HEAD")).toBe(originalHead);
    expect(await git(restored.path, "log", "--format=%s", created.branch)).not.toContain(
      "OpenClaw worktree snapshot",
    );
    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe("changed\n");
    expect(await fs.readFile(path.join(restored.path, "untracked.txt"), "utf8")).toBe(
      "untracked\n",
    );
    expect(await fs.readFile(path.join(restored.path, "provisioned.env"), "utf8")).toBe(
      "source value\n",
    );
    expect(
      getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: created.id,
        path: "provisioned.env",
        chunkIndex: 0,
      }),
    ).toBeDefined();
    await expect(fs.stat(path.join(restored.path, "ignored.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect((await git(restored.path, "status", "--porcelain")).split("\n")).toEqual([
      "M README.md",
      "?? untracked.txt",
    ]);
    expect(await git(restored.path, "diff", "--cached", "--name-only")).toBe("");
    expect(await git(restored.path, "diff", "--name-only")).toBe("README.md");
  });

  it("captures tracked executable-bit changes when core.filemode is disabled", async () => {
    const script = path.join(repo, "tool.sh");
    await fs.writeFile(script, "#!/bin/sh\n", { mode: 0o755 });
    await git(repo, "add", "tool.sh");
    await git(repo, "update-index", "--chmod=+x", "tool.sh");
    await git(repo, "commit", "-m", "add executable");
    await git(repo, "config", "core.filemode", "false");

    const created = await materializeDownstreamFixture("filemode");
    await fs.chmod(path.join(created.path, "tool.sh"), 0o644);
    await fs.writeFile(path.join(created.path, "README.md"), "changed\n");
    const removed = await service.remove({ id: created.id, reason: "test" });

    expect(await git(repo, "ls-tree", removed.snapshotRef!, "tool.sh")).toMatch(/^100644 /);
  });

  it("snapshots modified tracked files marked assume-unchanged", async () => {
    const created = await materializeDownstreamFixture("assume-unchanged");
    await git(created.path, "update-index", "--assume-unchanged", "README.md");
    await fs.writeFile(path.join(created.path, "README.md"), "hidden local change\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");

    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "hidden local change\n",
    );
  });

  it("snapshots materialized tracked files marked skip-worktree", async () => {
    const created = await materializeDownstreamFixture("skip-worktree");
    await git(created.path, "update-index", "--skip-worktree", "README.md");
    await fs.writeFile(path.join(created.path, "README.md"), "hidden sparse change\n");
    expect(await git(created.path, "status", "--porcelain")).toBe("");

    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });

    expect(await fs.readFile(path.join(restored.path, "README.md"), "utf8")).toBe(
      "hidden sparse change\n",
    );
  });

  it("snapshots deletions hidden by skip-worktree outside sparse checkout", async () => {
    const created = await materializeDownstreamFixture("skip-worktree-deleted");
    await git(created.path, "update-index", "--skip-worktree", "README.md");
    await fs.rm(path.join(created.path, "README.md"));
    expect(await git(created.path, "status", "--porcelain")).toBe("");

    await service.remove({ id: created.id, reason: "test" });
    const restored = await service.restore({ id: created.id });

    await expect(fs.stat(path.join(restored.path, "README.md"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("refuses to overwrite a branch recreated before restore", async () => {
    const created = await materializeDownstreamFixture("restore-collision");
    await service.remove({ id: created.id, reason: "test" });
    await git(repo, "branch", created.branch, "HEAD");
    const branchTip = await git(repo, "rev-parse", created.branch);

    await expect(service.restore({ id: created.id })).rejects.toThrow("already exists");

    expect(await git(repo, "rev-parse", created.branch)).toBe(branchTip);
    await expect(fs.stat(created.path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed when a nested repository cannot be captured in full", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=source\n");
    await fs.mkdir(path.join(repo, "tracked"));
    await fs.writeFile(path.join(repo, "tracked", "outer.txt"), "tracked\n");
    await git(repo, "add", "tracked/outer.txt");
    await git(repo, "commit", "-m", "add tracked parent");
    const created = await materializeDownstreamFixture("nested-repository");
    const nested = await initializeRepository(
      path.join(created.path, "tracked"),
      gitTemplate,
      "nested",
    );
    await fs.writeFile(path.join(nested, "untracked-local.txt"), "do not lose\n");

    await expect(service.remove({ id: created.id, reason: "test" })).rejects.toThrow(
      "nested git repositories cannot be snapshotted losslessly",
    );

    expect(await fs.readFile(path.join(nested, "untracked-local.txt"), "utf8")).toBe(
      "do not lose\n",
    );
    expect(getRegistryWorktree(env, created.id)?.removedAt).toBeUndefined();
    expect(
      getRegistryWorktreeProvisionedChunk(env, {
        worktreeId: created.id,
        path: ".env.local",
        chunkIndex: 0,
      }),
    ).toBeUndefined();
  });

  it("rematerializes a named workboard checkout from its retained snapshot", async () => {
    const created = await service.create({
      repoRoot: repo,
      name: "wb-card",
      baseRef: "HEAD",
      ownerKind: "workboard",
      ownerId: "card",
    });
    await fs.writeFile(path.join(created.path, "worker.txt"), "worker state\n");
    await service.remove({ id: created.id, reason: "run-end" });

    const reusedFromSource = await service.create({
      repoRoot: repo,
      name: "wb-card",
      baseRef: created.branch,
      ownerKind: "workboard",
      ownerId: "card",
    });

    expect(reusedFromSource.id).toBe(created.id);
    expect(await fs.readFile(path.join(reusedFromSource.path, "worker.txt"), "utf8")).toBe(
      "worker state\n",
    );
  });

  it("removes lossless run-end worktrees but keeps dirty and unpushed work", async () => {
    await addRemote(root, repo);
    const clean = await materializeDownstreamFixture("clean");
    await service.acquire(clean.id);
    expect(await service.removeIfLossless(clean.id)).toBe(true);

    const dirty = await materializeDownstreamFixture("dirty");
    await service.acquire(dirty.id);
    await fs.writeFile(path.join(dirty.path, "dirty.txt"), "dirty\n");
    expect(await service.removeIfLossless(dirty.id)).toBe(false);
    expect(
      (await service.list()).find((entry) => entry.id === dirty.id)?.removedAt,
    ).toBeUndefined();

    const committed = await materializeDownstreamFixture("committed");
    await service.acquire(committed.id);
    await fs.writeFile(path.join(committed.path, "commit.txt"), "commit\n");
    await git(committed.path, "add", "commit.txt");
    await git(committed.path, "commit", "-m", "unpushed");
    expect(await service.removeIfLossless(committed.id)).toBe(false);
  });

  it("snapshots provisioned ignored file state independently of the source", async () => {
    await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\nnode_modules/\n");
    await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
    await git(repo, "add", ".gitignore", ".worktreeinclude");
    await git(repo, "commit", "-m", "configure worktree provisioning");
    await fs.writeFile(path.join(repo, ".env.local"), "value=old-source\n");
    await addRemote(root, repo);

    const rotated = await materializeDownstreamFixture("rotated-local", {
      provisionedPaths: [".env.local"],
    });
    await service.acquire(rotated.id);
    expect(await fs.readFile(path.join(rotated.path, ".env.local"), "utf8")).toBe(
      "value=old-source\n",
    );
    await fs.writeFile(path.join(rotated.path, ".env.local"), "value=rotated-only-copy\n");

    expect(await service.removeIfLossless(rotated.id)).toBe(true);
    await fs.writeFile(path.join(repo, ".env.local"), "value=newer-source\n");
    const restoredRotated = await service.restore({ id: rotated.id });
    expect(await fs.readFile(path.join(restoredRotated.path, ".env.local"), "utf8")).toBe(
      "value=rotated-only-copy\n",
    );

    const rebuildable = await materializeDownstreamFixture("rebuildable", {
      provisionedPaths: [".env.local"],
    });
    await service.acquire(rebuildable.id);
    await fs.mkdir(path.join(rebuildable.path, "node_modules"), { recursive: true });
    await fs.writeFile(path.join(rebuildable.path, "node_modules", "cache.js"), "cache\n");
    expect(await service.removeIfLossless(rebuildable.id)).toBe(true);

    const deleted = await materializeDownstreamFixture("deleted-local", {
      provisionedPaths: [".env.local"],
    });
    await service.acquire(deleted.id);
    const deletedCopy = path.join(deleted.path, ".env.local");
    await fs.rm(deletedCopy);
    expect(await service.removeIfLossless(deleted.id)).toBe(true);
    const restoredDeleted = await service.restore({ id: deleted.id });
    await expect(fs.stat(path.join(restoredDeleted.path, ".env.local"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.skipIf(process.platform === "win32")(
    "snapshots regular provisioned file modes and protects changed file types",
    async () => {
      await fs.writeFile(path.join(repo, ".gitignore"), ".env.local\n");
      await fs.writeFile(path.join(repo, ".worktreeinclude"), ".env.local\n");
      await git(repo, "add", ".gitignore", ".worktreeinclude");
      await git(repo, "commit", "-m", "configure worktree provisioning");
      const sourcePath = path.join(repo, ".env.local");
      await fs.writeFile(sourcePath, "value=source\n", { mode: 0o644 });
      await addRemote(root, repo);

      const executable = await materializeDownstreamFixture("executable-local", {
        provisionedPaths: [".env.local"],
      });
      await service.acquire(executable.id);
      const executableCopy = path.join(executable.path, ".env.local");
      await fs.chmod(executableCopy, 0o755);
      expect(await git(executable.path, "status", "--porcelain")).toBe("");
      expect(await service.removeIfLossless(executable.id)).toBe(true);
      const restoredExecutable = await service.restore({ id: executable.id });
      expect((await fs.lstat(path.join(restoredExecutable.path, ".env.local"))).mode & 0o777).toBe(
        0o755,
      );

      const specialMode = await materializeDownstreamFixture("special-mode-local", {
        provisionedPaths: [".env.local"],
      });
      await service.acquire(specialMode.id);
      const specialModeCopy = path.join(specialMode.path, ".env.local");
      await fs.chmod(specialModeCopy, 0o1644);
      expect(await service.removeIfLossless(specialMode.id)).toBe(true);
      const restoredSpecialMode = await service.restore({ id: specialMode.id });
      expect(
        (await fs.lstat(path.join(restoredSpecialMode.path, ".env.local"))).mode & 0o7777,
      ).toBe(0o1644);

      const linked = await materializeDownstreamFixture("linked-local", {
        provisionedPaths: [".env.local"],
      });
      await service.acquire(linked.id);
      const linkedCopy = path.join(linked.path, ".env.local");
      await fs.rm(linkedCopy);
      await fs.symlink(sourcePath, linkedCopy);
      expect(await git(linked.path, "status", "--porcelain")).toBe("");
      expect(await service.removeIfLossless(linked.id)).toBe(false);
      expect((await fs.lstat(linkedCopy)).isSymbolicLink()).toBe(true);

      const sourceLinked = await materializeDownstreamFixture("source-linked-local", {
        provisionedPaths: [".env.local"],
      });
      await service.acquire(sourceLinked.id);
      const outside = path.join(root, "same-local-value");
      await fs.writeFile(outside, "value=source\n");
      await fs.rm(sourcePath);
      await fs.symlink(outside, sourcePath);
      expect(await git(sourceLinked.path, "status", "--porcelain")).toBe("");
      expect(await service.removeIfLossless(sourceLinked.id)).toBe(true);
      const restoredSourceLinked = await service.restore({ id: sourceLinked.id });
      expect((await fs.lstat(path.join(restoredSourceLinked.path, ".env.local"))).isFile()).toBe(
        true,
      );
    },
  );
});
