// Completion write-state tests cover shell completion state file writes.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withEnvAsync } from "../test-utils/env.js";
import {
  COMPLETION_SHELLS,
  resolveCompletionCachePath,
  resolveCompletionProfilePath,
  type CompletionShell,
} from "./completion-runtime.js";

type PublishOutputFileAtomically =
  typeof import("./output-file.runtime.js").publishOutputFileAtomically;

const outputFileMocks = vi.hoisted(() => ({
  publishOutputFileAtomically: vi.fn<PublishOutputFileAtomically>(),
}));
const stderrWrites = vi.hoisted(() => vi.fn());
const getCoreCliCommandNamesMock = vi.hoisted(() => vi.fn(() => []));
const registerCoreCliByNameMock = vi.hoisted(() => vi.fn());
const getProgramContextMock = vi.hoisted(() => vi.fn(() => null));
const getSubCliEntriesMock = vi.hoisted(() =>
  vi.fn(() => [
    { name: "qa", description: "QA commands", hasSubcommands: true },
    { name: "completion", description: "Completion", hasSubcommands: false },
  ]),
);
const registerSubCliByNameMock = vi.hoisted(() =>
  vi.fn(async (program: Command, name: string) => {
    if (name === "qa") {
      throw new Error("qa scenario pack not found: qa/scenarios/index.yaml");
    }
    program.command(name);
    return true;
  }),
);
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("./output-file.runtime.js", async () => {
  const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
    "./output-file.runtime.js",
  );
  outputFileMocks.publishOutputFileAtomically.mockImplementation(
    actual.publishOutputFileAtomically,
  );
  return {
    ...actual,
    publishOutputFileAtomically: outputFileMocks.publishOutputFileAtomically,
  };
});

vi.mock("./program/command-registry-core.js", () => ({
  getCoreCliCommandNames: getCoreCliCommandNamesMock,
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/register.subclis-core.js", () => ({
  getSubCliEntries: getSubCliEntriesMock,
  registerSubCliByNameCore: registerSubCliByNameMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
}));

async function withIsolatedCompletionState(
  run: () => Promise<void>,
  env: Record<string, string | undefined> = {},
): Promise<void> {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));

  try {
    await withEnvAsync(
      {
        HOME: homeDir,
        USERPROFILE: homeDir,
        OPENCLAW_STATE_DIR: stateDir,
        XDG_CONFIG_HOME: undefined,
        ZDOTDIR: undefined,
        ...env,
      },
      run,
    );
  } finally {
    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  }
}

async function writeCompletionCacheForShell(shell: CompletionShell): Promise<string> {
  const { getCompletionScript, registerCompletionCli } = await import("./completion-cli.js");
  const program = new Command().name("openclaw");
  registerCompletionCli(program);
  await program.parseAsync(["completion", "--shell", shell, "--write-state"], {
    from: "user",
  });
  return getCompletionScript(shell, program);
}

function expectCompletionInstallationToSkipRegistration(): void {
  expect(getProgramContextMock).not.toHaveBeenCalled();
  expect(getCoreCliCommandNamesMock).not.toHaveBeenCalled();
  expect(registerCoreCliByNameMock).not.toHaveBeenCalled();
  expect(getSubCliEntriesMock).not.toHaveBeenCalled();
  expect(registerSubCliByNameMock).not.toHaveBeenCalled();
  expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
  expect(stderrWrites).not.toHaveBeenCalled();
}

describe("completion-cli write-state", () => {
  let restoreStderrWriteSpy: (() => void) | null = null;

  beforeEach(async () => {
    const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
      "./output-file.runtime.js",
    );
    outputFileMocks.publishOutputFileAtomically.mockReset();
    outputFileMocks.publishOutputFileAtomically.mockImplementation(
      actual.publishOutputFileAtomically,
    );
    stderrWrites.mockReset();
    getCoreCliCommandNamesMock.mockClear();
    registerCoreCliByNameMock.mockClear();
    getProgramContextMock.mockClear();
    getSubCliEntriesMock.mockClear();
    registerSubCliByNameMock.mockClear();
    registerPluginCliCommandsFromValidatedConfigMock.mockClear();
    const stderrWriteSpy = vi.spyOn(process.stderr, "write").mockImplementation(((
      chunk: string | Uint8Array,
    ) => {
      stderrWrites(chunk.toString());
      return true;
    }) as typeof process.stderr.write);
    restoreStderrWriteSpy = () => stderrWriteSpy.mockRestore();
  });

  afterEach(async () => {
    restoreStderrWriteSpy?.();
  });

  it.each(COMPLETION_SHELLS)(
    "publishes %s completion atomically without changing existing file or directory modes",
    async (shell) => {
      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath(shell, "openclaw");
        const cacheDir = path.dirname(cachePath);
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cachePath, "# previous completion\n", "utf8");
        if (process.platform !== "win32") {
          await fs.chmod(cacheDir, 0o750);
          await fs.chmod(cachePath, 0o640);
        }

        const expectedScript = await writeCompletionCacheForShell(shell);

        await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(expectedScript);
        expect(outputFileMocks.publishOutputFileAtomically).toHaveBeenCalledWith(
          expect.objectContaining({
            filePath: cachePath,
            tempPrefix: ".openclaw-completion-cache",
          }),
        );
        expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
        if (process.platform !== "win32") {
          expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o640);
          expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o750);
        }
      });
    },
  );

  it.each(COMPLETION_SHELLS)(
    "preserves the existing %s completion when staged publication fails",
    async (shell) => {
      const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
        "./output-file.runtime.js",
      );
      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath(shell, "openclaw");
        const cacheDir = path.dirname(cachePath);
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cachePath, "# previous completion\n", "utf8");
        if (process.platform !== "win32") {
          await fs.chmod(cacheDir, 0o750);
          await fs.chmod(cachePath, 0o640);
        }
        outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
          return await actual.publishOutputFileAtomically({
            ...params,
            writeTemp: async (tempPath) => {
              await params.writeTemp(tempPath);
              await fs.truncate(tempPath, 1);
              throw new Error("injected completion cache write failure");
            },
          });
        });

        await expect(writeCompletionCacheForShell(shell)).rejects.toThrow(
          "injected completion cache write failure",
        );

        await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# previous completion\n");
        expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
        if (process.platform !== "win32") {
          expect((await fs.stat(cachePath)).mode & 0o777).toBe(0o640);
          expect((await fs.stat(cacheDir)).mode & 0o777).toBe(0o750);
        }
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "replaces a completion cache symlink without overwriting its target",
    async () => {
      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        const cacheDir = path.dirname(cachePath);
        const protectedPath = path.join(path.dirname(cacheDir), "protected-script");
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(protectedPath, "# protected script\n", "utf8");
        await fs.symlink(protectedPath, cachePath);

        const expectedScript = await writeCompletionCacheForShell("zsh");

        expect((await fs.lstat(cachePath)).isSymbolicLink()).toBe(false);
        await expect(fs.readFile(cachePath, "utf8")).resolves.toBe(expectedScript);
        await expect(fs.readFile(protectedPath, "utf8")).resolves.toBe("# protected script\n");
        expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a planted temporary symlink without overwriting its target",
    async () => {
      const actual = await vi.importActual<typeof import("./output-file.runtime.js")>(
        "./output-file.runtime.js",
      );
      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        const cacheDir = path.dirname(cachePath);
        const protectedPath = path.join(path.dirname(cacheDir), "protected-script");
        await fs.mkdir(cacheDir, { recursive: true });
        await fs.writeFile(cachePath, "# previous completion\n", "utf8");
        await fs.writeFile(protectedPath, "# protected script\n", "utf8");
        outputFileMocks.publishOutputFileAtomically.mockImplementationOnce(async (params) => {
          return await actual.publishOutputFileAtomically({
            ...params,
            writeTemp: async (tempPath) => {
              await fs.symlink(protectedPath, tempPath);
              return await params.writeTemp(tempPath);
            },
          });
        });

        await expect(writeCompletionCacheForShell("zsh")).rejects.toThrow(/EEXIST/u);

        await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# previous completion\n");
        await expect(fs.readFile(protectedPath, "utf8")).resolves.toBe("# protected script\n");
        expect(await fs.readdir(cacheDir)).toEqual([path.basename(cachePath)]);
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects a symlinked completion cache directory without writing into its target",
    async () => {
      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath("zsh", "openclaw");
        const cacheDir = path.dirname(cachePath);
        const protectedDir = path.join(path.dirname(cacheDir), "protected-directory");
        await fs.mkdir(protectedDir, { recursive: true });
        await fs.symlink(protectedDir, cacheDir, "dir");

        await expect(writeCompletionCacheForShell("zsh")).rejects.toThrow(
          "directory component must be a directory",
        );

        expect((await fs.lstat(cacheDir)).isSymbolicLink()).toBe(true);
        expect(await fs.readdir(protectedDir)).toEqual([]);
      });
    },
  );

  it.each(COMPLETION_SHELLS)(
    "installs cached %s completion without registering commands or plugins",
    async (shell) => {
      const { registerCompletionCli } = await import("./completion-cli.js");

      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath(shell, "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "# cached completion\n", "utf8");

        const program = new Command().name("openclaw");
        registerCompletionCli(program);
        await program.parseAsync(["completion", "--shell", shell, "--install", "--yes"], {
          from: "user",
        });

        await expect(fs.readFile(resolveCompletionProfilePath(shell), "utf8")).resolves.toContain(
          cachePath,
        );
        await expect(fs.readFile(cachePath, "utf8")).resolves.toBe("# cached completion\n");
        expectCompletionInstallationToSkipRegistration();
      });
    },
  );

  it.each(COMPLETION_SHELLS)(
    "reports missing %s completion cache without registering commands or plugins",
    async (shell) => {
      const { registerCompletionCli } = await import("./completion-cli.js");

      await withIsolatedCompletionState(async () => {
        const cachePath = resolveCompletionCachePath(shell, "openclaw");
        const profilePath = resolveCompletionProfilePath(shell);
        const program = new Command().name("openclaw");
        registerCompletionCli(program);

        await expect(
          program.parseAsync(["completion", "--shell", shell, "--install", "--yes"], {
            from: "user",
          }),
        ).rejects.toThrow(
          `Completion cache not found at ${cachePath}. Run \`openclaw completion --write-state\` first.`,
        );

        await expect(fs.access(profilePath)).rejects.toThrow();
        expectCompletionInstallationToSkipRegistration();
      });
    },
  );

  it("detects the active shell for cached installation without registering commands", async () => {
    const { registerCompletionCli } = await import("./completion-cli.js");

    await withIsolatedCompletionState(
      async () => {
        const cachePath = resolveCompletionCachePath("fish", "openclaw");
        await fs.mkdir(path.dirname(cachePath), { recursive: true });
        await fs.writeFile(cachePath, "# fish completion\n", "utf8");

        const program = new Command().name("openclaw");
        registerCompletionCli(program);
        await program.parseAsync(["completion", "--install", "--yes"], { from: "user" });

        await expect(fs.readFile(resolveCompletionProfilePath("fish"), "utf8")).resolves.toContain(
          cachePath,
        );
        expectCompletionInstallationToSkipRegistration();
      },
      { SHELL: "/usr/bin/fish" },
    );
  });

  it("generates and installs completion after registering commands and plugins", async () => {
    const { registerCompletionCli } = await import("./completion-cli.js");

    await withIsolatedCompletionState(async () => {
      const program = new Command().name("openclaw");
      registerCompletionCli(program);
      await program.parseAsync(
        ["completion", "--shell", "zsh", "--write-state", "--install", "--yes"],
        { from: "user" },
      );

      const cachePath = resolveCompletionCachePath("zsh", "openclaw");
      await expect(fs.readFile(cachePath, "utf8")).resolves.toContain("#compdef openclaw");
      await expect(fs.readFile(resolveCompletionProfilePath("zsh"), "utf8")).resolves.toContain(
        cachePath,
      );
      expect(registerSubCliByNameMock.mock.calls).toEqual([
        [program, "qa", process.argv, { purpose: "completion" }],
      ]);
      expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledTimes(1);
      expect(stderrWrites.mock.calls).toEqual([
        [
          "[completion] skipping subcommand `qa` while building completion cache: qa scenario pack not found: qa/scenarios/index.yaml\n",
        ],
      ]);
    });
  });

  it("keeps completion cache generation alive when a subcli fails to register", async () => {
    const { registerCompletionCli } = await import("./completion-cli.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));

    try {
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        const program = new Command();
        program.name("openclaw");
        registerCompletionCli(program);

        await program.parseAsync(["completion", "--write-state"], { from: "user" });

        const cacheDir = path.join(stateDir, "completions");
        expect((await fs.readdir(cacheDir)).toSorted()).toEqual([
          "openclaw.bash",
          "openclaw.fish",
          "openclaw.ps1",
          "openclaw.zsh",
        ]);
        expect(registerSubCliByNameMock.mock.calls).toEqual([
          [program, "qa", process.argv, { purpose: "completion" }],
        ]);
        expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledTimes(1);
        expect(stderrWrites.mock.calls).toEqual([
          [
            "[completion] skipping subcommand `qa` while building completion cache: qa scenario pack not found: qa/scenarios/index.yaml\n",
          ],
        ]);
      });
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("structures completion registration warnings for JSON console output", async () => {
    const [{ registerCompletionCli }, logging] = await Promise.all([
      import("./completion-cli.js"),
      import("../logging.js"),
    ]);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-json-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-json-"));

    try {
      logging.setLoggerOverride({ level: "silent", consoleLevel: "info", consoleStyle: "json" });
      await withEnvAsync({ HOME: homeDir, OPENCLAW_STATE_DIR: stateDir }, async () => {
        const program = new Command();
        program.name("openclaw");
        registerCompletionCli(program);

        await program.parseAsync(["completion", "--write-state"], { from: "user" });

        expect(stderrWrites).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(stderrWrites.mock.calls[0]?.[0]))).toMatchObject({
          level: "warn",
          message: expect.stringContaining("skipping subcommand `qa`"),
        });
      });
    } finally {
      logging.resetLogger();
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });

  it("can skip plugin command registration for update-triggered cache writes", async () => {
    const [{ COMPLETION_SKIP_PLUGIN_COMMANDS_ENV }, { registerCompletionCli }] = await Promise.all([
      import("./completion-runtime.js"),
      import("./completion-cli.js"),
    ]);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));

    try {
      await withEnvAsync(
        {
          HOME: homeDir,
          OPENCLAW_STATE_DIR: stateDir,
          [COMPLETION_SKIP_PLUGIN_COMMANDS_ENV]: "1",
        },
        async () => {
          const program = new Command();
          program.name("openclaw");
          registerCompletionCli(program);

          await program.parseAsync(["completion", "--write-state"], { from: "user" });

          expect(registerSubCliByNameMock.mock.calls).toEqual([
            [program, "qa", process.argv, { purpose: "completion" }],
          ]);
          expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
          expect((await fs.readdir(path.join(stateDir, "completions"))).toSorted()).toEqual([
            "openclaw.bash",
            "openclaw.fish",
            "openclaw.ps1",
            "openclaw.zsh",
          ]);
        },
      );
    } finally {
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
