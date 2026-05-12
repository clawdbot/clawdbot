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

function expectParsedGitSpec(spec: string) {
  const parsed = parseGitPluginSpec(spec);
  if (!parsed) {
    throw new Error(`Expected ${spec} to parse as a git plugin spec`);
  }
  return parsed;
}

describe("parseGitPluginSpec", () => {
  it("normalizes GitHub shorthand and ref selectors", () => {
    const explicitRef = expectParsedGitSpec("git:github.com/acme/demo@v1.2.3");
    expect(explicitRef.url).toBe("https://github.com/acme/demo.git");
    expect(explicitRef.ref).toBe("v1.2.3");
    expect(explicitRef.label).toBe("acme/demo");
    expect(explicitRef.normalizedSpec).toBe("git:https://github.com/acme/demo.git@v1.2.3");

    const hashRef = expectParsedGitSpec("git:acme/demo#main");
    expect(hashRef.url).toBe("https://github.com/acme/demo.git");
    expect(hashRef.ref).toBe("main");
  });

  it("keeps scp-style clone URLs without treating git@ as a ref", () => {
    const parsed = expectParsedGitSpec("git:git@github.com:acme/demo.git@release");
    expect(parsed.url).toBe("git@github.com:acme/demo.git");
    expect(parsed.ref).toBe("release");
    expect(parsed.label).toBe("git@github.com:acme/demo.git");
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

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.pluginId).toBe("demo");
    expect(result.git.url).toBe("https://github.com/acme/demo.git");
    expect(result.git.ref).toBe("v1.2.3");
    expect(result.git.commit).toBe("abc123");
    const cloneArgv = runCommandWithTimeoutMock.mock.calls.at(0)?.[0] as string[];
    expect(cloneArgv.slice(0, 3)).toEqual(["git", "clone", "https://github.com/acme/demo.git"]);
    expect(cloneArgv[3]).toContain("/repo");
    expect(runCommandWithTimeoutMock.mock.calls.at(1)?.[0]).toEqual([
      "git",
      "checkout",
      "--detach",
      "v1.2.3",
    ]);
    expect(runCommandWithTimeoutMock.mock.calls.at(3)?.[0]).toEqual([
      "npm",
      "install",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const installOptions = installPluginFromInstalledPackageDirMock.mock.calls.at(0)?.[0] as
      | {
          expectedPluginId?: string;
          packageDir?: string;
          installPolicyRequest?: { kind?: string; requestedSpecifier?: string };
        }
      | undefined;
    expect(installOptions?.expectedPluginId).toBe("demo");
    expect(installOptions?.packageDir).toContain("/repo");
    expect(installOptions?.installPolicyRequest?.kind).toBe("plugin-git");
    expect(installOptions?.installPolicyRequest?.requestedSpecifier).toBe(
      "git:github.com/acme/demo@v1.2.3",
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

    const result = await installPluginFromGitSpec({ spec: "git:github.com/acme/demo" });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }

    const cloneArgv = runCommandWithTimeoutMock.mock.calls.at(0)?.[0] as string[];
    expect(cloneArgv.slice(0, 5)).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "https://github.com/acme/demo.git",
    ]);
    expect(cloneArgv[5]).toContain("/repo");
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
