import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { redactSensitiveUrlLikeString } from "../shared/net/redact-sensitive-url.js";

const runCommandWithTimeoutMock = vi.fn();
const installPluginFromInstalledPackageDirMock = vi.fn();

vi.mock("../process/exec.js", () => ({
  runCommandWithTimeout: (...args: unknown[]) => runCommandWithTimeoutMock(...args),
}));

vi.mock("./install.js", async () => {
  const actual = await vi.importActual<typeof import("./install.js")>("./install.js");
  return {
    ...actual,
    installPluginFromInstalledPackageDir: (...args: unknown[]) =>
      installPluginFromInstalledPackageDirMock(...args),
  };
});

vi.resetModules();

const { installPluginFromGitSpec, parseGitPluginSpec } = await import("./git-install.js");

function expectedGitRepoDir(params: { gitDir: string; normalizedSpec: string }): string {
  const hash = createHash("sha256")
    .update(redactSensitiveUrlLikeString(params.normalizedSpec))
    .digest("hex")
    .slice(0, 16);
  return path.join(params.gitDir, `git-${hash}`, "repo");
}

describe("parseGitPluginSpec", () => {
  it("normalizes GitHub shorthand and ref selectors", () => {
    expect(parseGitPluginSpec("git:github.com/acme/demo@v1.2.3")).toMatchObject({
      url: "https://github.com/acme/demo.git",
      ref: "v1.2.3",
      label: "acme/demo",
      normalizedSpec: "git:https://github.com/acme/demo.git@v1.2.3",
    });
    expect(parseGitPluginSpec("git:acme/demo#main")).toMatchObject({
      url: "https://github.com/acme/demo.git",
      ref: "main",
    });
  });

  it("keeps scp-style clone URLs without treating git@ as a ref", () => {
    expect(parseGitPluginSpec("git:git@github.com:acme/demo.git@release")).toMatchObject({
      url: "git@github.com:acme/demo.git",
      ref: "release",
      label: "git@github.com:acme/demo.git",
    });
  });
});

describe("installPluginFromGitSpec", () => {
  beforeEach(() => {
    runCommandWithTimeoutMock.mockReset();
    installPluginFromInstalledPackageDirMock.mockReset();
  });

  it("clones, checks out refs, installs from the clone, and returns commit metadata", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    installPluginFromInstalledPackageDirMock.mockImplementation(
      async (params: { packageDir: string }) => {
        await fs.mkdir(params.packageDir, { recursive: true });
        return {
          ok: true,
          pluginId: "demo",
          targetDir: params.packageDir,
          version: "1.2.3",
          extensions: ["index.js"],
        };
      },
    );

    const result = await installPluginFromGitSpec({
      spec: "git:github.com/acme/demo@v1.2.3",
      expectedPluginId: "demo",
    });

    expect(result).toMatchObject({
      ok: true,
      pluginId: "demo",
      git: {
        url: "https://github.com/acme/demo.git",
        ref: "v1.2.3",
        commit: "abc123",
      },
    });
    expect(runCommandWithTimeoutMock.mock.calls[0][0]).toEqual([
      "git",
      "clone",
      "https://github.com/acme/demo.git",
      expect.stringContaining("/repo"),
    ]);
    expect(runCommandWithTimeoutMock.mock.calls[1][0]).toEqual([
      "git",
      "checkout",
      "--detach",
      "v1.2.3",
    ]);
    expect(runCommandWithTimeoutMock.mock.calls[3][0]).toEqual([
      "npm",
      "install",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    expect(installPluginFromInstalledPackageDirMock).toHaveBeenCalledWith(
      expect.objectContaining({
        expectedPluginId: "demo",
        packageDir: expect.stringContaining("/repo"),
        installPolicyRequest: {
          kind: "plugin-git",
          requestedSpecifier: "git:github.com/acme/demo@v1.2.3",
        },
      }),
    );
  });

  it("uses a shallow clone when no ref is requested", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
    installPluginFromInstalledPackageDirMock.mockImplementation(
      async (params: { packageDir: string }) => {
        await fs.mkdir(params.packageDir, { recursive: true });
        return {
          ok: true,
          pluginId: "demo",
          targetDir: params.packageDir,
          version: "1.2.3",
          extensions: ["index.js"],
        };
      },
    );

    await installPluginFromGitSpec({ spec: "git:github.com/acme/demo" });

    expect(runCommandWithTimeoutMock.mock.calls[0][0]).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "https://github.com/acme/demo.git",
      expect.stringContaining("/repo"),
    ]);
  });

  it("uses a credential-free managed repo path for authenticated git URLs", async () => {
    const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-install-path-"));
    try {
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      installPluginFromInstalledPackageDirMock.mockImplementation(
        async (params: { packageDir: string }) => {
          await fs.mkdir(params.packageDir, { recursive: true });
          return {
            ok: true,
            pluginId: "demo",
            targetDir: params.packageDir,
            version: "1.2.3",
            extensions: ["index.js"],
          };
        },
      );

      const result = await installPluginFromGitSpec({
        spec: "git:https://token@github.com/acme/demo.git",
        gitDir,
      });

      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }
      expect(result.targetDir).toBe(
        expectedGitRepoDir({
          gitDir,
          normalizedSpec: "git:https://token@github.com/acme/demo.git",
        }),
      );
      expect(result.targetDir).not.toContain("token");
      expect(result.targetDir).not.toContain("github.com");
    } finally {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
  });

  it("redacts authenticated git URLs from command failure details", async () => {
    runCommandWithTimeoutMock.mockResolvedValueOnce({
      code: 1,
      stdout: "",
      stderr:
        "fatal: could not read Username for 'https://token:secret@github.com/acme/demo.git' while retrying https://other:credential@github.com/acme/fallback.git",
    });

    const result = await installPluginFromGitSpec({
      spec: "git:https://token:secret@github.com/acme/demo.git",
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("failed to clone github.com/acme/demo");
      expect(result.error).toContain("https://***:***@github.com/acme/demo.git");
      expect(result.error).toContain("https://***:***@github.com/acme/fallback.git");
      expect(result.error).not.toContain("token");
      expect(result.error).not.toContain("secret");
      expect(result.error).not.toContain("other");
      expect(result.error).not.toContain("credential");
    }
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
  });

  it("keeps the existing managed repo when replacement install fails", async () => {
    const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-install-preserve-"));
    const normalizedSpec = "git:https://github.com/acme/demo.git";
    const existingRepoDir = expectedGitRepoDir({ gitDir, normalizedSpec });
    const markerPath = path.join(existingRepoDir, "existing.txt");
    try {
      await fs.mkdir(existingRepoDir, { recursive: true });
      await fs.writeFile(markerPath, "keep");
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" })
        .mockResolvedValueOnce({ code: 1, stdout: "", stderr: "npm failed" });

      const result = await installPluginFromGitSpec({
        spec: "git:https://github.com/acme/demo.git",
        gitDir,
        mode: "update",
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("npm install failed");
      }
      await expect(fs.readFile(markerPath, "utf8")).resolves.toBe("keep");
      expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
    } finally {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
  });
});
