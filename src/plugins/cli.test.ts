import { Command } from "commander";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/config.js";

const mocks = vi.hoisted(() => ({
  memoryRegister: vi.fn(),
  otherRegister: vi.fn(),
  memoryListAction: vi.fn(),
  loadOpenClawPluginCliRegistry: vi.fn(),
  loadOpenClawPlugins: vi.fn(),
  resolveManifestActivationPluginIds: vi.fn(),
  applyPluginAutoEnable: vi.fn(),
  loadConfig: vi.fn(),
  readConfigFileSnapshot: vi.fn(),
}));

vi.mock("./loader.js", () => ({
  loadOpenClawPluginCliRegistry: (...args: unknown[]) =>
    mocks.loadOpenClawPluginCliRegistry(...args),
  loadOpenClawPlugins: (...args: unknown[]) => mocks.loadOpenClawPlugins(...args),
}));

vi.mock("./activation-planner.js", () => ({
  resolveManifestActivationPluginIds: (...args: unknown[]) =>
    mocks.resolveManifestActivationPluginIds(...args),
}));

vi.mock("../config/plugin-auto-enable.js", () => ({
  applyPluginAutoEnable: (...args: unknown[]) => mocks.applyPluginAutoEnable(...args),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  loadConfig: (...args: unknown[]) => mocks.loadConfig(...args),
  readConfigFileSnapshot: (...args: unknown[]) => mocks.readConfigFileSnapshot(...args),
}));

let getPluginCliCommandDescriptors: typeof import("./cli.js").getPluginCliCommandDescriptors;
let loadValidatedConfigForPluginRegistration: typeof import("./cli.js").loadValidatedConfigForPluginRegistration;
let registerPluginCliCommands: typeof import("./cli.js").registerPluginCliCommands;
let registerPluginCliCommandsFromValidatedConfig: typeof import("./cli.js").registerPluginCliCommandsFromValidatedConfig;

function createProgram(existingCommandName?: string) {
  const program = new Command();
  if (existingCommandName) {
    program.command(existingCommandName);
  }
  return program;
}

function createCliRegistry(params?: {
  memoryCommands?: string[];
  memoryDescriptors?: Array<{
    name: string;
    description: string;
    hasSubcommands: boolean;
  }>;
}) {
  return {
    cliRegistrars: [
      {
        pluginId: "memory-core",
        register: mocks.memoryRegister,
        commands: params?.memoryCommands ?? ["memory"],
        descriptors: params?.memoryDescriptors ?? [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
        source: "bundled",
      },
      {
        pluginId: "other",
        register: mocks.otherRegister,
        commands: ["other"],
        descriptors: [],
        source: "bundled",
      },
    ],
  };
}

function createAutoEnabledCliFixture() {
  const rawConfig = {
    plugins: {},
    channels: { demo: { enabled: true } },
  } as OpenClawConfig;
  const autoEnabledConfig = {
    ...rawConfig,
    plugins: {
      entries: {
        demo: { enabled: true },
      },
    },
  } as OpenClawConfig;
  return { rawConfig, autoEnabledConfig };
}

function expectAutoEnabledCliLoad(params: {
  rawConfig: OpenClawConfig;
  autoEnabledConfig: OpenClawConfig;
  autoEnabledReasons?: Record<string, string[]>;
}) {
  expect(mocks.applyPluginAutoEnable).toHaveBeenCalledWith({
    config: params.rawConfig,
    env: process.env,
  });
  expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
    expect.objectContaining({
      config: params.autoEnabledConfig,
      activationSourceConfig: params.rawConfig,
      autoEnabledReasons: params.autoEnabledReasons ?? {},
    }),
  );
}

describe("registerPluginCliCommands", () => {
  beforeAll(async () => {
    ({
      getPluginCliCommandDescriptors,
      loadValidatedConfigForPluginRegistration,
      registerPluginCliCommands,
      registerPluginCliCommandsFromValidatedConfig,
    } = await import("./cli.js"));
  });

  beforeEach(() => {
    mocks.memoryRegister.mockReset();
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      const memory = program.command("memory").description("Memory commands");
      memory.command("list").action(mocks.memoryListAction);
    });
    mocks.otherRegister.mockReset();
    mocks.otherRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("other").description("Other commands");
    });
    mocks.memoryListAction.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockReset();
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue(createCliRegistry());
    mocks.loadOpenClawPlugins.mockReset();
    mocks.loadOpenClawPlugins.mockReturnValue({
      ...createCliRegistry(),
      diagnostics: [],
    });
    mocks.resolveManifestActivationPluginIds.mockReset();
    mocks.resolveManifestActivationPluginIds.mockReturnValue([]);
    mocks.applyPluginAutoEnable.mockReset();
    mocks.applyPluginAutoEnable.mockImplementation(({ config }) => ({
      config,
      changes: [],
      autoEnabledReasons: {},
    }));
    mocks.loadConfig.mockReset();
    mocks.loadConfig.mockReturnValue({} as OpenClawConfig);
    mocks.readConfigFileSnapshot.mockReset();
    mocks.readConfigFileSnapshot.mockResolvedValue({
      valid: true,
      config: {},
    });
  });

  it("skips plugin CLI registrars when commands already exist", async () => {
    const program = createProgram("memory");

    await registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);
  });

  it("forwards an explicit env to plugin loading", async () => {
    const env = { OPENCLAW_HOME: "/srv/openclaw-home" } as NodeJS.ProcessEnv;

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, env);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        env,
      }),
    );
  });

  it("injects gateway-backed node runtime into plugin CLI commands", async () => {
    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeOptions: {
          nodes: {
            list: expect.any(Function),
            invoke: expect.any(Function),
          },
        },
      }),
    );
  });

  it("reuses loaded plugin CLI entries on repeat calls for the same program", async () => {
    const program = createProgram();

    await registerPluginCliCommands(program, {} as OpenClawConfig);
    await registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(1);
  });

  it("reloads plugin CLI entries when the requested primary command changes", async () => {
    const program = createProgram();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      primary: "memory",
    });
    await registerPluginCliCommands(program, {} as OpenClawConfig);

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledTimes(2);
  });

  it("loads plugin CLI commands from the auto-enabled config snapshot", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });

    await registerPluginCliCommands(createProgram(), rawConfig);

    expectAutoEnabledCliLoad({
      rawConfig,
      autoEnabledConfig,
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    expect(mocks.memoryRegister).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
      }),
    );
  });

  it("loads root-help descriptors through the dedicated non-activating CLI collector", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.loadOpenClawPluginCliRegistry.mockResolvedValue({
      cliRegistrars: [
        {
          pluginId: "matrix",
          register: vi.fn(),
          commands: ["matrix"],
          descriptors: [
            {
              name: "matrix",
              description: "Matrix channel utilities",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
        {
          pluginId: "duplicate-matrix",
          register: vi.fn(),
          commands: ["matrix"],
          descriptors: [
            {
              name: "matrix",
              description: "Duplicate Matrix channel utilities",
              hasSubcommands: true,
            },
          ],
          source: "bundled",
        },
      ],
    });

    await expect(getPluginCliCommandDescriptors(rawConfig)).resolves.toEqual([
      {
        name: "matrix",
        description: "Matrix channel utilities",
        hasSubcommands: true,
      },
    ]);
    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
      }),
    );
  });

  it("keeps runtime CLI command registration on the full plugin loader for legacy channel plugins", async () => {
    const { rawConfig, autoEnabledConfig } = createAutoEnabledCliFixture();
    mocks.applyPluginAutoEnable.mockReturnValue({
      config: autoEnabledConfig,
      changes: [],
      autoEnabledReasons: {
        demo: ["demo configured"],
      },
    });
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["legacy-channel"],
        memoryDescriptors: [
          {
            name: "legacy-channel",
            description: "Legacy channel commands",
            hasSubcommands: true,
          },
        ],
      }),
    );

    await registerPluginCliCommands(createProgram(), rawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        config: autoEnabledConfig,
        activationSourceConfig: rawConfig,
        autoEnabledReasons: {
          demo: ["demo configured"],
        },
        activate: false,
        cache: false,
      }),
    );
    expect(mocks.loadOpenClawPluginCliRegistry).not.toHaveBeenCalled();
  });

  it("lazy-registers descriptor-backed plugin commands on first invocation", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(program.commands.map((command) => command.name())).toEqual(["memory", "other"]);
    expect(mocks.memoryRegister).not.toHaveBeenCalled();
    expect(mocks.otherRegister).toHaveBeenCalledTimes(1);

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("falls back to eager registration when descriptors do not cover every command root", async () => {
    mocks.loadOpenClawPlugins.mockReturnValue(
      createCliRegistry({
        memoryCommands: ["memory", "memory-admin"],
        memoryDescriptors: [
          {
            name: "memory",
            description: "Memory commands",
            hasSubcommands: true,
          },
        ],
      }),
    );
    mocks.memoryRegister.mockImplementation(({ program }: { program: Command }) => {
      program.command("memory");
      program.command("memory-admin");
    });

    await registerPluginCliCommands(createProgram(), {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
    });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
  });

  it("registers a selected plugin primary eagerly during lazy startup", async () => {
    const program = createProgram();
    program.exitOverride();
    mocks.resolveManifestActivationPluginIds.mockReturnValue(["memory-core"]);

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(program.commands.filter((command) => command.name() === "memory")).toHaveLength(1);
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-core"],
      }),
    );

    await program.parseAsync(["memory", "list"], { from: "user" });

    expect(mocks.memoryRegister).toHaveBeenCalledTimes(1);
    expect(mocks.memoryListAction).toHaveBeenCalledTimes(1);
  });

  it("scopes full CLI loading through CLI metadata when manifest planning finds no plugin match", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "memory",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).toHaveBeenCalledWith(
      expect.objectContaining({
        onlyPluginIds: ["memory-core"],
      }),
    );
  });

  it("skips full plugin runtime loading when no metadata owns the requested primary", async () => {
    const program = createProgram();
    program.exitOverride();

    await registerPluginCliCommands(program, {} as OpenClawConfig, undefined, undefined, {
      mode: "lazy",
      primary: "missing-command",
    });

    expect(mocks.loadOpenClawPluginCliRegistry).toHaveBeenCalled();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
    expect(program.commands.map((command) => command.name())).not.toContain("missing-command");
  });

  it("returns null for validated plugin CLI config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: { plugins: { load: { paths: ["/tmp/evil"] } } },
    });

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBeNull();
    expect(mocks.loadConfig).not.toHaveBeenCalled();
  });

  it("loads validated plugin CLI config when the snapshot is valid", async () => {
    const loadedConfig = { plugins: { enabled: true } } as OpenClawConfig;
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: true,
      config: loadedConfig,
    });
    mocks.loadConfig.mockReturnValueOnce(loadedConfig);

    await expect(loadValidatedConfigForPluginRegistration()).resolves.toBe(loadedConfig);
    expect(mocks.loadConfig).toHaveBeenCalledTimes(1);
  });

  it("skips plugin CLI registration from validated config when the snapshot is invalid", async () => {
    mocks.readConfigFileSnapshot.mockResolvedValueOnce({
      valid: false,
      config: {},
    });

    await expect(registerPluginCliCommandsFromValidatedConfig(createProgram())).resolves.toBeNull();
    expect(mocks.loadOpenClawPlugins).not.toHaveBeenCalled();
  });
});
