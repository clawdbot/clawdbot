// Remote filesystem bridge tests cover SSH-style sandbox file operations using
// the pinned mutation helper and remote stat/path guards.
import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { SANDBOX_CREATE_EXISTS_EXIT_CODE } from "./fs-bridge-mutation-helper.js";
import { createSandbox } from "./fs-bridge.test-helpers.js";
import {
  createRemoteShellSandboxFsBridge,
  type RemoteShellSandboxHandle,
} from "./remote-fs-bridge.js";
import {
  createLocalRemoteShellScriptRunner,
  type LocalRemoteShellSpawn,
  type LocalRemoteShellSpawnResult,
} from "./remote-fs-bridge.test-helpers.js";

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
        return shellResult(`${workspaceDir}/note.txt\n${workspaceDir}\n`);
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
  spawn?: LocalRemoteShellSpawn;
}) {
  // Execute remote shell snippets locally so the bridge scripts are exercised
  // without a real SSH host.
  const calls: Array<Parameters<RemoteShellSandboxHandle["runRemoteShellScript"]>[0]> = [];
  const runtime: RemoteShellSandboxHandle = {
    remoteWorkspaceDir: params.remoteWorkspaceDir,
    remoteAgentWorkspaceDir: params.remoteAgentWorkspaceDir,
    runRemoteShellScript: createLocalRemoteShellScriptRunner({
      spawn: params.spawn,
      onCommand: (command) => calls.push(command),
    }),
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
  it("preserves an authoritative create collision when stdin closes with EPIPE", async () => {
    const pipeError = Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
    const { runtime } = createLocalRemoteRuntime({
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/workspace",
      spawn: () => ({
        error: pipeError,
        status: SANDBOX_CREATE_EXISTS_EXIT_CODE,
        signal: null,
        stdout: Buffer.alloc(0),
        stderr: Buffer.alloc(0),
      }),
    });

    await expect(
      runtime.runRemoteShellScript({
        script: "python3 /dev/fd/3 \"$@\" 3<<'PY'",
        args: ["create", "/workspace", "", "existing.txt", "1"],
        stdin: Buffer.alloc(1_048_576),
        allowFailure: true,
      }),
    ).resolves.toMatchObject({ code: SANDBOX_CREATE_EXISTS_EXIT_CODE });
  });

  it.each([
    {
      name: "an unrecognized script",
      command: { script: "exit 17" },
      result: {},
    },
    {
      name: "a non-create operation",
      command: { args: ["read", "/workspace", "", "existing.txt"] },
      result: {},
    },
    {
      name: "a disallowed failure",
      command: { allowFailure: false },
      result: {},
    },
    {
      name: "a different exit status",
      command: {},
      result: { status: SANDBOX_CREATE_EXISTS_EXIT_CODE + 1 },
    },
    {
      name: "a signaled child",
      command: {},
      result: { status: null, signal: "SIGTERM" as NodeJS.Signals },
    },
    {
      name: "a non-EPIPE spawn error",
      command: {},
      result: { errorCode: "ECONNRESET" },
    },
  ])("keeps spawn errors fatal for $name", async ({ command, result }) => {
    const spawnError = Object.assign(new Error("spawn failed"), {
      code: "errorCode" in result ? result.errorCode : "EPIPE",
    });
    const spawnResult: LocalRemoteShellSpawnResult = {
      error: spawnError,
      status: result.status === undefined ? SANDBOX_CREATE_EXISTS_EXIT_CODE : result.status,
      signal: result.signal === undefined ? null : result.signal,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    };
    const { runtime } = createLocalRemoteRuntime({
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/workspace",
      spawn: () => spawnResult,
    });

    await expect(
      runtime.runRemoteShellScript({
        script: "python3 /dev/fd/3 \"$@\" 3<<'PY'",
        args: ["create", "/workspace", "", "existing.txt", "1"],
        stdin: Buffer.alloc(1_048_576),
        allowFailure: true,
        ...command,
      }),
    ).rejects.toBe(spawnError);
  });

  it.runIf(process.platform !== "win32")(
    "creates files exclusively and preserves existing entries",
    async () => {
      await withTempDir("openclaw-remote-fs-create-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        const { runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          runtime,
        });
        const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
        expect(createFileExclusive).toBeTypeOf("function");

        await expect(
          createFileExclusive!({ filePath: "nested/note.txt", data: "first" }),
        ).resolves.toBe("created");
        await expect(
          createFileExclusive!({ filePath: "nested/note.txt", data: "replacement" }),
        ).resolves.toBe("exists");
        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "note.txt"), "utf8"),
        ).resolves.toBe("first");

        const outcomes = await Promise.all([
          createFileExclusive!({ filePath: "race.txt", data: "one" }),
          createFileExclusive!({ filePath: "race.txt", data: "two" }),
        ]);
        expect(outcomes.toSorted()).toEqual(["created", "exists"]);
        await expect(fs.readFile(path.join(workspaceDir, "race.txt"), "utf8")).resolves.toMatch(
          /^(one|two)$/u,
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "treats a symlink destination as existing without changing its target",
    async () => {
      await withTempDir("openclaw-remote-fs-create-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "target.txt"), "keep", "utf8");
        await fs.symlink("target.txt", path.join(workspaceDir, "link.txt"));
        const { runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          runtime,
        });
        const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
        expect(createFileExclusive).toBeTypeOf("function");

        await expect(
          createFileExclusive!({ filePath: "link.txt", data: Buffer.alloc(1_048_576) }),
        ).resolves.toBe("exists");
        await expect(fs.readFile(path.join(workspaceDir, "target.txt"), "utf8")).resolves.toBe(
          "keep",
        );
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "accepts a symlinked mount root while rejecting escapes through it",
    async () => {
      await withTempDir("openclaw-remote-fs-linked-root-", async (stateDir) => {
        const realWorkspaceDir = path.join(stateDir, "real-workspace");
        const linkedWorkspaceDir = path.join(stateDir, "linked-workspace");
        const outsideDir = path.join(stateDir, "outside");
        await fs.mkdir(realWorkspaceDir);
        await fs.mkdir(outsideDir);
        await fs.symlink(realWorkspaceDir, linkedWorkspaceDir, "dir");
        await fs.symlink(outsideDir, path.join(realWorkspaceDir, "escape"), "dir");
        const { runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: linkedWorkspaceDir,
          remoteAgentWorkspaceDir: linkedWorkspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir: linkedWorkspaceDir,
            agentWorkspaceDir: linkedWorkspaceDir,
          }),
          runtime,
        });
        const createFileExclusive = bridge.createFileExclusive?.bind(bridge);
        expect(createFileExclusive).toBeTypeOf("function");

        await expect(
          createFileExclusive!({ filePath: "inside.txt", data: "inside" }),
        ).resolves.toBe("created");
        await expect(bridge.readFile({ filePath: "inside.txt" })).resolves.toEqual(
          Buffer.from("inside"),
        );
        await expect(bridge.mkdirp({ filePath: "nested/dir" })).resolves.toBeUndefined();
        await expect(fs.readFile(path.join(realWorkspaceDir, "inside.txt"), "utf8")).resolves.toBe(
          "inside",
        );
        await expect(
          fs
            .stat(path.join(realWorkspaceDir, "nested", "dir"))
            .then((entry) => entry.isDirectory()),
        ).resolves.toBe(true);
        await expect(
          createFileExclusive!({ filePath: "escape/outside.txt", data: "blocked" }),
        ).rejects.toThrow(/escapes allowed mounts/);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads files with the pinned mutation helper",
    async () => {
      await withTempDir("openclaw-remote-fs-bridge-", async (stateDir) => {
        const workspacePath = path.join(stateDir, "workspace");
        await fs.mkdir(workspacePath, { recursive: true });
        const workspaceDir = await fs.realpath(workspacePath);
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
        expect(calls).toHaveLength(2);
        const readCall = calls.find((call) => call.args?.[0] === "read");
        expect(readCall?.script).toContain("python3 /dev/fd/3 \"$@\" 3<<'PY'");
        expect(readCall?.script).toContain("read_file(parent_fd, basename)");
        expect(readCall?.script).not.toContain('cat -- "$1"');
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "forwards and enforces bounded pinned file reads",
    async () => {
      await withTempDir("openclaw-remote-fs-bounded-read-", async (stateDir) => {
        const workspacePath = path.join(stateDir, "workspace");
        await fs.mkdir(workspacePath, { recursive: true });
        const workspaceDir = await fs.realpath(workspacePath);
        await fs.writeFile(path.join(workspaceDir, "note.txt"), "hello", "utf8");

        const { calls, runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          runtime,
        });

        await expect(bridge.readFile({ filePath: "note.txt", maxBytes: 5 })).resolves.toEqual(
          Buffer.from("hello"),
        );
        expect(calls.find((call) => call.args?.[0] === "read")?.args).toEqual([
          "read",
          workspaceDir,
          "",
          "note.txt",
          "5",
        ]);
        await expect(bridge.readFile({ filePath: "note.txt", maxBytes: 4 })).rejects.toThrow(
          /bounded read limit/i,
        );
        await expect(bridge.readFile({ filePath: "note.txt", maxBytes: -1 })).rejects.toThrow(
          /non-negative safe integer/i,
        );
        expect(calls).toHaveLength(4);
      });
    },
  );

  it.runIf(process.platform !== "win32")(
    "streams file copies with the pinned mutation helper",
    async () => {
      await withTempDir("openclaw-remote-fs-copy-", async (stateDir) => {
        const workspacePath = path.join(stateDir, "workspace");
        await fs.mkdir(workspacePath, { recursive: true });
        const workspaceDir = await fs.realpath(workspacePath);
        await fs.writeFile(path.join(workspaceDir, "source.txt"), "streamed", "utf8");
        const { calls, runtime } = createLocalRemoteRuntime({
          remoteWorkspaceDir: workspaceDir,
          remoteAgentWorkspaceDir: workspaceDir,
        });
        const bridge = createRemoteShellSandboxFsBridge({
          sandbox: createSandbox({ workspaceDir, agentWorkspaceDir: workspaceDir }),
          runtime,
        });

        const copyFile = bridge.copyFile?.bind(bridge);
        expect(copyFile).toBeTypeOf("function");
        await copyFile!({
          sourcePath: "source.txt",
          destinationPath: "nested/copy.txt",
        });

        await expect(
          fs.readFile(path.join(workspaceDir, "nested", "copy.txt"), "utf8"),
        ).resolves.toBe("streamed");
        expect(calls.some((call) => call.args?.[0] === "copy")).toBe(true);
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
