// Covers plugin install behavior from git-backed sources.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { redactSensitiveUrlLikeString } from "@openclaw/net-policy/redact-sensitive-url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { DiagnosticSecurityEvent } from "../infra/diagnostic-events.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";

const runCommandWithTimeoutMock = vi.fn();
const installPluginFromInstalledPackageDirMock = vi.fn();
const preflightPluginGitInstallPolicyMock = vi.fn();

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

vi.mock("./install-security-scan.js", async () => {
  const actual = await vi.importActual<typeof import("./install-security-scan.js")>(
    "./install-security-scan.js",
  );
  return {
    ...actual,
    preflightPluginGitInstallPolicy: (...args: unknown[]) =>
      preflightPluginGitInstallPolicyMock(...args),
  };
});

vi.resetModules();

const { installPluginFromGitSpec, isImmutableGitCommitRef, parseGitPluginSpec } =
  await import("./git-install.js");
const { onInternalDiagnosticEvent } = await import("../infra/diagnostic-events.js");

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
function commandArgvAt(index: number): string[] {
  const call = runCommandWithTimeoutMock.mock.calls[index];
  if (!call) {
    throw new Error(`expected command run #${index + 1}`);
  }
  return call[0] as string[];
}

function firstInstallOptions():
  | {
      expectedPluginId?: string;
      emitSuccessSecurityEvent?: boolean;
      packageDir?: string;
      mode?: string;
      installPolicyRequest?: { kind?: string; requestedSpecifier?: string };
    }
  | undefined {
  return installPluginFromInstalledPackageDirMock.mock.calls[0]?.[0] as
    | {
        expectedPluginId?: string;
        emitSuccessSecurityEvent?: boolean;
        packageDir?: string;
        mode?: string;
        installPolicyRequest?: { kind?: string; requestedSpecifier?: string };
      }
    | undefined;
}

function captureSecurityEvents(): {
  events: DiagnosticSecurityEvent[];
  stop: () => void;
} {
  const events: DiagnosticSecurityEvent[] = [];
  const stop = onInternalDiagnosticEvent((event, metadata) => {
    if (metadata.trusted && event.type === "security.event") {
      events.push(event);
    }
  });
  return { events, stop };
}

describe("parseGitPluginSpec", () => {
  it("normalizes GitHub shorthand and ref selectors", () => {
    const explicitRef = expectParsedGitSpec("git:github.com/acme/demo@v1.2.3");
    expect(explicitRef.url).toBe("https://github.com/acme/demo.git");
    expect(explicitRef.ref).toBe("v1.2.3");
    expect(explicitRef.label).toBe("acme/demo");
    expect(explicitRef.normalizedSpec).toBe("git:https://github.com/acme/demo.git@v1.2.3");

    const slashRef = expectParsedGitSpec("git:acme/demo@feature/foo");
    expect(slashRef.url).toBe("https://github.com/acme/demo.git");
    expect(slashRef.ref).toBe("feature/foo");
    expect(slashRef.label).toBe("acme/demo");

    const hashRef = expectParsedGitSpec("git:acme/demo#main");
    expect(hashRef.url).toBe("https://github.com/acme/demo.git");
    expect(hashRef.ref).toBe("main");
  });

  it("does not treat URL credentials as ref selectors", () => {
    const parsed = expectParsedGitSpec("git:https://token:secret@github.com/acme/demo.git");
    expect(parsed.url).toBe("https://token:secret@github.com/acme/demo.git");
    expect(parsed.ref).toBeUndefined();
    expect(parsed.label).toBe("github.com/acme/demo");
  });

  it("keeps scp-style clone URLs without treating git@ as a ref", () => {
    const parsed = expectParsedGitSpec("git:git@github.com:acme/demo.git@feature/foo");
    expect(parsed.url).toBe("git@github.com:acme/demo.git");
    expect(parsed.ref).toBe("feature/foo");
    expect(parsed.label).toBe("git@github.com:acme/demo");
  });

  it("rejects option-injection specs whose url would start with a dash", () => {
    expect(parseGitPluginSpec("git:--upload-pack=/tmp/pwn.git")).toBeNull();
    expect(parseGitPluginSpec("git:-oProxyCommand=payload@example.com:acme/demo.git")).toBeNull();
  });
});

describe("isImmutableGitCommitRef", () => {
  it.each([
    [undefined, false],
    ["main", false],
    ["v1.2.3", false],
    ["abc123", false],
    ["0123456789abcdef0123456789abcdef01234567", true],
    ["0123456789ABCDEF0123456789ABCDEF01234567", true],
  ] as const)("classifies %s as immutable=%s", (ref, expected) => {
    expect(isImmutableGitCommitRef(ref)).toBe(expected);
  });
});

describe("installPluginFromGitSpec", () => {
  const tempDirs: string[] = [];
  const trackedTempDirs = useAutoCleanupTempDirTracker(afterEach);

  beforeEach(async () => {
    runCommandWithTimeoutMock.mockReset();
    installPluginFromInstalledPackageDirMock.mockReset();
    preflightPluginGitInstallPolicyMock.mockReset();
    preflightPluginGitInstallPolicyMock.mockResolvedValue(null);
    const globalConfigRoot = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-git-install-npmrc-"),
    );
    tempDirs.push(globalConfigRoot);
    const globalConfig = path.join(globalConfigRoot, "global-npmrc");
    await fs.writeFile(globalConfig, "", "utf8");
    vi.stubEnv("NPM_CONFIG_GLOBALCONFIG", globalConfig);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(
      tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });

  it("rejects option-leading clone sources before invoking git", async () => {
    const result = await installPluginFromGitSpec({
      spec: "git:--upload-pack=/tmp/pwn.git",
      dryRun: true,
    });

    expect(result).toEqual({
      ok: false,
      error: "unsupported git: plugin spec: git:--upload-pack=/tmp/pwn.git",
    });
    expect(runCommandWithTimeoutMock).not.toHaveBeenCalled();
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

    const captured = captureSecurityEvents();
    let result: Awaited<ReturnType<typeof installPluginFromGitSpec>>;
    try {
      result = await installPluginFromGitSpec({
        spec: "git:github.com/acme/demo@v1.2.3",
        expectedPluginId: "demo",
      });
    } finally {
      captured.stop();
    }

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.pluginId).toBe("demo");
    expect(result.git.url).toBe("https://github.com/acme/demo.git");
    expect(result.git.ref).toBe("v1.2.3");
    expect(result.git.commit).toBe("abc123");
    const cloneArgv = commandArgvAt(0);
    expect(cloneArgv.slice(0, 4)).toEqual([
      "git",
      "clone",
      "--",
      "https://github.com/acme/demo.git",
    ]);
    expect(cloneArgv[4]).toContain("/repo");
    expect(commandArgvAt(1)).toEqual(["git", "switch", "--detach", "--", "v1.2.3"]);
    expect(commandArgvAt(3)).toEqual([
      "npm",
      "install",
      "--omit=dev",
      "--loglevel=error",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ]);
    const installOptions = firstInstallOptions();
    expect(installOptions?.expectedPluginId).toBe("demo");
    expect(installOptions?.packageDir).toContain("/repo");
    expect(installOptions?.installPolicyRequest?.kind).toBe("plugin-git");
    expect(installOptions?.installPolicyRequest?.requestedSpecifier).toBe(
      "git:github.com/acme/demo@v1.2.3",
    );
    expect(installOptions?.emitSuccessSecurityEvent).toBe(false);
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "plugin.installed",
      outcome: "success",
      target: { kind: "plugin", name: "demo" },
      attributes: {
        source_family: "git",
        mode: "install",
        extension_count: 1,
        has_version: true,
      },
    });
  });

  it("does not emit git install success when committing the managed repo fails", async () => {
    const gitRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-install-fail-"));
    const gitDir = path.join(gitRoot, "not-a-directory");
    await fs.writeFile(gitDir, "file blocks nested managed repo creation", "utf8");
    try {
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" });
      installPluginFromInstalledPackageDirMock.mockImplementation(
        async (params: { packageDir: string }) => {
          await fs.mkdir(params.packageDir, { recursive: true });
          await fs.writeFile(path.join(params.packageDir, "package.json"), "{}", "utf8");
          return {
            ok: true,
            pluginId: "demo",
            targetDir: params.packageDir,
            version: "1.2.3",
            extensions: ["index.js"],
          };
        },
      );
      const captured = captureSecurityEvents();

      let result: Awaited<ReturnType<typeof installPluginFromGitSpec>>;
      try {
        result = await installPluginFromGitSpec({
          spec: "git:github.com/acme/demo",
          gitDir,
        });
      } finally {
        captured.stop();
      }

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain("failed to replace managed git plugin repository");
      }
      expect(firstInstallOptions()?.emitSuccessSecurityEvent).toBe(false);
      expect(captured.events).toHaveLength(0);
    } finally {
      await fs.rm(gitRoot, { recursive: true, force: true });
    }
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

    const cloneArgv = commandArgvAt(0);
    expect(cloneArgv.slice(0, 6)).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/acme/demo.git",
    ]);
    expect(cloneArgv[6]).toContain("/repo");
  });

  it("runs install policy preflight before npm installs git dependencies", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });
    preflightPluginGitInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        reason: "blocked by install policy: git installs disabled",
        code: "security_scan_blocked",
      },
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof installPluginFromGitSpec>>;
    try {
      result = await installPluginFromGitSpec({
        spec: "git:github.com/acme/demo",
        expectedPluginId: "demo",
      });
    } finally {
      captured.stop();
    }

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("git installs disabled");
    }
    expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(2);
    expect(commandArgvAt(0).slice(0, 6)).toEqual([
      "git",
      "clone",
      "--depth",
      "1",
      "--",
      "https://github.com/acme/demo.git",
    ]);
    expect(commandArgvAt(1)).toEqual(["git", "rev-parse", "HEAD"]);
    expect(preflightPluginGitInstallPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "demo",
        requestedSpecifier: "git:github.com/acme/demo",
        source: { kind: "git", authority: "third-party", mutable: true, network: true },
        sourcePath: expect.stringContaining("/repo"),
      }),
    );
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "plugin.audit.failed",
      outcome: "denied",
      target: { kind: "plugin", name: "demo" },
      attributes: {
        source_family: "git",
        mode: "install",
      },
    });
  });

  it("emits git audit errors when install policy preflight fails", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });
    preflightPluginGitInstallPolicyMock.mockResolvedValueOnce({
      blocked: {
        reason: "install policy unavailable",
        code: "security_scan_failed",
      },
    });
    const captured = captureSecurityEvents();

    let result: Awaited<ReturnType<typeof installPluginFromGitSpec>>;
    try {
      result = await installPluginFromGitSpec({
        spec: "git:file:///Users/example/private-plugin",
      });
    } finally {
      captured.stop();
    }

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("install policy unavailable");
    }
    expect(installPluginFromInstalledPackageDirMock).not.toHaveBeenCalled();
    expect(captured.events).toHaveLength(1);
    expect(captured.events[0]).toMatchObject({
      action: "plugin.audit.failed",
      outcome: "error",
      target: { kind: "plugin" },
      attributes: {
        source_family: "git",
        mode: "install",
      },
    });
    expect(captured.events[0]?.target).not.toHaveProperty("name");
  });

  it("reports full commit refs as immutable to install policy", async () => {
    const commit = "0123456789abcdef0123456789abcdef01234567";
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({ code: 0, stdout: `${commit}\n`, stderr: "" })
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
      spec: `git:github.com/acme/demo@${commit}`,
      expectedPluginId: "demo",
    });

    expect(result.ok).toBe(true);
    expect(preflightPluginGitInstallPolicyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        requestedSpecifier: `git:github.com/acme/demo@${commit}`,
        source: { kind: "git", authority: "third-party", mutable: false, network: true },
      }),
    );
  });

  it("reports effective install mode for requested git update without an installed target", async () => {
    const gitDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-git-install-mode-"));
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
        spec: "git:github.com/acme/demo",
        expectedPluginId: "demo",
        gitDir,
        mode: "update",
      });

      expect(result.ok).toBe(true);
      expect(preflightPluginGitInstallPolicyMock).toHaveBeenCalledWith(
        expect.objectContaining({ mode: "install" }),
      );
      expect(firstInstallOptions()?.mode).toBe("install");
    } finally {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
  });

  it("stages the clone beside the managed repo so replacement stays on one filesystem (#99885)", async () => {
    const gitDir = trackedTempDirs.make("openclaw-git-install-stage-");
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
        spec: "git:github.com/acme/demo",
        gitDir,
      });
      expect(result.ok).toBe(true);
      if (!result.ok) {
        throw new Error(result.error);
      }

      const cloneArgv = commandArgvAt(0);
      const cloneDest = cloneArgv[cloneArgv.length - 1];
      const persistentRepoDir = expectedGitRepoDir({
        gitDir,
        normalizedSpec: "git:https://github.com/acme/demo.git",
      });
      const cloneParent = await fs.realpath(path.dirname(path.dirname(path.resolve(cloneDest))));
      const targetParent = await fs.realpath(path.dirname(persistentRepoDir));
      expect(cloneParent).toBe(targetParent);
    } finally {
      await fs.rm(gitDir, { recursive: true, force: true });
    }
  });

  it("falls back to the OpenClaw temp root when target workspace creation fails", async () => {
    const gitDir = trackedTempDirs.make("openclaw-git-install-stage-fallback-");
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
    const mkdtempSpy = vi
      .spyOn(fs, "mkdtemp")
      .mockRejectedValueOnce(Object.assign(new Error("read-only filesystem"), { code: "EROFS" }));

    try {
      const result = await installPluginFromGitSpec({
        spec: "git:github.com/acme/demo",
        gitDir,
      });

      expect(result.ok).toBe(true);
      expect(mkdtempSpy).toHaveBeenCalledTimes(2);
      const targetPrefix = mkdtempSpy.mock.calls[0]?.[0];
      const fallbackPrefix = mkdtempSpy.mock.calls[1]?.[0];
      const persistentRepoDir = expectedGitRepoDir({
        gitDir,
        normalizedSpec: "git:https://github.com/acme/demo.git",
      });
      expect(path.dirname(targetPrefix)).toBe(await fs.realpath(path.dirname(persistentRepoDir)));
      // withTempDir roots fallback staging at resolvePreferredOpenClawTmpDir(), which
      // prefers /tmp/openclaw and only degrades to a uid-scoped os.tmpdir path when
      // that is unsafe. Recompute it here so the assertion holds on every host.
      expect(path.dirname(fallbackPrefix)).toBe(
        await fs.realpath(resolvePreferredOpenClawTmpDir()),
      );
      expect(runCommandWithTimeoutMock).toHaveBeenCalledTimes(3);
    } finally {
      mkdtempSpy.mockRestore();
    }
  });

  it("keeps dry-run clone staging out of managed state", async () => {
    const caseDir = trackedTempDirs.make("openclaw-git-dry-run-stage-");
    const gitDir = path.join(caseDir, "git");
    try {
      runCommandWithTimeoutMock
        .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
        .mockResolvedValueOnce({ code: 0, stdout: "abc123\n", stderr: "" });
      installPluginFromInstalledPackageDirMock.mockImplementation(
        async (params: { packageDir: string }) => ({
          ok: true,
          pluginId: "demo",
          targetDir: params.packageDir,
          version: "1.2.3",
          extensions: ["index.js"],
        }),
      );

      const result = await installPluginFromGitSpec({
        spec: "git:github.com/acme/demo",
        gitDir,
        dryRun: true,
      });

      expect(result.ok).toBe(true);
      const cloneArgv = commandArgvAt(0);
      const cloneDest = path.resolve(cloneArgv[cloneArgv.length - 1]);
      expect(path.relative(gitDir, cloneDest).split(path.sep)[0]).toBe("..");
      await expect(fs.access(gitDir)).rejects.toThrow();
    } finally {
      await fs.rm(caseDir, { recursive: true, force: true });
    }
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

  it("separates requested refs from git options", async () => {
    runCommandWithTimeoutMock
      .mockResolvedValueOnce({ code: 0, stdout: "", stderr: "" })
      .mockResolvedValueOnce({
        code: 128,
        stdout: "",
        stderr: "fatal: invalid reference: --ignore-skip-worktree-bits",
      });

    const result = await installPluginFromGitSpec({
      spec: "git:github.com/acme/demo@--ignore-skip-worktree-bits",
    });

    expect(result.ok).toBe(false);
    expect(commandArgvAt(1)).toEqual([
      "git",
      "switch",
      "--detach",
      "--",
      "--ignore-skip-worktree-bits",
    ]);
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
