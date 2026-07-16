// Remote filesystem bridge tests cover SSH-style sandbox file operations using
// the pinned mutation helper and remote stat/path guards.
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

function shellResult(stdout: string) {
  return { stdout: Buffer.from(stdout), stderr: Buffer.alloc(0), code: 0 };
}

function createStatRuntime(
  workspaceDir: string,
  outputs: { hardlinks: (script: string) => string; stat: (script: string) => string },
): RemoteShellSandboxHandle {
  return {
    remoteWorkspaceDir: workspaceDir,
    remoteAgentWorkspaceDir: workspaceDir,
    runRemoteShellScript: async (command) => {
      if (command.script.includes('if [ -e "$1" ] || [ -L "$1" ]')) {
        return shellResult("1\n");
      }
      if (command.script.includes('readlink -f -- "$cursor"')) {
        return shellResult(`${workspaceDir}/note.txt\n`);
      }
      if (command.script.includes('stat -c "%F|%h"')) {
        return shellResult(`${outputs.hardlinks(command.script)}\n`);
      }
      if (command.script.includes('stat -c "%F|%s|%y"')) {
        return shellResult(`${outputs.stat(command.script)}\n`);
      }
      throw new Error(`unexpected remote script: ${command.script}`);
    },
  };
}

function createLocalRemoteRuntime(params: {
  remoteWorkspaceDir: string;
  remoteAgentWorkspaceDir: string;
}) {
  // Execute remote shell snippets locally so the bridge scripts are exercised
  // without a real SSH host.
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

  it.runIf(process.platform !== "win32")(
    "reads dot-dot-prefixed filenames inside the workspace",
    async () => {
      await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "..note.txt"), "hidden", "utf8");

        const bridge = createWorkspaceReadBridge(workspaceDir);

        expect(bridge.resolvePath({ filePath: "..note.txt" })).toMatchObject({
          relativePath: "..note.txt",
          containerPath: `${workspaceDir}/..note.txt`,
        });
        await expect(bridge.readFile({ filePath: "..note.txt" })).resolves.toEqual(
          Buffer.from("hidden"),
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")("rejects symlink escapes while reading", async () => {
    // The remote helper uses no-follow file opens; symlinked final components
    // must fail even when the local caller cannot inspect the remote inode.
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

  it("normalizes stat output locale and saturates unsafe sizes", async () => {
    // Remote stat output is untrusted shell text; unsafe numeric fields should
    // clamp to deterministic values instead of leaking NaN into callers.
    await withTempDir("openclaw-remote-fs-bridge-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: () => "regular file|1",
        stat: (script) =>
          `${script.includes('LC_ALL=C stat -c "%F|%s|%y"') ? "regular file" : "reguläre Datei"}|9007199254740992|8640000000001`,
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toEqual({
        type: "file",
        size: Number.MAX_SAFE_INTEGER,
        mtimeMs: 0,
      });
    });
  });

  it("rejects hardlinked files under localized remote shells", async () => {
    await withTempDir("openclaw-remote-fs-bridge-hardlink-locale-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: (script) =>
          `${script.includes('LC_ALL=C stat -c "%F|%h"') ? "regular file" : "reguläre Datei"}|2`,
        stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).rejects.toThrow(/Hardlinked path/);
    });
  });

  it("does not reject malformed non-decimal hardlink counts", async () => {
    await withTempDir("openclaw-remote-fs-bridge-hardlink-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });
      const runtime = createStatRuntime(workspaceDir, {
        hardlinks: () => "regular file|0x2",
        stat: () => "regular file|12|2026-05-29 12:00:00.000000000 +0000",
      });
      const bridge = createRemoteShellSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
        runtime,
      });

      await expect(bridge.stat({ filePath: "note.txt" })).resolves.toMatchObject({
        type: "file",
        size: 12,
      });
    });
  });
});

async function withTempDir<T>(prefix: string, run: (stateDir: string) => Promise<T>): Promise<T> {
  const stateDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? "/tmp", prefix));
  try {
    return await run(stateDir);
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
  }
}
