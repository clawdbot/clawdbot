// Workspace skills bridge tests cover read-only skill mounts across local and
// remote sandbox filesystem bridges.
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import { createSandbox, withTempDir } from "./fs-bridge.test-helpers.js";
import { buildSandboxFsMounts, resolveSandboxFsPathWithMounts } from "./fs-paths.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";

const runRemoteShellScript: RemoteShellSandboxHandle["runRemoteShellScript"] = async (command) => {
  // Run the remote shell bridge scripts locally so path and permission checks are
  // exercised without an SSH server.
  const result = command.script.includes('python3 /dev/fd/3 "$@" 3<<')
    ? spawnSync("python3", ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...(command.args ?? [])], {
        input: command.stdin,
        encoding: "buffer",
        stdio: ["pipe", "pipe", "pipe"],
      })
    : spawnSync("sh", ["-c", command.script, "openclaw-test", ...(command.args ?? [])], {
        input: command.stdin,
        encoding: "buffer",
        stdio: ["pipe", "pipe", "pipe"],
      });
  const stdout = Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout ?? []);
  const stderr = Buffer.isBuffer(result.stderr) ? result.stderr : Buffer.from(result.stderr ?? []);
  const code = result.status ?? (result.signal ? 128 : 1);
  if (result.error) {
    throw result.error;
  }
  if (code !== 0 && !command.allowFailure) {
    throw Object.assign(
      new Error(stderr.toString("utf8").trim() || `shell exited with code ${code}`),
      { code, stdout, stderr },
    );
  }
  return { stdout, stderr, code };
};

describe("workspace skills bridge mount policy", () => {
  it("resolves workspace skill roots as read-only", async () => {
    await withTempDir("openclaw-skills-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
      await fs.mkdir(path.join(workspaceDir, ".agents", "skills", "demo"), { recursive: true });

      const sandbox = createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir });
      const mounts = buildSandboxFsMounts(sandbox);
      const resolve = (filePath: string) =>
        resolveSandboxFsPathWithMounts({
          filePath,
          cwd: sandbox.workspaceDir,
          defaultWorkspaceRoot: sandbox.workspaceDir,
          defaultContainerRoot: sandbox.containerWorkdir,
          mounts,
        });

      expect(resolve("normal.txt").writable).toBe(true);
      expect(resolve("skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve(".agents/skills/demo/SKILL.md").writable).toBe(false);
      expect(resolve("/workspace/skills/demo/SKILL.md").writable).toBe(false);
    });
  });

  it.runIf(process.platform !== "win32")(
    "allows remote bridge writes under absent skill roots",
    async () => {
      await withTempDir("openclaw-skills-remote-absent-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const canonicalWorkspaceDir = await fs.realpath(workspaceDir);

        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: canonicalWorkspaceDir,
            agentWorkspaceDir: canonicalWorkspaceDir,
          }),
          runtime: {
            remoteWorkspaceDir: canonicalWorkspaceDir,
            remoteAgentWorkspaceDir: canonicalWorkspaceDir,
            runRemoteShellScript,
          },
        });

        await bridge.writeFile({ filePath: "skills/new.txt", data: "created" });
        await expect(
          fs.readFile(path.join(canonicalWorkspaceDir, "skills", "new.txt"), "utf8"),
        ).resolves.toBe("created");
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects remote bridge writes under remote-only skill roots",
    async () => {
      await withTempDir("openclaw-skills-remote-only-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
        const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
        const canonicalRemoteWorkspaceDir = await fs.realpath(remoteWorkspaceDir);

        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: canonicalWorkspaceDir,
            agentWorkspaceDir: canonicalWorkspaceDir,
          }),
          runtime: {
            remoteWorkspaceDir: canonicalRemoteWorkspaceDir,
            remoteAgentWorkspaceDir: canonicalRemoteWorkspaceDir,
            runRemoteShellScript,
          },
        });

        await expect(
          bridge.writeFile({
            filePath: "skills/demo/SKILL.md",
            cwd: canonicalRemoteWorkspaceDir,
            data: "# Demo\n",
          }),
        ).rejects.toThrow(/read-only/);
        await expect(
          fs.stat(path.join(canonicalRemoteWorkspaceDir, "skills", "demo", "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects remote bridge writes through symlinks into skill roots",
    async () => {
      // Symlink resolution must happen on the remote side too; otherwise writes
      // can bypass read-only skill root detection.
      await withTempDir("openclaw-skills-remote-link-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
        await fs.symlink("skills", path.join(remoteWorkspaceDir, "link"), "dir");
        const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
        const canonicalRemoteWorkspaceDir = await fs.realpath(remoteWorkspaceDir);

        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: canonicalWorkspaceDir,
            agentWorkspaceDir: canonicalWorkspaceDir,
          }),
          runtime: {
            remoteWorkspaceDir: canonicalRemoteWorkspaceDir,
            remoteAgentWorkspaceDir: canonicalRemoteWorkspaceDir,
            runRemoteShellScript,
          },
        });

        await expect(
          bridge.writeFile({
            filePath: "link/demo/SKILL.md",
            cwd: canonicalRemoteWorkspaceDir,
            data: "# Demo\n",
          }),
        ).rejects.toThrow(/read-only/);
        await expect(
          fs.stat(path.join(canonicalRemoteWorkspaceDir, "skills", "demo", "SKILL.md")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects remote bridge mkdirp under skill roots from container cwd",
    async () => {
      await withTempDir("openclaw-skills-remote-cwd-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const remoteWorkspaceDir = path.join(stateDir, "remote-workspace");
        await fs.mkdir(path.join(workspaceDir, "skills", "demo"), { recursive: true });
        await fs.mkdir(path.join(remoteWorkspaceDir, "skills", "demo"), { recursive: true });
        const canonicalWorkspaceDir = await fs.realpath(workspaceDir);
        const canonicalRemoteWorkspaceDir = await fs.realpath(remoteWorkspaceDir);

        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: canonicalWorkspaceDir,
            agentWorkspaceDir: canonicalWorkspaceDir,
          }),
          runtime: {
            remoteWorkspaceDir: canonicalRemoteWorkspaceDir,
            remoteAgentWorkspaceDir: canonicalRemoteWorkspaceDir,
            runRemoteShellScript,
          },
        });

        await expect(
          bridge.mkdirp({ filePath: "skills/demo/generated", cwd: canonicalRemoteWorkspaceDir }),
        ).rejects.toThrow(/read-only/);
        await expect(
          fs.stat(path.join(canonicalRemoteWorkspaceDir, "skills", "demo", "generated")),
        ).rejects.toMatchObject({ code: "ENOENT" });
      });
    },
  );
});
