import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTrackedTempDirs } from "../test-utils/tracked-temp-dirs.js";

const tempDirs = createTrackedTempDirs();

async function makeTempDir(label: string): Promise<string> {
  return await tempDirs.make(`openclaw-${label}-`);
}

async function makeFakeGitRepo(
  root: string,
  options: {
    head: string;
    packedRefs?: Record<string, string>;
    refs?: Record<string, string>;
    gitdir?: string;
    commondir?: string;
  },
) {
  await fs.mkdir(root, { recursive: true });
  const gitdir = options.gitdir ?? path.join(root, ".git");
  if (options.gitdir) {
    await fs.writeFile(path.join(root, ".git"), `gitdir: ${options.gitdir}\n`, "utf-8");
  } else {
    await fs.mkdir(gitdir, { recursive: true });
  }
  await fs.mkdir(gitdir, { recursive: true });
  await fs.writeFile(path.join(gitdir, "HEAD"), options.head, "utf-8");
  const refsBase = options.commondir ? path.resolve(gitdir, options.commondir) : gitdir;
  await fs.mkdir(refsBase, { recursive: true });
  if (options.commondir) {
    await fs.writeFile(path.join(gitdir, "commondir"), options.commondir, "utf-8");
  }
  for (const [refPath, commit] of Object.entries(options.refs ?? {})) {
    const targetPath = path.join(refsBase, refPath);
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.writeFile(targetPath, `${commit}\n`, "utf-8");
  }
  const packedRefsEntries = Object.entries(options.packedRefs ?? {});
  if (packedRefsEntries.length > 0) {
    const packedRefsContents = [
      "# pack-refs with: peeled fully-peeled sorted",
      ...packedRefsEntries.map(([refPath, commit]) => `${commit} ${refPath}`),
    ].join("\n");
    await fs.writeFile(path.join(refsBase, "packed-refs"), `${packedRefsContents}\n`, "utf-8");
  }
}

describe("git commit resolution", () => {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
  let resolveCommitHash: (typeof import("./git-commit.js"))["resolveCommitHash"];
  let __testing: (typeof import("./git-commit.js"))["__testing"];

  beforeAll(async () => {
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
    ({ resolveCommitHash, __testing } = await import("./git-commit.js"));
  });

  beforeEach(() => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
    __testing.clearCachedGitCommits();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.doUnmock("node:fs");
    vi.doUnmock("node:module");
    __testing.clearCachedGitCommits();
    await tempDirs.cleanup();
  });

  it("resolves commit metadata from the caller module root instead of the caller cwd", async () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
      .trim()
      .slice(0, 7);

    const temp = await makeTempDir("git-commit-cwd");
    const otherRepo = path.join(temp, "other");
    await fs.mkdir(otherRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: otherRepo });
    await fs.writeFile(path.join(otherRepo, "note.txt"), "x\n", "utf-8");
    execFileSync("git", ["add", "note.txt"], { cwd: otherRepo });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: otherRepo },
    );
    const otherHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: otherRepo,
      encoding: "utf-8",
    })
      .trim()
      .slice(0, 7);

    const entryModuleUrl = pathToFileURL(path.join(repoRoot, "src", "entry.ts")).href;
    vi.spyOn(process, "cwd").mockReturnValue(otherRepo);

    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).toBe(repoHead);
    expect(resolveCommitHash({ moduleUrl: entryModuleUrl })).not.toBe(otherHead);
  });

  it("prefers live git metadata over stale build info in a real checkout", () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
      .trim()
      .slice(0, 7);

    const entryModuleUrl = pathToFileURL(path.join(repoRoot, "src", "entry.ts")).href;

    expect(
      resolveCommitHash({
        moduleUrl: entryModuleUrl,
        env: {},
        readers: {
          readBuildInfoCommit: () => "deadbee",
        },
      }),
    ).toBe(repoHead);
  });

  it("caches build-info fallback results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-build-info-cache");
    const readBuildInfoCommit = vi.fn(() => "deadbee");

    expect(resolveCommitHash({ cwd: temp, env: {}, readers: { readBuildInfoCommit } })).toBe(
      "deadbee",
    );
    const firstCallRequires = readBuildInfoCommit.mock.calls.length;
    expect(firstCallRequires).toBeGreaterThan(0);
    expect(resolveCommitHash({ cwd: temp, env: {}, readers: { readBuildInfoCommit } })).toBe(
      "deadbee",
    );
    expect(readBuildInfoCommit.mock.calls.length).toBe(firstCallRequires);
  });

  it("caches package.json fallback results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-package-json-cache");
    const readPackageJsonCommit = vi.fn(() => "badc0ff");

    expect(
      resolveCommitHash({
        cwd: temp,
        env: {},
        readers: {
          readBuildInfoCommit: () => null,
          readPackageJsonCommit,
        },
      }),
    ).toBe("badc0ff");
    const firstCallRequires = readPackageJsonCommit.mock.calls.length;
    expect(firstCallRequires).toBeGreaterThan(0);
    expect(
      resolveCommitHash({
        cwd: temp,
        env: {},
        readers: {
          readBuildInfoCommit: () => null,
          readPackageJsonCommit,
        },
      }),
    ).toBe("badc0ff");
    expect(readPackageJsonCommit.mock.calls.length).toBe(firstCallRequires);
  });

  it("treats invalid moduleUrl inputs as a fallback hint instead of throwing", () => {
    const repoHead = execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf-8",
    })
      .trim()
      .slice(0, 7);

    expect(resolveCommitHash({ moduleUrl: "not-a-file-url", cwd: repoRoot, env: {} })).toBe(
      repoHead,
    );
  });

  it("does not walk out of the openclaw package into a host repo", async () => {
    const temp = await makeTempDir("git-commit-package-boundary");
    const hostRepo = path.join(temp, "host");
    await fs.mkdir(hostRepo, { recursive: true });
    execFileSync("git", ["init", "-q"], { cwd: hostRepo });
    await fs.writeFile(path.join(hostRepo, "host.txt"), "x\n", "utf-8");
    execFileSync("git", ["add", "host.txt"], { cwd: hostRepo });
    execFileSync(
      "git",
      ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", "init"],
      { cwd: hostRepo },
    );

    const packageRoot = path.join(hostRepo, "node_modules", "openclaw");
    await fs.mkdir(path.join(packageRoot, "dist"), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      JSON.stringify({ name: "openclaw", version: "2026.3.10" }),
      "utf-8",
    );
    const moduleUrl = pathToFileURL(path.join(packageRoot, "dist", "entry.js")).href;

    expect(
      resolveCommitHash({
        moduleUrl,
        cwd: packageRoot,
        env: {},
        readers: {
          readBuildInfoCommit: () => "feedfac",
          readPackageJsonCommit: () => "badc0ff",
        },
      }),
    ).toBe("feedfac");
  });

  it("caches git lookups per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-cache");
    const repoA = path.join(temp, "repo-a");
    const repoB = path.join(temp, "repo-b");
    await makeFakeGitRepo(repoA, {
      head: "0123456789abcdef0123456789abcdef01234567\n",
    });
    await makeFakeGitRepo(repoB, {
      head: "89abcdef0123456789abcdef0123456789abcdef\n",
    });

    expect(resolveCommitHash({ cwd: repoA, env: {} })).toBe("0123456");
    expect(resolveCommitHash({ cwd: repoB, env: {} })).toBe("89abcde");
    expect(resolveCommitHash({ cwd: repoA, env: {} })).toBe("0123456");
  });

  it("reads packed refs from the common git dir for worktree-style checkouts", async () => {
    const temp = await makeTempDir("git-commit-packed-refs");
    const checkoutRoot = path.join(temp, "checkout");
    const commonGitDir = path.join(temp, "git-common");
    const worktreeGitDir = path.join(commonGitDir, "worktrees", "checkout");

    await makeFakeGitRepo(checkoutRoot, {
      gitdir: worktreeGitDir,
      commondir: "../..",
      head: "ref: refs/heads/main\n",
      packedRefs: {
        "refs/heads/main": "0123456789abcdef0123456789abcdef01234567",
      },
    });

    expect(resolveCommitHash({ cwd: checkoutRoot, env: {} })).toBe("0123456");
  });

  it("caches deterministic null results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-null-cache");
    const repoRoot = path.join(temp, "repo");
    await makeFakeGitRepo(repoRoot, {
      head: "not-a-commit\n",
    });

    const readGitCommit = vi.fn(() => null);

    expect(resolveCommitHash({ cwd: repoRoot, env: {}, readers: { readGitCommit } })).toBeNull();
    const firstCallReads = readGitCommit.mock.calls.length;
    expect(firstCallReads).toBeGreaterThan(0);
    expect(resolveCommitHash({ cwd: repoRoot, env: {}, readers: { readGitCommit } })).toBeNull();
    expect(readGitCommit.mock.calls.length).toBe(firstCallReads);
  });

  it("caches caught null fallback results per resolved search directory", async () => {
    const temp = await makeTempDir("git-commit-caught-null-cache");
    const repoRoot = path.join(temp, "repo");
    await makeFakeGitRepo(repoRoot, {
      head: "0123456789abcdef0123456789abcdef01234567\n",
    });
    const readGitCommit = vi.fn(() => {
      const error = Object.assign(new Error(`EACCES: permission denied`), {
        code: "EACCES",
      });
      throw error;
    });

    expect(
      resolveCommitHash({
        cwd: repoRoot,
        env: {},
        readers: {
          readGitCommit,
          readBuildInfoCommit: () => null,
          readPackageJsonCommit: () => null,
        },
      }),
    ).toBeNull();
    const firstCallReads = readGitCommit.mock.calls.length;
    expect(firstCallReads).toBe(2);
    expect(
      resolveCommitHash({
        cwd: repoRoot,
        env: {},
        readers: {
          readGitCommit,
          readBuildInfoCommit: () => null,
          readPackageJsonCommit: () => null,
        },
      }),
    ).toBeNull();
    expect(readGitCommit.mock.calls.length).toBe(firstCallReads);
  });

  it("formats env-provided commit strings consistently", async () => {
    const temp = await makeTempDir("git-commit-env");
    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "ABCDEF0123456789" } })).toBe(
      "abcdef0",
    );
    expect(
      resolveCommitHash({ cwd: temp, env: { GIT_SHA: "commit abcdef0123456789 dirty" } }),
    ).toBe("abcdef0");
    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "not-a-sha" } })).toBeNull();
    expect(resolveCommitHash({ cwd: temp, env: { GIT_COMMIT: "" } })).toBeNull();
  });

  it("rejects unsafe HEAD refs and accepts valid refs", async () => {
    const temp = await makeTempDir("git-commit-refs");
    const absoluteRepo = path.join(temp, "absolute");
    await makeFakeGitRepo(absoluteRepo, { head: "ref: /tmp/evil\n" });
    expect(resolveCommitHash({ cwd: absoluteRepo, env: {} })).toBeNull();

    const traversalRepo = path.join(temp, "traversal");
    await makeFakeGitRepo(traversalRepo, { head: "ref: refs/heads/../evil\n" });
    expect(resolveCommitHash({ cwd: traversalRepo, env: {} })).toBeNull();

    const invalidPrefixRepo = path.join(temp, "invalid-prefix");
    await makeFakeGitRepo(invalidPrefixRepo, { head: "ref: heads/main\n" });
    expect(resolveCommitHash({ cwd: invalidPrefixRepo, env: {} })).toBeNull();

    const validRepo = path.join(temp, "valid");
    await makeFakeGitRepo(validRepo, {
      head: "ref: refs/heads/main\n",
      refs: {
        "refs/heads/main": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      },
    });
    expect(resolveCommitHash({ cwd: validRepo, env: {} })).toBe("aaaaaaa");
  });

  it("resolves refs from the git commondir in worktree layouts", async () => {
    const temp = await makeTempDir("git-commit-worktree");
    const repoRoot = path.join(temp, "repo");
    const worktreeGitDir = path.join(temp, "worktree-git");
    const commonGitDir = path.join(temp, "common-git");
    await fs.mkdir(commonGitDir, { recursive: true });
    const refPath = path.join(commonGitDir, "refs", "heads", "main");
    await fs.mkdir(path.dirname(refPath), { recursive: true });
    await fs.writeFile(refPath, "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\n", "utf-8");
    await makeFakeGitRepo(repoRoot, {
      gitdir: worktreeGitDir,
      head: "ref: refs/heads/main\n",
      commondir: "../common-git",
    });

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBe("bbbbbbb");
  });

  it("reads full HEAD refs before parsing long branch names", async () => {
    const temp = await makeTempDir("git-commit-long-head");
    const repoRoot = path.join(temp, "repo");
    const longRefName = `refs/heads/${"segment/".repeat(40)}main`;
    await makeFakeGitRepo(repoRoot, {
      head: `ref: ${longRefName}\n`,
      refs: {
        [longRefName]: "cccccccccccccccccccccccccccccccccccccccc",
      },
    });

    expect(resolveCommitHash({ cwd: repoRoot, env: {} })).toBe("ccccccc");
  });
});
