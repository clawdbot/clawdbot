/**
 * Exec workdir resolver tests.
 * Verifies cwd selection and validation before exec launches or remote node
 * forwarding.
 */
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveExecWorkdir } from "./bash-tools.exec-workdir.js";
import type { BashSandboxConfig } from "./bash-tools.shared.js";

async function withTempDir(run: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openclaw-exec-workdir-"));
  try {
    await run(await realpath(dir));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function sandboxConfig(workspaceDir: string): BashSandboxConfig {
  return {
    containerName: "sandbox-workdir-test",
    workspaceDir,
    containerWorkdir: "/workspace",
  };
}

function backendSandboxConfig(
  workspaceDir: string,
  params?: {
    containerWorkdir?: string;
    workdirRoots?: readonly string[];
    validateWorkdir?: BashSandboxConfig["validateWorkdir"];
    readOnlyWorkspaceSkillMounts?: BashSandboxConfig["readOnlyWorkspaceSkillMounts"];
  },
): BashSandboxConfig {
  return {
    ...sandboxConfig(workspaceDir),
    containerWorkdir: params?.containerWorkdir ?? "/remote/workspace",
    workdirValidation: "backend",
    workdirRoots: params?.workdirRoots,
    validateWorkdir: params?.validateWorkdir ?? (async (workdir) => workdir),
    readOnlyWorkspaceSkillMounts: params?.readOnlyWorkspaceSkillMounts,
  };
}

describe("resolveExecWorkdir", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects blank explicit local workdirs", async () => {
    await expect(
      resolveExecWorkdir({
        host: "gateway",
        workdir: "   ",
      }),
    ).resolves.toEqual({ kind: "unavailable", requestedCwd: "   " });
  });

  it("rejects missing explicit local workdirs without fallback", async () => {
    await withTempDir(async (workspaceDir) => {
      const missing = path.join(workspaceDir, "missing");
      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: missing,
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: missing });
    });
  });

  it("rejects file explicit local workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      const fileWorkdir = path.join(workspaceDir, "not-dir");
      await writeFile(fileWorkdir, "not a directory");

      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: fileWorkdir,
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: fileWorkdir });
    });
  });

  it("resolves valid explicit local workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: ` ${workspaceDir} `,
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: workspaceDir });
    });
  });

  it("canonicalizes local workdirs before approval and execution", async () => {
    await withTempDir(async (workspaceDir) => {
      const target = path.join(workspaceDir, "target");
      const link = path.join(workspaceDir, "link");
      await mkdir(target);
      await symlink(target, link, "dir");

      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: link,
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: target });
    });
  });

  it("uses configured local cwd when workdir is omitted", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "gateway",
          defaultCwd: workspaceDir,
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: workspaceDir });
    });
  });

  it("treats exact empty workdir as omitted when a local cwd default exists", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: "",
          defaultCwd: workspaceDir,
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: workspaceDir });
    });
  });

  it("treats exact empty workdir as omitted when no local cwd default exists", async () => {
    await withTempDir(async (workspaceDir) => {
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        resolveExecWorkdir({
          host: "gateway",
          workdir: "",
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: workspaceDir });
    });
  });

  it("uses current cwd for omitted local workdir only when no default exists", async () => {
    await withTempDir(async (workspaceDir) => {
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        resolveExecWorkdir({
          host: "gateway",
        }),
      ).resolves.toEqual({ kind: "local", hostCwd: workspaceDir });
    });
  });

  it("fails omitted local workdir when current cwd is unavailable", async () => {
    vi.spyOn(process, "cwd").mockImplementation(() => {
      throw new Error("cwd unavailable");
    });

    await expect(
      resolveExecWorkdir({
        host: "gateway",
      }),
    ).resolves.toEqual({ kind: "unavailable", requestedCwd: "current working directory" });
  });

  it("rejects missing configured local cwd without falling back to current cwd", async () => {
    await withTempDir(async (workspaceDir) => {
      const missingDefault = path.join(workspaceDir, "missing-default");
      vi.spyOn(process, "cwd").mockReturnValue(workspaceDir);

      await expect(
        resolveExecWorkdir({
          host: "gateway",
          defaultCwd: missingDefault,
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: missingDefault });
    });
  });

  it("uses the sandbox workspace when sandbox workdir is omitted", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/workspace",
        scriptPreflightCwd: workspaceDir,
      });
    });
  });

  it("treats exact empty workdir as omitted for sandbox hosts", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/workspace",
        scriptPreflightCwd: workspaceDir,
      });
    });
  });

  it("rejects missing explicit sandbox workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/workspace/missing",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/missing" });
    });
  });

  it("rejects missing configured sandbox workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          defaultCwd: "/workspace/missing",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/missing" });
    });
  });

  it("rejects file sandbox workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      await writeFile(path.join(workspaceDir, "not-dir"), "not a directory");

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/workspace/not-dir",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/not-dir" });
    });
  });

  it("rejects sandbox workdirs that escape the workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (outsideDir) => {
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: outsideDir,
            sandbox: sandboxConfig(workspaceDir),
          }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: outsideDir });
      });
    });
  });

  it("rejects sandbox workdirs with parent-directory segments", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "missing/..",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "missing/.." });

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/workspace/missing/..",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/missing/.." });
    });
  });

  it("rejects sandbox workdir symlinks that escape the workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (outsideDir) => {
        await symlink(outsideDir, path.join(workspaceDir, "escape"), "dir");

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/escape",
            sandbox: sandboxConfig(workspaceDir),
          }),
        ).resolves.toEqual({ kind: "unavailable", requestedCwd: "/workspace/escape" });
      });
    });
  });

  it("resolves relative sandbox workdirs under the workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      const srcDir = path.join(workspaceDir, "src");
      await mkdir(srcDir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "src",
          sandbox: sandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: srcDir,
        containerCwd: "/workspace/src",
        scriptPreflightCwd: srcDir,
      });
    });
  });

  it("supports custom sandbox container workdir prefixes", async () => {
    await withTempDir(async (workspaceDir) => {
      const projectDir = path.join(workspaceDir, "project");
      await mkdir(projectDir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/sandbox-root/project",
          sandbox: {
            ...sandboxConfig(workspaceDir),
            containerWorkdir: "/sandbox-root",
          },
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: projectDir,
        containerCwd: "/sandbox-root/project",
        scriptPreflightCwd: projectDir,
      });
    });
  });

  it("resolves sandbox-skills workdirs via approved read-only mounts", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const skillDir = path.join(skillsMountDir, "test-repro-skill");
        await mkdir(skillDir);
        await mkdir(
          path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills", "test-repro-skill"),
          { recursive: true },
        );

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills/test-repro-skill",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: skillDir,
          containerCwd: "/workspace/.openclaw/sandbox-skills/skills/test-repro-skill",
          scriptPreflightCwd: skillDir,
        });
      });
    });
  });

  it("resolves sandbox-skills subdirectories via approved read-only mounts", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const toolsDir = path.join(skillsMountDir, "test-repro-skill", "tools");
        await mkdir(toolsDir, { recursive: true });

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills/test-repro-skill/tools",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: toolsDir,
          containerCwd: "/workspace/.openclaw/sandbox-skills/skills/test-repro-skill/tools",
          scriptPreflightCwd: toolsDir,
        });
      });
    });
  });

  it("uses the most specific approved mount regardless of input order", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (broadMountDir) => {
        await withTempDir(async (skillsMountDir) => {
          const skillDir = path.join(skillsMountDir, "demo");
          await mkdir(skillDir);
          await mkdir(path.join(broadMountDir, "sandbox-skills", "skills", "demo"), {
            recursive: true,
          });

          await expect(
            resolveExecWorkdir({
              host: "sandbox",
              workdir: "/workspace/.openclaw/sandbox-skills/skills/demo",
              sandbox: {
                ...sandboxConfig(workspaceDir),
                readOnlyWorkspaceSkillMounts: [
                  {
                    containerPath: "/workspace/.openclaw",
                    hostPath: broadMountDir,
                  },
                  {
                    containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                    hostPath: skillsMountDir,
                  },
                ],
              },
            }),
          ).resolves.toEqual({
            kind: "sandbox",
            hostCwd: skillDir,
            containerCwd: "/workspace/.openclaw/sandbox-skills/skills/demo",
            scriptPreflightCwd: skillDir,
          });
        });
      });
    });
  });

  it("resolves the exact approved mount root", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills/",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: skillsMountDir,
          containerCwd: "/workspace/.openclaw/sandbox-skills/skills",
          scriptPreflightCwd: skillsMountDir,
        });
      });
    });
  });

  it("rejects sandbox-skills workdirs when the mount host path is missing", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        // No subdirectory created under skillsMountDir — path doesn't exist

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills/missing-skill",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "unavailable",
          requestedCwd: "/workspace/.openclaw/sandbox-skills/skills/missing-skill",
        });
      });
    });
  });

  it("still resolves primary workspace paths when approved mounts don't match", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const srcDir = path.join(workspaceDir, "src");
        await mkdir(srcDir);
        const projectDir = path.join(workspaceDir, "project");
        await mkdir(projectDir);

        // Primary workspace subdirectory
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/src",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: srcDir,
          containerCwd: "/workspace/src",
          scriptPreflightCwd: srcDir,
        });

        // Container root still works
        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: workspaceDir,
          containerCwd: "/workspace",
          scriptPreflightCwd: workspaceDir,
        });
      });
    });
  });

  it("falls back to primary mapping when no approved mounts are defined", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const skillDir = path.join(skillsMountDir, "test-skill");
        await mkdir(skillDir);

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills/test-skill",
            sandbox: sandboxConfig(workspaceDir),
          }),
        ).resolves.toEqual({
          kind: "unavailable",
          requestedCwd: "/workspace/.openclaw/sandbox-skills/skills/test-skill",
        });
      });
    });
  });

  it("does not match sibling paths outside an approved mount prefix", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        await mkdir(path.join(skillsMountDir, "demo"));

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: "/workspace/.openclaw/sandbox-skills/skills-shadow/demo",
            sandbox: {
              ...sandboxConfig(workspaceDir),
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                  hostPath: skillsMountDir,
                },
              ],
            },
          }),
        ).resolves.toEqual({
          kind: "unavailable",
          requestedCwd: "/workspace/.openclaw/sandbox-skills/skills-shadow/demo",
        });
      });
    });
  });

  it("rejects symlink escape from containerMount host root", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        await withTempDir(async (outsideDir) => {
          const skillDir = path.join(skillsMountDir, "test-skill");
          await mkdir(skillDir);
          // Symlink under skills mount pointing outside
          await symlink(outsideDir, path.join(skillsMountDir, "test-skill", "escape"), "dir");

          await expect(
            resolveExecWorkdir({
              host: "sandbox",
              workdir: "/workspace/.openclaw/sandbox-skills/skills/test-skill/escape",
              sandbox: {
                ...sandboxConfig(workspaceDir),
                readOnlyWorkspaceSkillMounts: [
                  {
                    containerPath: "/workspace/.openclaw/sandbox-skills/skills",
                    hostPath: skillsMountDir,
                  },
                ],
              },
            }),
          ).resolves.toEqual({
            kind: "unavailable",
            requestedCwd: "/workspace/.openclaw/sandbox-skills/skills/test-skill/escape",
          });
        });
      });
    });
  });

  it("lets backend-validated sandboxes use remote-only container workdirs", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/remote/workspace/generated",
          sandbox: backendSandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/remote/workspace/generated",
        scriptPreflightCwd: null,
      });
    });
  });

  it("normalizes backend-validated sandbox workdir roots with trailing slashes", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/remote/workspace/generated",
          sandbox: backendSandboxConfig(workspaceDir, {
            containerWorkdir: "/remote/workspace/",
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/remote/workspace/generated",
        scriptPreflightCwd: null,
      });
    });
  });

  it("lets backend-validated sandboxes use declared alternate remote roots", async () => {
    await withTempDir(async (workspaceDir) => {
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/agent/project",
          sandbox: backendSandboxConfig(workspaceDir, {
            workdirRoots: ["/agent"],
            validateWorkdir,
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/agent/project",
        scriptPreflightCwd: null,
      });
      expect(validateWorkdir).toHaveBeenCalledWith("/agent/project");
    });
  });

  it("resolves relative backend-validated sandbox workdirs under the remote workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "remote-only",
          sandbox: backendSandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/remote/workspace/remote-only",
        scriptPreflightCwd: null,
      });
    });
  });

  it("keeps existing relative backend-validated sandbox workdirs aligned with the local mirror", async () => {
    await withTempDir(async (workspaceDir) => {
      const localDir = path.join(workspaceDir, "src");
      await mkdir(localDir);
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "src",
          sandbox: backendSandboxConfig(workspaceDir, { validateWorkdir }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: localDir,
        containerCwd: "/remote/workspace/src",
        scriptPreflightCwd: localDir,
      });
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/src");
    });
  });

  it("maps backend-validated skill workdirs to their mounted host root", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const containerRoot = "/remote/workspace/.openclaw/sandbox-skills/skills";
        const mountedSkillDir = path.join(skillsMountDir, "test-skill");
        const shadowSkillDir = path.join(
          workspaceDir,
          ".openclaw",
          "sandbox-skills",
          "skills",
          "test-skill",
        );
        await mkdir(mountedSkillDir, { recursive: true });
        await mkdir(shadowSkillDir, { recursive: true });
        const validateWorkdir = vi.fn(async (workdir: string) => workdir);

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: `${containerRoot}/test-skill`,
            sandbox: backendSandboxConfig(workspaceDir, {
              validateWorkdir,
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: containerRoot,
                  hostPath: skillsMountDir,
                },
              ],
            }),
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: mountedSkillDir,
          containerCwd: `${containerRoot}/test-skill`,
          scriptPreflightCwd: mountedSkillDir,
        });
        expect(validateWorkdir).toHaveBeenCalledWith(`${containerRoot}/test-skill`);
      });
    });
  });

  it("prefers backend skill mounts over an overlapping host workspace path", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (skillsMountDir) => {
        const containerRoot = path.join(workspaceDir, ".openclaw", "sandbox-skills", "skills");
        const mountedSkillDir = path.join(skillsMountDir, "test-skill");
        const shadowSkillDir = path.join(containerRoot, "test-skill");
        await mkdir(mountedSkillDir, { recursive: true });
        await mkdir(shadowSkillDir, { recursive: true });

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: `${containerRoot}/test-skill`,
            sandbox: backendSandboxConfig(workspaceDir, {
              readOnlyWorkspaceSkillMounts: [
                {
                  containerPath: containerRoot,
                  hostPath: skillsMountDir,
                },
              ],
            }),
          }),
        ).resolves.toEqual({
          kind: "sandbox",
          hostCwd: mountedSkillDir,
          containerCwd: `${containerRoot}/test-skill`,
          scriptPreflightCwd: mountedSkillDir,
        });
      });
    });
  });

  it("defers stale relative backend-validated sandbox workdirs to the backend", async () => {
    await withTempDir(async (workspaceDir) => {
      const localFile = path.join(workspaceDir, "build");
      await writeFile(localFile, "stale local mirror file");
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "build",
          sandbox: backendSandboxConfig(workspaceDir, { validateWorkdir }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/remote/workspace/build",
        scriptPreflightCwd: null,
      });
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/build");
    });
  });

  it("accepts backend-validated absolute workdirs when the remote workspace root is slash", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/generated",
          sandbox: backendSandboxConfig(workspaceDir, {
            containerWorkdir: "/",
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/generated",
        scriptPreflightCwd: null,
      });
    });
  });

  it("maps host workspace paths for backend-validated sandboxes when they exist locally", async () => {
    await withTempDir(async (workspaceDir) => {
      const localDir = path.join(workspaceDir, "src");
      await mkdir(localDir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: localDir,
          sandbox: backendSandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: localDir,
        containerCwd: "/remote/workspace/src",
        scriptPreflightCwd: localDir,
      });
    });
  });

  it("defers missing absolute backend workdirs to remote validation when roots overlap", async () => {
    await withTempDir(async (workspaceDir) => {
      const missingRemoteDir = path.join(workspaceDir, "generated");
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: missingRemoteDir,
          sandbox: backendSandboxConfig(workspaceDir, {
            containerWorkdir: workspaceDir,
            validateWorkdir,
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: missingRemoteDir,
        scriptPreflightCwd: null,
      });
      expect(validateWorkdir).toHaveBeenCalledWith(missingRemoteDir);
    });
  });

  it("maps missing absolute host workspace paths before backend validation", async () => {
    await withTempDir(async (workspaceDir) => {
      const missingRemoteDir = path.join(workspaceDir, "generated");
      const validateWorkdir = vi.fn(async (workdir: string) => workdir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: missingRemoteDir,
          sandbox: backendSandboxConfig(workspaceDir, {
            validateWorkdir,
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: workspaceDir,
        containerCwd: "/remote/workspace/generated",
        scriptPreflightCwd: null,
      });
      expect(validateWorkdir).toHaveBeenCalledWith("/remote/workspace/generated");
    });
  });

  it("rejects backend-validated sandbox host paths that symlink outside the workspace", async () => {
    await withTempDir(async (workspaceDir) => {
      await withTempDir(async (outsideDir) => {
        const escape = path.join(workspaceDir, "escape");
        await symlink(outsideDir, escape, "dir");

        await expect(
          resolveExecWorkdir({
            host: "sandbox",
            workdir: escape,
            sandbox: backendSandboxConfig(workspaceDir),
          }),
        ).resolves.toEqual({
          kind: "unavailable",
          requestedCwd: escape,
        });
      });
    });
  });

  it("prefers existing host workspace paths over matching backend container prefixes", async () => {
    await withTempDir(async (workspaceDir) => {
      const localDir = path.join(workspaceDir, "src");
      await mkdir(localDir);

      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: localDir,
          sandbox: backendSandboxConfig(workspaceDir, {
            containerWorkdir: workspaceDir,
          }),
        }),
      ).resolves.toEqual({
        kind: "sandbox",
        hostCwd: localDir,
        containerCwd: `${workspaceDir}/src`,
        scriptPreflightCwd: localDir,
      });
    });
  });

  it("rejects backend-validated sandbox workdirs outside local and remote workspace roots", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/other/remote/workspace",
          sandbox: backendSandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        requestedCwd: "/other/remote/workspace",
      });
    });
  });

  it("rejects backend-validated sandbox workdirs with parent-directory segments", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/remote/workspace/missing/..",
          sandbox: backendSandboxConfig(workspaceDir),
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        requestedCwd: "/remote/workspace/missing/..",
      });
    });
  });

  it("rejects backend-validated sandbox workdirs when the backend validator fails", async () => {
    await withTempDir(async (workspaceDir) => {
      await expect(
        resolveExecWorkdir({
          host: "sandbox",
          workdir: "/remote/workspace/missing",
          sandbox: backendSandboxConfig(workspaceDir, {
            validateWorkdir: async () => null,
          }),
        }),
      ).resolves.toEqual({
        kind: "unavailable",
        requestedCwd: "/remote/workspace/missing",
      });
    });
  });

  it("omits node cwd when node workdir is omitted", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        defaultCwd: "/gateway/default",
      }),
    ).resolves.toEqual({ kind: "node" });
  });

  it("uses the node-only default cwd when node workdir is omitted", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        defaultCwd: "/gateway/default",
        nodeCwd: "/remote/node/default",
      }),
    ).resolves.toEqual({ kind: "node", remoteCwd: "/remote/node/default" });
  });

  it("forwards explicit node cwd without local validation", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        workdir: "/remote/node/workspace",
        defaultCwd: "/gateway/default",
        nodeCwd: "/remote/node/default",
      }),
    ).resolves.toEqual({ kind: "node", remoteCwd: "/remote/node/workspace" });
  });

  it("treats exact empty workdir as omitted for node hosts with a node cwd", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        workdir: "",
        nodeCwd: "/remote/node/default",
      }),
    ).resolves.toEqual({ kind: "node", remoteCwd: "/remote/node/default" });
  });

  it("treats exact empty workdir as omitted for node hosts without a node cwd", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        workdir: "",
        defaultCwd: "/gateway/default",
      }),
    ).resolves.toEqual({ kind: "node" });
  });

  it("rejects blank explicit node workdirs", async () => {
    await expect(
      resolveExecWorkdir({
        host: "node",
        workdir: "   ",
      }),
    ).resolves.toEqual({ kind: "unavailable", requestedCwd: "   " });
  });
});
