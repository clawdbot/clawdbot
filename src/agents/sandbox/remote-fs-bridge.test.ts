import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_PINNED_MUTATION_PYTHON } from "./fs-bridge-mutation-helper.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";

function createLocalRemoteRuntime(params: {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
}) {
  const calls: Array<Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]> = [];
  const runtime: RemoteShellSandboxHandle = {
    remoteWorkspaceDir: params.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir,
    runRemoteShellScript: async (command) => {
      calls.push(command);
      const result = command.script.includes("python3 /dev/fd/3 \"$@\" 3<<'PY'")
        ? spawnSync("python3", ["-c", SANDBOX_PINNED_MUTATION_PYTHON, ...(command.args ?? [])], {
            input: command.stdin,
            encoding: "buffer",
            stdio: ["pipe", "pipe", "pipe"],
          })
        : spawnSync("sh", ["-c", command.script, "openclaw-sandbox-fs", ...(command.args ?? [])], {
            input: command.stdin,
            encoding: "buffer",
            stdio: ["pipe", "pipe", "pipe"],
          });
      const stdout = Buffer.isBuffer(result.stdout)
        ? result.stdout
        : Buffer.from(result.stdout ?? []);
      const stderr = Buffer.isBuffer(result.stderr)
        ? result.stderr
        : Buffer.from(result.stderr ?? []);
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
    },
  };
  return { calls, runtime };
}

function createWorkspaceReadBridge(workspaceDir: string) {
  const { runtime } = createLocalRemoteRuntime({
    remoteWorkspaceDir: workspaceDir,
    remoteAgentWorkspaceDir: workspaceDir,
  });
  return createRemoteShellSandboxFsBridge({
    sandbox: createSandbox({
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
    }),
    runtime,
  });
}

describe("remote sandbox fs bridge", () => {
  it.runIf(process.platform !== "win32")(
    "reads files with the pinned mutation helper",
    async () => {
      await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");

        const { calls, runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
          }),
          runtime,
        });

        await expect(bridge.readFile({ filePath: "note.txt" })).resolves.toEqual(
          Buffer.from("hello"),
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args?.[0]).toBe("read");
        expect(calls[0]?.script).toContain("python3 /dev/fd/3 \"$@\" 3<<'PY'");
        expect(calls[0]?.script).toContain("read_file(parent_fd, basename)");
        expect(calls[0]?.script).not.toContain('cat -- "$1"');
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "rejects mount-root reads before invoking the mutation helper",
    async () => {
      await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });

        const { calls, runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
          }),
          runtime,
        });

        await expect(bridge.readFile({ filePath: "." })).rejects.toThrow(
          /Invalid sandbox entry target/,
        );
        expect(calls).toHaveLength(0);
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects symlink escapes while reading", async () => {
    await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      const outsideDir = path.join(stateDir, "outside");
      await fs.mkdir(workspaceDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await fs.writeFile(path.join(outsideDir, "secret.txt"), "classified", "utf8");
      await fs.symlink(path.join(outsideDir, "secret.txt"), path.join(workspaceDir, "link.txt"));

      const bridge = createWorkspaceReadBridge(workspaceDir);

      await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
        /symbolic links|too many levels|ELOOP/i,
      );
    });
  });

  it.runIf(process.platform !== "win32")(
    "rejects final-component symlinks even when they stay inside the workspace",
    async () => {
      await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");
        await fs.symlink("note.txt", path.join(workspaceDir, "link.txt"));

        const bridge = createWorkspaceReadBridge(workspaceDir);

        await expect(bridge.readFile({ filePath: "link.txt" })).rejects.toThrow(
          /symbolic links|too many levels|ELOOP/i,
        );
      });
    },
  );
});

async function withTempDir<T>(prefix: string, run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
