import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runCommandWithTimeout } from "../process/exec.js";
import { withTempDir } from "../test-helpers/temp-dir.js";
import {
  checkDepsStatus,
  checkUpdateStatus,
  compareSemverStrings,
  fetchNpmLatestVersion,
  fetchNpmPackageTargetStatus,
  fetchNpmRegistryVersionForChannel,
  fetchNpmTagVersion,
  formatGitInstallLabel,
  resolveNpmChannelTag,
} from "./update-check.js";

describe("compareSemverStrings", () => {
  it("handles stable and prerelease precedence for both legacy and beta formats", () => {
    expect(compareSemverStrings("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemverStrings("v1.0.0", "1.0.0")).toBe(0);

    expect(compareSemverStrings("1.0.0", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0-beta.2", "1.0.0-beta.1")).toBe(1);

    expect(compareSemverStrings("1.0.0-2", "1.0.0-1")).toBe(1);
    expect(compareSemverStrings("1.0.0-1", "1.0.0-beta.1")).toBe(-1);
    expect(compareSemverStrings("1.0.0.beta.2", "1.0.0-beta.1")).toBe(1);
    expect(compareSemverStrings("1.0.0", "1.0.0.beta.1")).toBe(1);
  });

  it("returns null for invalid inputs", () => {
    expect(compareSemverStrings("1.0", "1.0.0")).toBeNull();
    expect(compareSemverStrings("latest", "1.0.0")).toBeNull();
  });
});

describe("resolveNpmChannelTag", () => {
  let versionByTag: Record<string, string | null>;

  beforeEach(() => {
    versionByTag = {};
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const tag = decodeURIComponent(url.split("/").pop() ?? "");
        const version = versionByTag[tag] ?? null;
        return {
          ok: version != null,
          status: version != null ? 200 : 404,
          json: async () => ({
            version,
            engines: version != null ? { node: ">=22.14.0" } : undefined,
          }),
        } as Response;
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("falls back to latest when beta is older", async () => {
    versionByTag.beta = "1.0.0-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1-1" });
  });

  it("keeps beta when beta is not older", async () => {
    versionByTag.beta = "1.0.2-beta.1";
    versionByTag.latest = "1.0.1-1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "beta", version: "1.0.2-beta.1" });
  });

  it("falls back to latest when beta has same base as stable", async () => {
    versionByTag.beta = "1.0.1-beta.2";
    versionByTag.latest = "1.0.1";

    const resolved = await resolveNpmChannelTag({ channel: "beta", timeoutMs: 1000 });

    expect(resolved).toEqual({ tag: "latest", version: "1.0.1" });
  });

  it("keeps non-beta channels unchanged", async () => {
    versionByTag.latest = "1.0.3";

    await expect(resolveNpmChannelTag({ channel: "stable", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.3",
    });
  });

  it("exposes tag fetch helpers for success and http failures", async () => {
    versionByTag.latest = "1.0.4";

    await expect(
      fetchNpmPackageTargetStatus({ target: "latest", timeoutMs: 1000 }),
    ).resolves.toEqual({
      target: "latest",
      version: "1.0.4",
      nodeEngine: ">=22.14.0",
    });
    await expect(fetchNpmTagVersion({ tag: "latest", timeoutMs: 1000 })).resolves.toEqual({
      tag: "latest",
      version: "1.0.4",
    });
    await expect(fetchNpmLatestVersion({ timeoutMs: 1000 })).resolves.toEqual({
      latestVersion: "1.0.4",
      error: undefined,
    });
    versionByTag.beta = "1.0.5-beta.1";
    await expect(
      fetchNpmRegistryVersionForChannel({ channel: "beta", timeoutMs: 1000 }),
    ).resolves.toEqual({
      latestVersion: "1.0.5-beta.1",
      tag: "beta",
    });
    await expect(fetchNpmTagVersion({ tag: "beta", timeoutMs: 1000 })).resolves.toEqual({
      tag: "beta",
      version: "1.0.5-beta.1",
      error: undefined,
    });
    await expect(fetchNpmTagVersion({ tag: "missing", timeoutMs: 1000 })).resolves.toEqual({
      tag: "missing",
      version: null,
      error: "HTTP 404",
    });
  });
});

describe("formatGitInstallLabel", () => {
  it("formats branch, detached tag, and non-git installs", () => {
    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "1234567890abcdef",
          tag: null,
          branch: "main",
          upstream: "origin/main",
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: true,
        },
      }),
    ).toBe("main · @ 12345678");

    expect(
      formatGitInstallLabel({
        root: "/repo",
        installKind: "git",
        packageManager: "pnpm",
        git: {
          root: "/repo",
          sha: "abcdef1234567890",
          tag: "v1.2.3",
          branch: "HEAD",
          upstream: null,
          dirty: false,
          ahead: 0,
          behind: 0,
          fetchOk: null,
        },
      }),
    ).toBe("detached · tag v1.2.3 · @ abcdef12");

    expect(
      formatGitInstallLabel({
        root: null,
        installKind: "package",
        packageManager: "pnpm",
      }),
    ).toBeNull();
  });
});

describe("checkDepsStatus", () => {
  it("reports unknown, missing, stale, and ok states from lockfile markers", async () => {
    await withTempDir({ prefix: "openclaw-update-check-" }, async (base) => {
      await expect(checkDepsStatus({ root: base, manager: "unknown" })).resolves.toEqual({
        manager: "unknown",
        status: "unknown",
        lockfilePath: null,
        markerPath: null,
        reason: "unknown package manager",
      });

      await fs.writeFile(path.join(base, "pnpm-lock.yaml"), "lock", "utf8");
      await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
        manager: "pnpm",
        status: "missing",
        reason: "node_modules marker missing",
      });

      const markerPath = path.join(base, "node_modules", ".modules.yaml");
      await fs.mkdir(path.dirname(markerPath), { recursive: true });
      await fs.writeFile(markerPath, "marker", "utf8");
      const staleDate = new Date(Date.now() - 10_000);
      const freshDate = new Date();
      await fs.utimes(markerPath, staleDate, staleDate);
      await fs.utimes(path.join(base, "pnpm-lock.yaml"), freshDate, freshDate);

      await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
        manager: "pnpm",
        status: "stale",
        reason: "lockfile newer than install marker",
      });

      const newerMarker = new Date(Date.now() + 2_000);
      await fs.utimes(markerPath, newerMarker, newerMarker);
      await expect(checkDepsStatus({ root: base, manager: "pnpm" })).resolves.toMatchObject({
        manager: "pnpm",
        status: "ok",
      });
    });
  });
});

describe("checkUpdateStatus", () => {
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
    await withTempDir({ prefix: "openclaw-update-check-" }, async (root) => {
      await fs.writeFile(
        path.join(root, "package.json"),
        JSON.stringify({ packageManager: "npm@10.0.0" }),
        "utf8",
      );
      await fs.writeFile(path.join(root, "package-lock.json"), "lock", "utf8");
      await fs.mkdir(path.join(root, "node_modules"), { recursive: true });

      await expect(
        checkUpdateStatus({ root, includeRegistry: false, fetchGit: false, timeoutMs: 1000 }),
      ).resolves.toMatchObject({
        root,
        installKind: "package",
        packageManager: "npm",
        git: undefined,
        registry: undefined,
        deps: {
          manager: "npm",
        },
      });
    });
  });

  it("treats symlinked git installs as git roots", async () => {
    await withTempDir({ prefix: "openclaw-update-check-git-" }, async (base) => {
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

      await expect(
        checkUpdateStatus({
          root: linkedRoot,
          includeRegistry: false,
          fetchGit: false,
          timeoutMs: 1000,
        }),
      ).resolves.toMatchObject({
        root: linkedRoot,
        installKind: "git",
        git: {
          root: linkedRoot,
        },
      });
    });
  });
});
