import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
      throw new Error("qa scenario pack not found: qa/scenarios/index.md");
    }
    program.command(name);
    return true;
  }),
);
const registerPluginCliCommandsFromValidatedConfigMock = vi.hoisted(() => vi.fn(async () => null));

vi.mock("./program/command-registry-core.js", () => ({
  getCoreCliCommandNames: getCoreCliCommandNamesMock,
  registerCoreCliByName: registerCoreCliByNameMock,
}));

vi.mock("./program/program-context.js", () => ({
  getProgramContext: getProgramContextMock,
}));

vi.mock("./program/register.subclis-core.js", () => ({
  getSubCliEntries: getSubCliEntriesMock,
  registerSubCliByName: registerSubCliByNameMock,
}));

vi.mock("../plugins/cli.js", () => ({
  registerPluginCliCommandsFromValidatedConfig: registerPluginCliCommandsFromValidatedConfigMock,
}));

describe("completion-cli write-state", () => {
  const originalHome = process.env.HOME;
  const originalStateDir = process.env.OPENCLAW_STATE_DIR;
  let restoreStderrWriteSpy: (() => void) | null = null;

  beforeEach(() => {
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
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }
    if (originalStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = originalStateDir;
    }
  });

  it("keeps completion cache generation alive when a subcli fails to register", async () => {
    const { registerCompletionCli } = await import("./completion-cli.js");
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));

    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.HOME = homeDir;

    const program = new Command();
    program.name("openclaw");
    registerCompletionCli(program);

    await program.parseAsync(["completion", "--write-state"], { from: "user" });

    const cacheDir = path.join(stateDir, "completions");
    expect(await fs.readdir(cacheDir)).toEqual(
      expect.arrayContaining(["openclaw.bash", "openclaw.fish", "openclaw.ps1", "openclaw.zsh"]),
    );
    expect(registerSubCliByNameMock).toHaveBeenCalledWith(program, "qa");
    expect(registerPluginCliCommandsFromValidatedConfigMock).toHaveBeenCalledTimes(1);
    expect(stderrWrites).toHaveBeenCalledWith(
      expect.stringContaining("skipping subcommand `qa` while building completion cache"),
    );

    await fs.rm(stateDir, { recursive: true, force: true });
    await fs.rm(homeDir, { recursive: true, force: true });
  });

  it("can skip plugin command registration for update-triggered cache writes", async () => {
    const [{ COMPLETION_SKIP_PLUGIN_COMMANDS_ENV }, { registerCompletionCli }] = await Promise.all([
      import("./completion-runtime.js"),
      import("./completion-cli.js"),
    ]);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-state-"));
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-completion-home-"));

    process.env.OPENCLAW_STATE_DIR = stateDir;
    process.env.HOME = homeDir;
    process.env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV] = "1";

    try {
      const program = new Command();
      program.name("openclaw");
      registerCompletionCli(program);

      await program.parseAsync(["completion", "--write-state"], { from: "user" });

      expect(registerSubCliByNameMock).toHaveBeenCalledWith(program, "qa");
      expect(registerPluginCliCommandsFromValidatedConfigMock).not.toHaveBeenCalled();
      expect(await fs.readdir(path.join(stateDir, "completions"))).toEqual(
        expect.arrayContaining(["openclaw.bash", "openclaw.fish", "openclaw.ps1", "openclaw.zsh"]),
      );
    } finally {
      delete process.env[COMPLETION_SKIP_PLUGIN_COMMANDS_ENV];
      await fs.rm(stateDir, { recursive: true, force: true });
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
