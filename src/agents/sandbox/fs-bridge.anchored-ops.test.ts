import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createSandbox,
  createSandboxFsBridge,
  createSeededSandboxFsBridge,
  dockerExecResult,
  findCallsByScriptFragment,
  findCallByDockerArg,
  findCallByScriptFragment,
  getDockerArg,
  getDockerScript,
  installFsBridgeTestHarness,
  mockedExecDockerRaw,
  withTempDir,
} from "./fs-bridge.test-helpers.js";

type DockerRawCall = NonNullable<ReturnType<typeof findCallByDockerArg>>;

function requireDockerCall(call: DockerRawCall | undefined, label: string): DockerRawCall {
  if (!call) {
    throw new Error(`expected docker call for ${label}`);
  }
  return call;
}

describe("sandbox fs bridge anchored ops", () => {
  installFsBridgeTestHarness();

  const pinnedReadCases = [
    {
      name: "workspace reads use pinned file descriptors",
      filePath: "notes/todo.txt",
      contents: "todo",
      setup: async (workspaceDir: string) => {
        await fs.mkdir(path.join(workspaceDir, "notes"), { recursive: true });
        await fs.writeFile(path.join(workspaceDir, "notes", "todo.txt"), "todo");
      },
      sandbox: (workspaceDir: string) =>
        createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
    },
    {
      name: "bind-mounted reads use pinned file descriptors",
      filePath: "/workspace-two/README.md",
      contents: "bind-read",
      setup: async (workspaceDir: string, stateDir: string) => {
        const bindRoot = path.join(stateDir, "workspace-two");
        await fs.mkdir(workspaceDir, { recursive: true });
        await fs.mkdir(bindRoot, { recursive: true });
        await fs.writeFile(path.join(bindRoot, "README.md"), "bind-read");
      },
      sandbox: (workspaceDir: string, stateDir: string) =>
        createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
          docker: {
            ...createSandbox().docker,
            binds: [`${path.join(stateDir, "workspace-two")}:/workspace-two:ro`],
          },
        }),
    },
  ] as const;

  it.each(pinnedReadCases)("$name", async (testCase) => {
    await withTempDir("openclaw-fs-bridge-contract-read-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await testCase.setup(workspaceDir, stateDir);
      const bridge = createSandboxFsBridge({
        sandbox: testCase.sandbox(workspaceDir, stateDir),
      });

      await expect(bridge.readFile({ filePath: testCase.filePath })).resolves.toEqual(
        Buffer.from(testCase.contents),
      );
      expect(mockedExecDockerRaw).not.toHaveBeenCalled();
    });
  });

  const pinnedCases = [
    {
      name: "write pins canonical parent + basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.writeFile({ filePath: "nested/file.txt", data: "updated" }),
      expectedArgs: ["write", "/workspace", "nested", "file.txt", "1"],
      forbiddenArgs: ["/workspace/nested/file.txt"],
    },
    {
      name: "mkdirp pins mount root + relative path",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.mkdirp({ filePath: "nested/leaf" }),
      expectedArgs: ["mkdirp", "/workspace", "nested/leaf"],
      forbiddenArgs: ["/workspace/nested/leaf"],
    },
    {
      name: "remove pins mount root + parent/basename",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.remove({ filePath: "nested/file.txt" }),
      expectedArgs: ["remove", "/workspace", "nested", "file.txt", "0", "1"],
      forbiddenArgs: ["/workspace/nested/file.txt"],
    },
    {
      name: "rename pins both parents + basenames",
      invoke: (bridge: ReturnType<typeof createSandboxFsBridge>) =>
        bridge.rename({ from: "from.txt", to: "nested/to.txt" }),
      expectedArgs: ["rename", "/workspace", "", "from.txt", "/workspace", "nested", "to.txt", "1"],
      forbiddenArgs: ["/workspace/from.txt", "/workspace/nested/to.txt"],
    },
  ] as const;

  it.each(pinnedCases)("$name", async (testCase) => {
    await withTempDir("openclaw-fs-bridge-contract-write-", async (stateDir) => {
      const { bridge } = await createSeededSandboxFsBridge(stateDir);

      await testCase.invoke(bridge);

      const opCall = mockedExecDockerRaw.mock.calls.find(
        ([args]) =>
          typeof args[5] === "string" &&
          args[5].includes('exec "$python_cmd" -c "$python_script" "$@"') &&
          getDockerArg(args, 1) === testCase.expectedArgs[0],
      );
      const args = requireDockerCall(opCall, testCase.name)[0];
      testCase.expectedArgs.forEach((value, index) => {
        expect(getDockerArg(args, index + 1)).toBe(value);
      });
      testCase.forbiddenArgs.forEach((value) => {
        expect(args).not.toContain(value);
      });
    });
  });

  it.runIf(process.platform !== "win32")(
    "write resolves symlink parents to canonical pinned paths",
    async () => {
      await withTempDir("openclaw-fs-bridge-contract-write-", async (stateDir) => {
        const workspaceDir = path.join(stateDir, "workspace");
        const realDir = path.join(workspaceDir, "real");
        await fs.mkdir(realDir, { recursive: true });
        await fs.symlink(realDir, path.join(workspaceDir, "alias"));

        mockedExecDockerRaw.mockImplementation(async (args) => {
          const script = getDockerScript(args);
          if (script.includes('readlink -f -- "$cursor"')) {
            const target = getDockerArg(args, 1);
            return dockerExecResult(`${target.replace("/workspace/alias", "/workspace/real")}\n`);
          }
          if (script.includes('stat -c "%F|%s|%Y"')) {
            return dockerExecResult("regular file|1|2");
          }
          return dockerExecResult("");
        });

        const bridge = createSandboxFsBridge({
          sandbox: createSandbox({
            workspaceDir,
            agentWorkspaceDir: workspaceDir,
          }),
        });

        await bridge.writeFile({ filePath: "alias/note.txt", data: "updated" });

        const writeCall = findCallByDockerArg(1, "write");
        const args = requireDockerCall(writeCall, "write")[0];
        expect(getDockerArg(args, 2)).toBe("/workspace");
        expect(getDockerArg(args, 3)).toBe("real");
        expect(getDockerArg(args, 4)).toBe("note.txt");
        expect(args).not.toContain("alias");

        const canonicalCalls = findCallsByScriptFragment('readlink -f -- "$cursor"');
        expect(
          canonicalCalls.some(([callArgs]) => getDockerArg(callArgs, 1) === "/workspace/alias"),
        ).toBe(true);
      });
    },
  );

  it("stat anchors parent + basename", async () => {
    await withTempDir("openclaw-fs-bridge-contract-stat-", async (stateDir) => {
      const workspaceDir = path.join(stateDir, "workspace");
      await fs.mkdir(path.join(workspaceDir, "nested"), { recursive: true });
      await fs.writeFile(path.join(workspaceDir, "nested", "file.txt"), "bye", "utf8");

      const bridge = createSandboxFsBridge({
        sandbox: createSandbox({
          workspaceDir,
          agentWorkspaceDir: workspaceDir,
        }),
      });

      await bridge.stat({ filePath: "nested/file.txt" });

      const statCall = findCallByScriptFragment('stat -c "%F|%s|%Y" -- "$2"');
      const args = requireDockerCall(statCall, "stat")[0];
      expect(getDockerArg(args, 1)).toBe("/workspace/nested");
      expect(getDockerArg(args, 2)).toBe("file.txt");
      expect(args).not.toContain("/workspace/nested/file.txt");
    });
  });
});
