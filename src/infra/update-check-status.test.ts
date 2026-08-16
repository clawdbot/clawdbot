// Covers install, dependency, and Git update status.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTestDir } from "../test-helpers/temp-dir.js";
import { withEnvAsync } from "../test-utils/env.js";
import { useMockHttp } from "../test-utils/mock-http.js";
import { checkUpdateStatus } from "./update-check.js";

const mockHttp = useMockHttp();

async function runGit(cwd: string, ...args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", ...args], { cwd, timeoutMs: 5000 });
  if (result.code !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

async function initGitRepo(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await runGit(root, "init", "--initial-branch=main");
  await runGit(root, "config", "user.name", "OpenClaw Test");
  await runGit(root, "config", "user.email", "test@openclaw.invalid");
}

async function commitGit(root: string, message: string): Promise<void> {
  await runGit(root, "commit", "--allow-empty", "--message", message);
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("checkUpdateStatus", () => {
  it("resolves manager-style detached dev tracking before matching update receipts", async () => {
    await withTestDir({ prefix: "openclaw-update-check-receipt-fallback-" }, async (base) => {
      const sourceRoot = path.join(base, "source");
      const localRoot = path.join(base, "local");
      await initGitRepo(sourceRoot);
      await fs.writeFile(
        path.join(sourceRoot, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@10.0.0" }),
      );
      await runGit(sourceRoot, "add", "package.json");
      await commitGit(sourceRoot, "base");
      const baseSha = await runGit(sourceRoot, "rev-parse", "HEAD");
      await commitGit(sourceRoot, "target");
      const targetSha = await runGit(sourceRoot, "rev-parse", "HEAD");
      await runGit(base, "clone", "--quiet", "--no-checkout", sourceRoot, localRoot);
      await runGit(localRoot, "checkout", "--detach", targetSha);
      await runGit(localRoot, "branch", "-D", "main");
      expect(await runGit(localRoot, "branch", "--list", "main")).toBe("");
      const fallback = { currentSha: targetSha, upstreamRef: "origin/main" };
      const readStatus = (
        params: { fetch?: boolean; fallback?: typeof fallback; detached?: boolean } = {},
      ) =>
        checkUpdateStatus({
          root: localRoot,
          includeRegistry: false,
          fetchGit: params.fetch ?? false,
          timeoutMs: 5000,
          useDetachedDevUpstream: params.detached ?? true,
          ...(params.fallback ? { gitUpstreamFallback: params.fallback } : {}),
        });

      expect((await readStatus({ fetch: true })).git).toMatchObject({
        branch: "HEAD",
        sha: targetSha,
        upstream: "origin/main",
        upstreamSource: "tracking",
        upstreamSha: targetSha,
        ahead: 0,
        behind: 0,
        fetchOk: true,
      });

      const current = await readStatus({ fetch: true, fallback, detached: false });
      expect(current.git).toMatchObject({
        branch: "HEAD",
        sha: targetSha,
        upstream: "origin/main",
        upstreamSource: "receipt",
        upstreamSha: targetSha,
        ahead: 0,
        behind: 0,
      });

      await commitGit(sourceRoot, "newer");
      const newerSha = await runGit(sourceRoot, "rev-parse", "HEAD");
      expect((await readStatus({ fetch: true })).git).toMatchObject({
        upstream: "origin/main",
        upstreamSource: "tracking",
        upstreamSha: newerSha,
        ahead: 0,
        behind: 1,
        fetchOk: true,
      });
      const behind = await readStatus({ fetch: true, fallback, detached: false });
      expect(behind.git).toMatchObject({
        upstreamSource: "receipt",
        upstreamSha: newerSha,
        ahead: 0,
        behind: 1,
      });

      for (const fallbackOverride of [undefined, { ...fallback, currentSha: baseSha }]) {
        const unmanaged = await readStatus({ fallback: fallbackOverride, detached: false });
        expect(unmanaged.git).toMatchObject({ branch: "HEAD", upstream: null });
        expect(unmanaged.git).not.toHaveProperty("upstreamSource");
      }

      await runGit(localRoot, "checkout", "-b", "receipt-collision", targetSha);
      const namedBranch = await readStatus({ fallback });
      expect(namedBranch.git).toMatchObject({
        branch: "receipt-collision",
        sha: targetSha,
        upstream: null,
        upstreamSha: null,
        ahead: null,
        behind: null,
      });
      expect(namedBranch.git).not.toHaveProperty("upstreamSource");
    });
  });

  it("does not treat stale remote refs as current when fetch fails", async () => {
    await withTestDir({ prefix: "openclaw-update-check-fetch-failure-" }, async (base) => {
      const remoteRoot = path.join(base, "remote");
      const localRoot = path.join(base, "local");
      await initGitRepo(remoteRoot);
      await commitGit(remoteRoot, "initial");
      await runGit(base, "clone", "--quiet", remoteRoot, localRoot);
      await runGit(localRoot, "remote", "set-url", "origin", path.join(base, "missing"));
      const commitAtMs =
        Number(await runGit(localRoot, "show", "-s", "--format=%ct", "HEAD")) * 1000;

      const status = await checkUpdateStatus({
        root: localRoot,
        includeRegistry: false,
        fetchGit: true,
        timeoutMs: 5000,
      });

      expect(status.git).toMatchObject({
        upstream: "origin/main",
        upstreamSha: null,
        commitAtMs,
        ahead: null,
        behind: null,
        fetchOk: false,
      });
    });
  });

  it("does not report divergence for unrelated histories", async () => {
    await withTestDir({ prefix: "openclaw-update-check-unrelated-" }, async (base) => {
      const localRoot = path.join(base, "local");
      const remoteRoot = path.join(base, "remote");
      await initGitRepo(localRoot);
      await commitGit(localRoot, "local history");
      await initGitRepo(remoteRoot);
      await commitGit(remoteRoot, "remote history");

      await runGit(localRoot, "remote", "add", "origin", remoteRoot);
      await runGit(localRoot, "fetch", "origin", "main");
      await runGit(localRoot, "branch", "--set-upstream-to=origin/main", "main");

      const mergeBase = await runCommandWithTimeout(["git", "merge-base", "HEAD", "origin/main"], {
        cwd: localRoot,
        timeoutMs: 5000,
      });
      expect(mergeBase.code).toBe(1);
      expect(
        await runGit(localRoot, "rev-list", "--left-right", "--count", "HEAD...origin/main"),
      ).toMatch(/^1\s+1$/u);

      const status = await checkUpdateStatus({
        root: localRoot,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 5000,
      });
      expect(status.git).toMatchObject({
        upstream: "origin/main",
        ahead: null,
        behind: null,
      });
    });
  });

  it("reports divergence only when shallow history retains a merge base", async () => {
    await withTestDir({ prefix: "openclaw-update-check-shallow-" }, async (base) => {
      const sourceRoot = path.join(base, "source");
      await initGitRepo(sourceRoot);
      await commitGit(sourceRoot, "common base");
      await runGit(sourceRoot, "switch", "--create", "feature");
      await commitGit(sourceRoot, "feature change");
      await runGit(sourceRoot, "switch", "main");
      await commitGit(sourceRoot, "main change");
      const mainSha = await runGit(sourceRoot, "rev-parse", "main");

      const cloneDivergedHistory = async (name: string, depth?: number) => {
        const cloneRoot = path.join(base, name);
        const depthArgs = depth ? [`--depth=${depth}`] : [];
        await runGit(
          base,
          "clone",
          "--quiet",
          ...depthArgs,
          "--branch",
          "feature",
          pathToFileURL(sourceRoot).href,
          cloneRoot,
        );
        await runGit(
          cloneRoot,
          "fetch",
          "--quiet",
          ...(depth ? [`--depth=${depth}`] : []),
          "origin",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        await runGit(
          cloneRoot,
          "config",
          "--add",
          "remote.origin.fetch",
          "+refs/heads/main:refs/remotes/origin/main",
        );
        await runGit(cloneRoot, "config", "branch.feature.remote", "origin");
        await runGit(cloneRoot, "config", "branch.feature.merge", "refs/heads/main");
        return cloneRoot;
      };

      const readDivergence = async (root: string) => {
        const status = await checkUpdateStatus({
          root,
          includeRegistry: false,
          fetchGit: false,
          timeoutMs: 5000,
        });
        return {
          ahead: status.git?.ahead,
          behind: status.git?.behind,
          upstreamSha: status.git?.upstreamSha,
        };
      };

      const fullRoot = await cloneDivergedHistory("full");
      await expect(readDivergence(fullRoot)).resolves.toEqual({
        ahead: 1,
        behind: 1,
        upstreamSha: mainSha,
      });
      await runGit(fullRoot, "remote", "rename", "--", "origin", "-dash");
      expect(await runGit(fullRoot, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("-dash/main");
      await expect(readDivergence(fullRoot)).resolves.toEqual({
        ahead: 1,
        behind: 1,
        upstreamSha: mainSha,
      });

      const truncatedRoot = await cloneDivergedHistory("shallow-depth-1", 1);
      await expect(readDivergence(truncatedRoot)).resolves.toEqual({
        ahead: null,
        behind: null,
        upstreamSha: mainSha,
      });

      const comparableRoot = await cloneDivergedHistory("shallow-depth-2", 2);
      await expect(readDivergence(comparableRoot)).resolves.toEqual({
        ahead: 1,
        behind: 1,
        upstreamSha: mainSha,
      });
    });
  });

  it("returns unknown install status when root is missing", async () => {
    await expect(
      checkUpdateStatus({ root: null, includeRegistry: false, timeoutMs: 1000 }),
    ).resolves.toEqual({
      root: null,
      installKind: "unknown",
      packageManager: "unknown",
      registry: undefined,
    });
  });

  it("detects package installs for non-git roots", async () => {
    await withTestDir({ prefix: "openclaw-update-check-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(status.root).toBe(root);
      expect(status.installKind).toBe("package");
      expect(status.packageManager).toBe("npm");
      expect(status.git).toBeUndefined();
      expect(status.registry).toBeUndefined();
      expect(status.deps?.manager).toBe("npm");
    });
  });

  it("resolves a status registry channel after detecting the install kind", async () => {
    await withTestDir({ prefix: "openclaw-update-check-registry-channel-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });
      const resolveRegistryChannel = vi.fn(() => "extended-stable" as const);

      await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        resolveRegistryChannel,
      });

      expect(resolveRegistryChannel).toHaveBeenCalledWith({
        installKind: "package",
        git: undefined,
      });
    });
  });

  it.each([
    {
      name: "text lockfile",
      lockfiles: ["bun.lock"],
      expectedLockfile: "bun.lock",
    },
    {
      name: "binary lockfile",
      lockfiles: ["bun.lockb"],
      expectedLockfile: "bun.lockb",
    },
    {
      name: "text lockfile when both formats exist",
      lockfiles: ["bun.lock", "bun.lockb"],
      expectedLockfile: "bun.lock",
    },
  ])("reports dependency status for Bun's $name", async ({ lockfiles, expectedLockfile }) => {
    await withTestDir({ prefix: "openclaw-update-check-bun-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "bun@1.2.0" }),
        "utf8",
      );
      for (const lockfile of lockfiles) {
        await fs.writeFile(path.join(root, lockfile), "lock", "utf8");
      }
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      const status = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });

      expect(status).toMatchObject({
        installKind: "package",
        packageManager: "bun",
        deps: {
          manager: "bun",
          lockfilePath: path.join(root, expectedLockfile),
          markerPath: path.join(root, "node_modules"),
          status: "ok",
        },
      });
    });
  });

  it.each([
    { manager: "npm", expectedLockfile: "package-lock.json" },
    { manager: "bun", expectedLockfile: "bun.lockb" },
  ])(
    "detects lockless OpenClaw $manager installs despite packed pnpm metadata",
    async ({ manager, expectedLockfile }) => {
      await withTestDir({ prefix: `openclaw-update-check-lockless-${manager}-` }, async (base) => {
        const bunInstall = path.join(base, "custom-bun-home");
        const root =
          manager === "bun"
            ? path.join(bunInstall, "install", "global", "node_modules", "openclaw")
            : path.join(base, "prefix", "node_modules", "openclaw");
        await fs.mkdir(root, { recursive: true });
        await fs.writeFile(
          path.join(root, "package.json"),
          JSON.stringify({ name: "openclaw", packageManager: "pnpm@11.2.2" }),
          "utf8",
        );

        await withEnvAsync({ BUN_INSTALL: bunInstall }, async () => {
          const status = await checkUpdateStatus({
            root,
            includeRegistry: false,
            fetchGit: false,
            timeoutMs: 1000,
          });

          expect(status.installKind).toBe("package");
          expect(status.packageManager).toBe(manager);
          expect(status.deps).toMatchObject({
            manager,
            lockfilePath: path.join(root, expectedLockfile),
            status: "unknown",
            reason: "lockfile missing",
          });
        });
      });
    },
  );

  it("reports a missing dependency marker and accepts an older valid marker", async () => {
    await withTestDir({ prefix: "openclaw-update-check-deps-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@11.2.2" }),
        "utf8",
      );
      const lockfilePath = path.join(root, "pnpm-lock.yaml");
      await fs.writeFile(lockfilePath, "lock", "utf8");

      const missing = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(missing.deps).toMatchObject({
        manager: "pnpm",
        status: "missing",
        reason: "node_modules marker missing",
      });

      const markerPath = path.join(root, "node_modules", ".modules.yaml");
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, "marker", "utf8");
      const staleDate = new Date(Date.now() - 10_000);
      const freshDate = new Date();
      await fs.utimes(markerPath, staleDate, staleDate);
      await fs.utimes(lockfilePath, freshDate, freshDate);

      const installed = await checkUpdateStatus({
        root,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(installed.deps).toMatchObject({
        manager: "pnpm",
        status: "ok",
      });
    });
  });

  it("treats symlinked git installs as git roots", async () => {
    await withTestDir({ prefix: "openclaw-update-check-git-" }, async (base) => {
      const repoRoot = path.join(base, "repo");
      const linkedRoot = path.join(base, "linked-openclaw");
      await fs.mkdir(repoRoot, { recursive: true });
      await fs.writeFile(
        path.join(repoRoot, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@10.0.0" }),
        "utf8",
      );
      await runCommandWithTimeout(["git", "init"], { cwd: repoRoot, timeoutMs: 1000 });
      await fs.symlink(repoRoot, linkedRoot);

      const status = await checkUpdateStatus({
        root: linkedRoot,
        includeRegistry: false,
        fetchGit: false,
        timeoutMs: 1000,
      });
      expect(status.root).toBe(linkedRoot);
      expect(status.installKind).toBe("git");
      expect(status.git?.root).toBe(linkedRoot);
    });
  });

  it("reports unsupported_git_channel for Git status without querying npm", async () => {
    await withTestDir({ prefix: "openclaw-update-check-git-channel-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ name: "openclaw", packageManager: "pnpm@10.0.0" }),
        "utf8",
      );
      await runCommandWithTimeout(["git", "init"], { cwd: root, timeoutMs: 1000 });
      const status = await checkUpdateStatus({
        root,
        includeRegistry: true,
        registryChannel: "extended-stable",
        fetchGit: false,
        timeoutMs: 1000,
      });

      expect(status.registry).toEqual({
        latestVersion: null,
        tag: "extended-stable",
        error: "unsupported_git_channel",
        reason: "unsupported_git_channel",
      });
      expect(mockHttp.requests()).toHaveLength(0);
    });
  });
});
