import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveWindowsSpawnProgram } from "openclaw/plugin-sdk/windows-spawn";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codexAppServerStartOptionsKey } from "./config-runtime.js";
import type { CodexAppServerStartOptions } from "./config.js";
import { createStdioTransport } from "./transport-stdio.js";

const spawnMock = vi.hoisted(() => vi.fn(() => ({ pid: 1234 })));
const prepareRegistration = vi.hoisted(() => vi.fn(async () => async () => {}));

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("./transport-process-registration.js", () => ({
  prepareCodexAppServerProcessRegistration: prepareRegistration,
}));

let root: string;
let workspace: string;
let command: string;

// Only the spawn boundary is mocked. These inert image headers are never executed.
async function writeImage(file: string, magic = "7f454c46") {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.concat([Buffer.from(magic, "hex"), Buffer.alloc(60)]));
  await fs.chmod(file, 0o755);
}

function startOptions(
  overrides: Partial<CodexAppServerStartOptions> = {},
): CodexAppServerStartOptions {
  return {
    transport: "stdio",
    command,
    commandSource: "config",
    args: ["app-server", "--listen", "stdio://"],
    headers: {},
    cwd: workspace,
    protectedLaunchRoots: [workspace],
    ...overrides,
  };
}

async function expectRejected(options: CodexAppServerStartOptions) {
  await expect(createStdioTransport(options, {})).rejects.toThrow();
  expect(spawnMock).not.toHaveBeenCalled();
}

beforeEach(async () => {
  spawnMock.mockClear();
  prepareRegistration.mockReset().mockResolvedValue(async () => {});
  root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "codex-protected-launch-")));
  workspace = path.join(root, "workspace");
  command = path.join(root, "operator", "codex");
  await fs.mkdir(workspace);
  await writeImage(command);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await fs.rm(root, { recursive: true, force: true });
});

describe("protected Codex stdio launch", () => {
  describe("Windows npm resolution", () => {
    let launcher: string;
    let env: Record<string, string>;

    beforeEach(async () => {
      // Exercise the actual SDK resolver on temporary files; no Windows OS or ACL claim.
      vi.stubGlobal("process", { ...process, platform: "win32", arch: "x64" });
      const protectedBin = path.join(root, "operator");
      const packageRoot = path.join(protectedBin, "node_modules", "@openai", "codex");
      const nativePackage = path.join(packageRoot, "node_modules", "@openai", "codex-win32-x64");
      launcher = path.join(packageRoot, "bin", "codex.js");
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await writeImage(
        path.join(nativePackage, "vendor", "x86_64-pc-windows-msvc", "bin", "codex.exe"),
        "4d5a9000",
      );
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({ name: "@openai/codex", bin: { codex: "bin/codex.js" } }),
      );
      await fs.writeFile(
        path.join(nativePackage, "package.json"),
        JSON.stringify({ name: "@openai/codex-win32-x64" }),
      );
      await fs.writeFile(launcher, "// Inert official-entrypoint fixture; never executed.\n");
      await fs.writeFile(
        path.join(protectedBin, "codex.cmd"),
        '@echo off\r\n"%~dp0\\node_modules\\@openai\\codex\\bin\\codex.js" %*\r\n',
      );
      env = { PATH: [workspace, protectedBin].join(";"), PATHEXT: ".CMD;.EXE" };
    });

    it("accepts a protected npm shim with a recognized JavaScript entrypoint and native PE target", async () => {
      await createStdioTransport(startOptions({ command: "codex", env }), {});
      expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
        await fs.realpath(process.execPath),
        [launcher, "app-server", "--listen", "stdio://"],
        expect.objectContaining({ shell: undefined, windowsHide: true, detached: false }),
      );
    });

    it("rejects the retained workspace script when its earlier PATH shim disappears before validation", async () => {
      const workspaceShim = path.join(workspace, "codex.cmd");
      const workspaceScript = path.join(workspace, "payload.js");
      await fs.writeFile(workspaceScript, "// Inert workspace fixture; never executed.\n");
      await fs.writeFile(workspaceShim, '@echo off\r\n"%~dp0\\payload.js" %*\r\n');
      expect(resolveWindowsSpawnProgram({ command: "codex", env })).toMatchObject({
        command: process.execPath,
        leadingArgv: [workspaceScript],
        resolution: "node-entrypoint",
      });
      prepareRegistration.mockImplementationOnce(async () => {
        // Transport has already materialized argv; only the later PATH lookup changes.
        await fs.unlink(workspaceShim);
        return async () => {};
      });
      await expectRejected(startOptions({ command: "codex", env }));
      expect(prepareRegistration).toHaveBeenCalledOnce();
      expect(resolveWindowsSpawnProgram({ command: "codex", env })).toMatchObject({
        command: process.execPath,
        leadingArgv: [launcher],
        resolution: "node-entrypoint",
      });
      await expect(fs.readFile(workspaceScript, "utf8")).resolves.toContain("Inert workspace");
    });
  });

  it
    .runIf(process.platform === "darwin" || process.platform === "linux")
    .each(["protected PATH", "empty writable directory before protected PATH"])(
    "validates the recognized npm entrypoint with %s",
    async (selection) => {
      const packageRoot = path.join(root, "node_modules", "@openai", "codex");
      const launcher = path.join(packageRoot, "bin", "codex.js");
      const arch = process.arch === "arm64" ? "arm64" : "x64";
      const triple = `${arch === "arm64" ? "aarch64" : "x86_64"}-${process.platform === "darwin" ? "apple-darwin" : "unknown-linux-musl"}`;
      const packageName = `codex-${process.platform}-${arch}`;
      const nativePackage = path.join(packageRoot, "node_modules", "@openai", packageName);
      await fs.mkdir(path.dirname(launcher), { recursive: true });
      await writeImage(path.join(nativePackage, "vendor", triple, "bin", "codex"));
      await writeImage(path.join(root, "bin", "node"));
      await fs.writeFile(
        path.join(packageRoot, "package.json"),
        JSON.stringify({
          name: "@openai/codex",
          bin: { codex: "bin/codex.js" },
        }),
      );
      await fs.writeFile(
        path.join(nativePackage, "package.json"),
        JSON.stringify({ name: `@openai/${packageName}` }),
      );
      await fs.writeFile(launcher, "#!/usr/bin/env node\n");
      await fs.chmod(launcher, 0o755);
      const protectedBin = path.join(root, "bin");
      const writableLookup = selection !== "protected PATH";
      const options = startOptions({
        command: launcher,
        env: {
          PATH: writableLookup ? [workspace, protectedBin].join(path.delimiter) : protectedBin,
        },
      });
      if (writableLookup) {
        // /usr/bin/env resolves node at execution time, after admission finishes.
        await expect(fs.readdir(workspace)).resolves.toEqual([]);
        await expectRejected(options);
        return;
      }
      await createStdioTransport(options, {});
      expect(spawnMock).toHaveBeenCalledWith(
        launcher,
        ["app-server", "--listen", "stdio://"],
        expect.any(Object),
      );
    },
  );

  it.each([
    ["ELF", "7f454c46"],
    ["Mach-O", "cffaedfe"],
    ["PE", "4d5a9000"],
  ])("accepts a protected %s image at the final spawn boundary", async (_format, magic) => {
    await writeImage(command, magic);
    await createStdioTransport(startOptions(), {});
    expect(spawnMock).toHaveBeenCalledExactlyOnceWith(
      command,
      ["app-server", "--listen", "stdio://"],
      expect.objectContaining({ cwd: workspace, shell: undefined }),
    );
  });

  it.each([
    ["absolute", "absolute"],
    ["relative", "relative"],
    ["PATH-selected", "path"],
    ["bound directory", "bind"],
  ])("rejects a native image selected from a model-writable %s root", async (_name, selection) => {
    const exposed = selection === "bind" ? path.join(root, "bound") : workspace;
    const writableCommand = path.join(exposed, "codex");
    await writeImage(writableCommand);
    const selected =
      selection === "relative" ? "./codex" : selection === "path" ? "codex" : writableCommand;
    await expectRejected(
      startOptions({
        command: selected,
        env: { PATH: exposed },
        protectedLaunchRoots: [workspace, exposed],
      }),
    );
  });

  it
    .runIf(process.platform !== "win32")
    .each(["inside-to-outside", "outside-to-inside", "ancestor"])(
    "rejects a model-writable %s executable alias",
    async (selection) => {
      let alias: string;
      if (selection === "inside-to-outside") {
        alias = path.join(workspace, "codex");
        await fs.symlink(command, alias);
      } else if (selection === "outside-to-inside") {
        const writableCommand = path.join(workspace, "codex");
        await writeImage(writableCommand);
        alias = path.join(root, "alias");
        await fs.symlink(writableCommand, alias);
      } else {
        const directoryAlias = path.join(workspace, "operator");
        await fs.symlink(path.dirname(command), directoryAlias, "dir");
        alias = path.join(directoryAlias, "codex");
      }
      await expectRejected(startOptions({ command: alias }));
    },
  );

  it("rejects an executable whose parent can be replaced through an exposed ancestor", async () => {
    await expectRejected(startOptions({ protectedLaunchRoots: [root] }));
  });

  it("accepts a protected native image linked to an operator-owned package cache", async () => {
    const cache = path.join(root, "package-cache");
    await fs.mkdir(cache);
    await fs.link(command, path.join(cache, "codex"));
    expect((await fs.stat(command)).nlink).toBe(2);
    await createStdioTransport(startOptions(), {});
    expect(spawnMock).toHaveBeenCalledWith(command, expect.any(Array), expect.any(Object));
  });

  it.runIf(process.platform !== "win32")(
    "resolves an operator-owned PATH image to its absolute spawn path",
    async () => {
      await createStdioTransport(
        startOptions({ command: "codex", env: { PATH: path.dirname(command) } }),
        {},
      );
      expect(spawnMock).toHaveBeenCalledWith(command, expect.any(Array), expect.any(Object));
    },
  );

  it.each(["#!/bin/sh\nexit 0\n", "not an executable image\n"])(
    "rejects an unrecognized configured launcher before it can execute (%j)",
    async (contents) => {
      await fs.writeFile(command, contents);
      await expectRejected(startOptions());
    },
  );

  it("revalidates launcher bytes after asynchronous process cleanup", async () => {
    prepareRegistration.mockImplementationOnce(async () => {
      await fs.writeFile(command, "#!/bin/sh\nexit 0\n");
      return async () => {};
    });
    await expectRejected(startOptions());
  });

  it.each([
    ["script prefix", ["wrapper.js", "app-server"]],
    ["interpreter expression", ["-e", "process.exit(0)", "app-server"]],
    ["shell prefix", ["-c", "true", "wrapper", "app-server"]],
    ["second subcommand", ["app-server", "app-server"]],
    ["missing subcommand", ["--profile", "app-server"]],
    ["missing option value", ["app-server", "--listen"]],
    ["positional suffix", ["app-server", "wrapper.js"]],
    ["option terminator", ["app-server", "--", "wrapper.js"]],
  ])("rejects %s arguments before native spawn", async (_name, args) => {
    await expectRejected(startOptions({ args }));
  });

  it.each(["--analytics-default-enabled", "--stdio", "--strict-config"])(
    "accepts native %s and option values resembling subcommands or scripts",
    async (flag) => {
      const args = [
        "-p",
        "app-server",
        "-c",
        'developer_instructions="wrapper.js"',
        "--enable",
        "hooks",
        "--disable=code_mode",
        "app-server",
        flag,
        ...(flag === "--stdio" ? [] : ["--listen", "stdio://"]),
      ];
      await createStdioTransport(startOptions({ args }), {});
      expect(spawnMock).toHaveBeenCalledWith(command, args, expect.any(Object));
    },
  );

  it("preserves an unprotected custom wrapper endpoint", async () => {
    const wrapper = path.join(workspace, "wrapper");
    await fs.writeFile(wrapper, "#!/bin/sh\nexit 0\n");
    const args = ["wrapper.js", "app-server"];
    await createStdioTransport(
      startOptions({ command: wrapper, args, protectedLaunchRoots: undefined }),
      {},
    );
    expect(spawnMock).toHaveBeenCalledWith(wrapper, args, expect.any(Object));
  });

  it("separates client cache identity across protection and writable-root changes", () => {
    const baseline = codexAppServerStartOptionsKey(startOptions());
    const bound = path.join(root, "bound");
    const expanded = startOptions({ protectedLaunchRoots: [workspace, bound] });
    expect(codexAppServerStartOptionsKey(expanded)).not.toBe(baseline);
    expect(
      codexAppServerStartOptionsKey(startOptions({ protectedLaunchRoots: undefined })),
    ).not.toBe(baseline);
    expect(
      codexAppServerStartOptionsKey(startOptions({ protectedLaunchRoots: [bound, workspace] })),
    ).toBe(codexAppServerStartOptionsKey(expanded));
  });
});
