import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { registerWikiCli } from "./cli.js";
import {
  resolveMemoryWikiAgentConfig,
  type MemoryWikiPluginConfig,
  type ResolvedMemoryWikiConfig,
} from "./config.js";
import { createMemoryWikiTestHarness } from "./test-helpers.js";

const AGENT_SCOPED_WIKI_COMMANDS = [
  { label: "status", path: ["status"], args: ["status"] },
  { label: "doctor", path: ["doctor"], args: ["doctor"] },
  { label: "init", path: ["init"], args: ["init"] },
  { label: "compile", path: ["compile"], args: ["compile"] },
  { label: "lint", path: ["lint"], args: ["lint"] },
  { label: "ingest", path: ["ingest"], args: ["ingest", "note.md"] },
  { label: "okf import", path: ["okf", "import"], args: ["okf", "import", "bundle"] },
  { label: "search", path: ["search"], args: ["search", "query"] },
  { label: "get", path: ["get"], args: ["get", "entity.alpha"] },
  {
    label: "apply synthesis",
    path: ["apply", "synthesis"],
    args: ["apply", "synthesis", "Summary", "--body", "Body", "--source-id", "source.alpha"],
  },
  {
    label: "apply metadata",
    path: ["apply", "metadata"],
    args: ["apply", "metadata", "entity.alpha"],
  },
  { label: "bridge import", path: ["bridge", "import"], args: ["bridge", "import"] },
  {
    label: "chatgpt import",
    path: ["chatgpt", "import"],
    args: ["chatgpt", "import", "--export", "export"],
  },
  {
    label: "chatgpt rollback",
    path: ["chatgpt", "rollback"],
    args: ["chatgpt", "rollback", "run-id"],
  },
] as const;

const { createVault } = createMemoryWikiTestHarness();
let suiteRoot = "";
let caseIndex = 0;
let stdoutWriteMock: ReturnType<typeof vi.fn>;

describe("memory-wiki agent-scoped cli", () => {
  beforeAll(async () => {
    suiteRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-wiki-cli-agent-suite-"));
  });

  afterAll(async () => {
    if (suiteRoot) {
      await fs.rm(suiteRoot, { recursive: true, force: true });
    }
  });

  beforeEach(() => {
    stdoutWriteMock = vi.fn(() => true);
    vi.spyOn(process.stdout, "write").mockImplementation(
      stdoutWriteMock as unknown as typeof process.stdout.write,
    );
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function createCliVault(options?: { config?: MemoryWikiPluginConfig }) {
    return createVault({
      prefix: "memory-wiki-cli-agent-",
      rootDir: path.join(suiteRoot, `case-${caseIndex++}`),
      config: options?.config,
    });
  }

  function stubWikiCommandAction(program: Command, commandPath: readonly string[]) {
    let command = program.commands.find((candidate) => candidate.name() === "wiki");
    for (const name of commandPath) {
      command = command?.commands.find((candidate) => candidate.name() === name);
    }
    expect(command, `wiki ${commandPath.join(" ")} command`).toBeDefined();
    command!.action(() => {});
    return command!;
  }

  function createAgentSelectionProgram(params: {
    config: ResolvedMemoryWikiConfig;
    appConfig: { agents: { entries: Record<string, { default?: boolean }> } };
    commandPath: readonly string[];
  }) {
    const resolveConfig = vi.fn((agentId?: string) =>
      resolveMemoryWikiAgentConfig({
        config: params.config,
        appConfig: params.appConfig,
        ...(agentId ? { agentId } : {}),
      }),
    );
    const program = new Command();
    program.name("test").enablePositionalOptions().exitOverride();
    program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
    registerWikiCli(program, {
      config: params.config,
      getAppConfig: () => params.appConfig,
      resolveConfig,
    });
    const command = stubWikiCommandAction(program, params.commandPath);
    return { command, program, resolveConfig };
  }

  it.each(AGENT_SCOPED_WIKI_COMMANDS)(
    "accepts command-local --agent for wiki $label",
    async ({ path: commandPath, args }) => {
      const { rootDir, config } = await createCliVault({
        config: { vault: { scope: "agent" } },
      });
      const appConfig = {
        agents: { entries: { support: { default: true }, marketing: {} } },
      };
      const { command, program, resolveConfig } = createAgentSelectionProgram({
        config,
        appConfig,
        commandPath,
      });

      await program.parseAsync(["wiki", ...args, "--agent", "marketing"], { from: "user" });

      expect(command.helpInformation()).toContain("--agent <id>");
      expect(resolveConfig).toHaveBeenCalledWith("marketing", appConfig);
      expect(resolveConfig.mock.results[0]?.value.vault.path).toBe(path.join(rootDir, "marketing"));
    },
  );

  it.each(AGENT_SCOPED_WIKI_COMMANDS)(
    "uses the configured default agent for wiki $label",
    async ({ path: commandPath, args }) => {
      const { rootDir, config } = await createCliVault({
        config: { vault: { scope: "agent" } },
      });
      const appConfig = {
        agents: { entries: { support: { default: true }, marketing: {} } },
      };
      const { program, resolveConfig } = createAgentSelectionProgram({
        config,
        appConfig,
        commandPath,
      });

      await program.parseAsync(["wiki", ...args], { from: "user" });

      expect(resolveConfig).toHaveBeenCalledWith("support", appConfig);
      expect(resolveConfig.mock.results[0]?.value.vault.path).toBe(path.join(rootDir, "support"));
    },
  );

  it.each([
    { commandPath: ["search"], args: ["search", "query"] },
    { commandPath: ["get"], args: ["get", "entity.alpha"] },
  ])("keeps global-vault $commandPath scoped to the configured default agent", async (testCase) => {
    const { config } = await createCliVault();
    const appConfig = {
      agents: { entries: { support: { default: true }, marketing: {} } },
    };
    const { program, resolveConfig } = createAgentSelectionProgram({
      config,
      appConfig,
      commandPath: testCase.commandPath,
    });

    await program.parseAsync(["wiki", ...testCase.args], { from: "user" });

    expect(resolveConfig).toHaveBeenCalledWith("support", appConfig);
  });

  it.each(AGENT_SCOPED_WIKI_COMMANDS)(
    "gives actionable missing-agent guidance for wiki $label",
    async ({ path: commandPath, args }) => {
      const { config } = await createCliVault({
        config: { vault: { scope: "agent" } },
      });
      const appConfig = { agents: { entries: {} } };
      const { program, resolveConfig } = createAgentSelectionProgram({
        config,
        appConfig,
        commandPath,
      });

      await expect(program.parseAsync(["wiki", ...args], { from: "user" })).rejects.toThrow(
        "No default memory-wiki agent is configured. Pass --agent <id>, or add an agent with `openclaw agents add`.",
      );
      expect(resolveConfig).not.toHaveBeenCalled();
    },
  );

  it("runs wiki doctor against explicit and default agent-scoped vaults", async () => {
    const { rootDir, config } = await createCliVault({
      config: { vault: { scope: "agent" } },
    });
    const appConfig = {
      agents: { entries: { support: { default: true }, marketing: {} } },
    };
    const run = async (args: string[]) => {
      stdoutWriteMock.mockClear();
      const program = new Command();
      program.name("test").enablePositionalOptions();
      registerWikiCli(program, { config, getAppConfig: () => appConfig });
      await program.parseAsync(["wiki", ...args], { from: "user" });
      return stdoutWriteMock.mock.calls.map(([chunk]) => String(chunk)).join("");
    };

    await run(["init", "--agent", "marketing"]);
    const explicitOutput = await run(["doctor", "--agent", "marketing"]);
    await run(["init"]);
    const defaultOutput = await run(["doctor"]);

    expect(explicitOutput).toContain("Wiki doctor: healthy");
    expect(explicitOutput).toContain("Vault scope: agent (marketing)");
    expect(explicitOutput).toContain(path.join(rootDir, "marketing"));
    expect(defaultOutput).toContain("Wiki doctor: healthy");
    expect(defaultOutput).toContain("Vault scope: agent (support)");
    expect(defaultOutput).toContain(path.join(rootDir, "support"));
  });

  it("does not require an agent to probe Obsidian CLI availability", async () => {
    const { config } = await createCliVault({ config: { vault: { scope: "agent" } } });
    const appConfig = { agents: { entries: {} } };
    const { program, resolveConfig } = createAgentSelectionProgram({
      config,
      appConfig,
      commandPath: ["obsidian", "status"],
    });

    await expect(
      program.parseAsync(["wiki", "obsidian", "status"], { from: "user" }),
    ).resolves.toBeDefined();
    expect(resolveConfig).not.toHaveBeenCalled();
  });
});
