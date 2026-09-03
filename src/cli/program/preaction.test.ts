// Preaction tests cover CLI preaction hooks and command context setup.
import { Command } from "commander";
import { repoInstallSpec } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { loggingState } from "../../logging/state.js";
import { isConfigSetJsonParseOnly } from "../config-output-mode.js";
import { setCommandJsonMode } from "./json-mode.js";
import { applyParentDefaultHelpAction } from "./parent-default-help.js";
import {
  COLD_READ_COMMAND_PATHS,
  registerColdReadCommandFixtures,
} from "./preaction.test-helpers.js";

const DISCORD_REPO_INSTALL_SPEC = repoInstallSpec("discord");

const setVerboseMock = vi.fn();
const emitCliBannerMock = vi.fn();
type EnsureConfigReadyOptions = {
  allowInvalid?: boolean;
  beforeStateMigrations?: () => Promise<boolean>;
  commandPath?: string[];
  requireConfig?: boolean;
  skipPristineCoreStateMigrations?: boolean;
  skipPristineStartupStateMigrations?: boolean;
};
const ensureConfigReadyMock = vi.fn<(_opts: EnsureConfigReadyOptions) => Promise<void>>(
  async () => {},
);
const ensurePluginRegistryLoadedMock = vi.fn();
const routeLogsToStderrMock = vi.fn();
const prepareGatewayRunBootstrapMock = vi.fn(async () => true);
const recheckGatewayRunBootstrapMock = vi.fn(async () => true);
const reloadTrustedGatewayRunEnvironmentMock = vi.fn(async () => true);
const wasPreparedGatewayRunCoreStatePristineMock = vi.fn(() => true);
const wasPreparedGatewayRunStatePristineMock = vi.fn(() => true);

const runtimeMock = {
  log: vi.fn(),
  error: vi.fn(),
  writeStdout: vi.fn(),
  writeJson: vi.fn(),
  exit: vi.fn(),
};

vi.mock("../../globals.js", () => ({
  setVerbose: setVerboseMock,
}));

vi.mock("../../runtime.js", () => ({
  defaultRuntime: runtimeMock,
}));

vi.mock("../banner.js", () => ({
  emitCliBanner: emitCliBannerMock,
}));

vi.mock("../../logging/console.js", () => ({
  routeLogsToStderr: routeLogsToStderrMock,
}));

vi.mock("../cli-name.js", () => ({
  resolveCliName: () => "openclaw",
}));

vi.mock("./config-guard.js", () => ({
  ensureConfigReady: ensureConfigReadyMock,
}));

vi.mock("../plugin-registry.js", () => ({
  ensurePluginRegistryLoaded: ensurePluginRegistryLoadedMock,
}));

vi.mock("../gateway-cli/pre-bootstrap.js", () => ({
  prepareGatewayRunBootstrap: prepareGatewayRunBootstrapMock,
  recheckGatewayRunBootstrap: recheckGatewayRunBootstrapMock,
  reloadTrustedGatewayRunEnvironment: reloadTrustedGatewayRunEnvironmentMock,
  wasPreparedGatewayRunCoreStatePristine: wasPreparedGatewayRunCoreStatePristineMock,
  wasPreparedGatewayRunStatePristine: wasPreparedGatewayRunStatePristineMock,
}));

let registerPreActionHooks: typeof import("./preaction.js").registerPreActionHooks;
let originalProcessArgv: string[];
let originalProcessTitle: string;
let originalProcessTitleDescriptor: PropertyDescriptor | undefined;
let observedProcessTitle: string;
let originalNodeNoWarnings: string | undefined;
let originalHideBanner: string | undefined;
let originalForceStderr: boolean;
let originalEarlyConsoleRoutingRestore: boolean | null;
let observedMachineOutputStdoutIsTTY: boolean | undefined;

beforeAll(async () => {
  ({ registerPreActionHooks } = await import("./preaction.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  originalProcessArgv = [...process.argv];
  originalProcessTitle = process.title;
  originalProcessTitleDescriptor = Object.getOwnPropertyDescriptor(process, "title");
  observedProcessTitle = originalProcessTitle;
  originalNodeNoWarnings = process.env.NODE_NO_WARNINGS;
  originalHideBanner = process.env.OPENCLAW_HIDE_BANNER;
  originalForceStderr = loggingState.forceConsoleToStderr;
  originalEarlyConsoleRoutingRestore = loggingState.earlyConsoleRoutingRestore;
  observedMachineOutputStdoutIsTTY = undefined;
  // Worker-thread Vitest runs do not reliably mutate the real process title,
  // so capture writes at the property boundary instead.
  Object.defineProperty(process, "title", {
    configurable: true,
    enumerable: originalProcessTitleDescriptor?.enumerable ?? true,
    get: () => observedProcessTitle,
    set: (value: string) => {
      observedProcessTitle = value;
    },
  });
  loggingState.forceConsoleToStderr = false;
  loggingState.earlyConsoleRoutingRestore = null;
  delete process.env.NODE_NO_WARNINGS;
  delete process.env.OPENCLAW_HIDE_BANNER;
});

afterEach(() => {
  process.argv = originalProcessArgv;
  if (originalProcessTitleDescriptor && "value" in originalProcessTitleDescriptor) {
    Object.defineProperty(process, "title", {
      ...originalProcessTitleDescriptor,
      value: originalProcessTitle,
    });
  } else if (originalProcessTitleDescriptor) {
    Object.defineProperty(process, "title", originalProcessTitleDescriptor);
  } else {
    process.title = originalProcessTitle;
  }
  loggingState.forceConsoleToStderr = originalForceStderr;
  loggingState.earlyConsoleRoutingRestore = originalEarlyConsoleRoutingRestore;
  if (originalNodeNoWarnings === undefined) {
    delete process.env.NODE_NO_WARNINGS;
  } else {
    process.env.NODE_NO_WARNINGS = originalNodeNoWarnings;
  }
  if (originalHideBanner === undefined) {
    delete process.env.OPENCLAW_HIDE_BANNER;
  } else {
    process.env.OPENCLAW_HIDE_BANNER = originalHideBanner;
  }
});

describe("registerPreActionHooks", () => {
  let program: Command;
  let preActionHook:
    | ((thisCommand: Command, actionCommand: Command) => Promise<void> | void)
    | null = null;

  function buildProgram() {
    const programLocal = new Command().name("openclaw").enablePositionalOptions();
    const agent = programLocal
      .command("agent")
      .argument("[note]")
      .requiredOption("-m, --message <text>")
      .option("--agent <id>")
      .option("--local")
      .option("--json")
      .action(() => {});
    agent
      .command("exec")
      .argument("[message]")
      .option("--json")
      .action(() => {});
    programLocal
      .command("status")
      .option("--json")
      .action(() => {});
    const acp = programLocal
      .command("acp")
      .option("--token <token>")
      .option("--verbose")
      .action(() => {});
    acp
      .command("client")
      .option("--cwd <dir>")
      .action(() => {});
    programLocal
      .command("mcp")
      .command("serve")
      .action(() => {});
    const gateway = programLocal
      .command("gateway")
      .option("--port <port>")
      .option("--token <token>")
      .option("--allow-unconfigured")
      .option("--force")
      .option("--reset")
      .action(() => {});
    gateway
      .command("run")
      .option("--allow-unconfigured")
      .option("--force")
      .option("--reset")
      .action(() => {});
    gateway
      .command("call")
      .argument("<method>")
      .option("--json")
      .action(() => {});
    gateway
      .command("health")
      .option("--json")
      .action(() => {});
    for (const gatewayCommand of ["stability", "usage-cost"]) {
      gateway
        .command(gatewayCommand)
        .option("--json")
        .action(() => {});
    }
    programLocal
      .command("backup")
      .command("create")
      .option("--json")
      .action(() => {});
    programLocal
      .command("doctor")
      .option("--lint")
      .action(() => {});
    programLocal.command("completion").action(() => {});
    programLocal.command("secrets").action(() => {});
    const modelList = programLocal.command("models").command("aliases").command("list");
    modelList.option("--plain").action(() => {});
    const skills = programLocal.command("skills");
    skills.option("--json").action(() => {});
    for (const skillCommand of ["list", "check"]) {
      skills
        .command(skillCommand)
        .option("--json")
        .action(() => {});
    }
    registerColdReadCommandFixtures(programLocal, skills);
    for (const skillCommand of ["install", "verify"]) {
      skills
        .command(skillCommand)
        .argument("<skill-ref>")
        .option("--version <version>")
        .action(() => {});
    }
    programLocal
      .command("qa")
      .command("suite")
      .action(() => {});
    const agents = programLocal.command("agents");
    agents
      .command("list")
      .option("--json")
      .action(() => {});
    agents
      .command("bindings")
      .option("--json")
      .action(() => {});
    programLocal
      .command("approvals")
      .command("pending")
      .option("--json")
      .action(() => {});
    programLocal.command("configure").action(() => {});
    programLocal.command("onboard").action(() => {});
    const channels = programLocal.command("channels");
    channels.command("add").action(() => {});
    channels
      .command("send")
      .option("--json")
      .action(() => {});
    applyParentDefaultHelpAction(channels);
    programLocal
      .command("plugins")
      .command("install")
      .argument("<spec>")
      .option("--marketplace <marketplace>")
      .action(() => {});
    programLocal
      .command("update")
      .command("status")
      .option("--json")
      .action(() => {});
    programLocal
      .command("message")
      .command("send")
      .option("--json")
      .action(() => {});
    setCommandJsonMode(programLocal.command("machine"), "output", ({ argv, stdoutIsTTY }) => {
      observedMachineOutputStdoutIsTTY = stdoutIsTTY;
      return argv.includes("--machine-output");
    }).action(() => {});
    const config = programLocal.command("config");
    config.option("--section <section>");
    setCommandJsonMode(config.command("set"), "parse-only", ({ argv }) =>
      isConfigSetJsonParseOnly(argv),
    )
      .argument("<path>")
      .argument("<value>")
      .option("--json")
      .action(() => {});
    config.command("file").action(() => {});
    config
      .command("unset")
      .argument("<path>")
      .action(() => {});
    config
      .command("validate")
      .option("--json")
      .action(() => {});
    config.command("schema").action(() => {});
    registerPreActionHooks(programLocal, "9.9.9-test");
    return programLocal;
  }

  function resolveActionCommand(parseArgv: string[]): Command {
    let current = program;
    for (const segment of parseArgv) {
      const next = current.commands.find((command) => command.name() === segment);
      if (!next) {
        break;
      }
      current = next;
    }
    return current;
  }

  async function runPreAction(params: { parseArgv: string[]; processArgv?: string[] }) {
    process.argv = params.processArgv ?? [...params.parseArgv];
    const actionCommand = resolveActionCommand(params.parseArgv);
    if (!preActionHook) {
      throw new Error("missing preAction hook");
    }
    await preActionHook(program, actionCommand);
  }

  it("applies shared skip policy to routed reads on the Commander path", async () => {
    const processTitleSetSpy = vi.spyOn(process, "title", "set");
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--debug"],
    });

    expect(emitCliBannerMock).toHaveBeenCalledWith("9.9.9-test");
    expect(setVerboseMock).toHaveBeenCalledWith(true);
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(processTitleSetSpy).toHaveBeenCalledWith("openclaw-status");

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    processTitleSetSpy.mockRestore();
  });

  it.each([
    ["approvals", "pending"],
    ["skills"],
    ["skills", "list"],
    ["skills", "check"],
    ...COLD_READ_COMMAND_PATHS,
    ["agents", "bindings"],
    ["gateway", "stability"],
    ["gateway", "usage-cost"],
  ])("keeps the real Commander preAction cold for %s", async (...commandPath) => {
    await runPreAction({
      parseArgv: commandPath,
      processArgv: ["node", "openclaw", ...commandPath, "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("runs gateway pre-bootstrap before full-CLI gateway bootstrap", async () => {
    prepareGatewayRunBootstrapMock.mockResolvedValueOnce(false);
    const gatewayRunCommand = resolveActionCommand(["gateway", "run"]);
    gatewayRunCommand.setOptionValueWithSource("force", true, "cli");
    try {
      await runPreAction({
        parseArgv: ["gateway", "run"],
        processArgv: [
          "node",
          "openclaw",
          "--log-level",
          "debug",
          "gateway",
          "run",
          "--raw-stream-path",
          "--reset",
          "--force",
        ],
      });
    } finally {
      gatewayRunCommand.setOptionValueWithSource("force", false, "default");
    }

    expect(prepareGatewayRunBootstrapMock).toHaveBeenCalledWith({
      opts: { force: true, reset: false },
      runtime: runtimeMock,
    });
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("passes the gateway config recheck to the state migration boundary", async () => {
    await runPreAction({
      parseArgv: ["gateway", "run"],
      processArgv: ["node", "openclaw", "gateway", "run"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        beforeStateMigrations: expect.any(Function),
        commandPath: ["gateway", "run"],
        measure: expect.any(Function),
        skipPristineCoreStateMigrations: true,
        skipPristineStartupStateMigrations: true,
      }),
    );
    const beforeStateMigrations = ensureConfigReadyMock.mock.calls[0]?.[0]?.beforeStateMigrations;
    await beforeStateMigrations?.();
    expect(recheckGatewayRunBootstrapMock).toHaveBeenCalledWith({
      opts: { force: false, reset: false },
      runtime: runtimeMock,
    });
    expect(reloadTrustedGatewayRunEnvironmentMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
    });
  });

  it("passes --allow-unconfigured through as an invalid-config override", async () => {
    const gatewayRunCommand = resolveActionCommand(["gateway", "run"]);
    gatewayRunCommand.setOptionValueWithSource("allowUnconfigured", true, "cli");
    try {
      await runPreAction({
        parseArgv: ["gateway", "run"],
        processArgv: ["node", "openclaw", "gateway", "run", "--allow-unconfigured"],
      });
    } finally {
      gatewayRunCommand.setOptionValueWithSource("allowUnconfigured", false, "default");
    }

    expect(ensureConfigReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        allowInvalid: true,
        commandPath: ["gateway", "run"],
        measure: expect.any(Function),
      }),
    );
  });

  it("defers config bootstrap for update commands", async () => {
    await runPreAction({
      parseArgv: ["update"],
      processArgv: ["node", "openclaw", "update", "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["update", "status"],
      processArgv: ["node", "openclaw", "update", "status", "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("loads plugins for text local agent runs", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--local", "--message", "hi"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["agent"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
    });
  });

  it("loads plugins for json local agent runs", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--local", "--message", "hi", "--json"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["agent"],
      suppressDoctorStdout: true,
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "all",
    });
  });

  it("bypasses operator config and plugin startup for agent exec", async () => {
    await runPreAction({
      parseArgv: ["agent", "exec", "fix it"],
      processArgv: ["node", "openclaw", "agent", "--agent", "main", "exec", "fix it"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(routeLogsToStderrMock).toHaveBeenCalled();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
  });

  it("keeps setup alias and channels add manifest-first", async () => {
    await runPreAction({
      parseArgv: ["onboard"],
      processArgv: ["node", "openclaw", "onboard"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["onboard"],
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["channels", "add"],
      processArgv: ["node", "openclaw", "channels", "add"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["channels", "add"],
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("skips startup bootstrap for parent default help actions", async () => {
    await runPreAction({
      parseArgv: ["channels"],
      processArgv: ["node", "openclaw", "channels"],
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("lets configure own config validation and plugin loading", async () => {
    await runPreAction({
      parseArgv: ["configure"],
      processArgv: ["node", "openclaw", "configure"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("keeps private QA commands isolated from operator config bootstrap", async () => {
    await runPreAction({
      parseArgv: ["qa", "suite"],
      processArgv: ["node", "openclaw", "qa", "suite"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("lets bare config own config validation and plugin loading", async () => {
    await runPreAction({
      parseArgv: ["config"],
      processArgv: ["node", "openclaw", "config"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("lets guided config sections own config validation and plugin loading", async () => {
    await runPreAction({
      parseArgv: ["config"],
      processArgv: ["node", "openclaw", "config", "--section", "models"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("skips the config guard and plugin loading for doctor lint", async () => {
    await runPreAction({
      parseArgv: ["doctor"],
      processArgv: ["node", "openclaw", "doctor", "--lint"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("only allows invalid config for explicit official recovery reinstall requests", async () => {
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/discord"],
      processArgv: ["node", "openclaw", "plugins", "install", "@openclaw/discord"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/discord@2026.5.22"],
      processArgv: ["node", "openclaw", "plugins", "install", "@openclaw/discord@2026.5.22"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/brave-plugin"],
      processArgv: ["node", "openclaw", "plugins", "install", "@openclaw/brave-plugin"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/slack"],
      processArgv: ["node", "openclaw", "plugins", "install", "@openclaw/slack"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "alpha"],
      processArgv: ["node", "openclaw", "plugins", "install", "alpha"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", DISCORD_REPO_INSTALL_SPEC],
      processArgv: ["node", "openclaw", "plugins", "install", DISCORD_REPO_INSTALL_SPEC],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/discord", "--marketplace", "local/repo"],
      processArgv: [
        "node",
        "openclaw",
        "plugins",
        "install",
        "@openclaw/discord",
        "--marketplace",
        "local/repo",
      ],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["plugins", "install"],
    });
  });

  it("skips help/version preaction and respects banner opt-out", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "--version"],
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(setVerboseMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    process.env.OPENCLAW_HIDE_BANNER = "1";

    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status"],
    });

    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("bootstraps when Commander consumed --help as a required option value", async () => {
    const parseProgram = buildProgram();
    process.argv = ["node", "openclaw", "agent", "--message", "--help", "--message", "hello"];

    await parseProgram.parseAsync(process.argv);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "version-pinned skill install",
      action: "install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version", "1.2.3"],
    },
    {
      name: "version-pinned skill verification",
      action: "verify",
      argv: ["node", "openclaw", "skills", "verify", "@owner/weather", "--version", "1.2.3"],
    },
    {
      name: "equals-form version-pinned skill install",
      action: "install",
      argv: ["node", "openclaw", "skills", "install", "@owner/weather", "--version=1.2.3"],
    },
    {
      name: "profiled version-pinned skill verification",
      action: "verify",
      argv: [
        "node",
        "openclaw",
        "--profile",
        "work",
        "skills",
        "verify",
        "@owner/weather",
        "--version",
        "1.2.3",
      ],
    },
  ])("runs the execution bootstrap for $name", async ({ action, argv }) => {
    await runPreAction({
      parseArgv: ["skills", action],
      processArgv: argv,
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runtime: runtimeMock,
        commandPath: ["skills", action],
        measure: expect.any(Function),
      }),
    );
  });

  it("applies --json stdout suppression only for explicit JSON output commands", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["update", "status", "--json"],
      processArgv: ["node", "openclaw", "update", "status", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "{bad", "--json"],
      processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "{bad", "--json"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["config", "set"],
    });
  });

  it("does not select JSON output when Commander consumed --json as an option value", async () => {
    const parseProgram = buildProgram();
    process.argv = ["node", "openclaw", "agent", "", "--message", "--json", "--message", "hello"];

    await parseProgram.parseAsync(process.argv);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("routes logs to stderr in --json mode so stdout stays clean", async () => {
    await runPreAction({
      parseArgv: ["channels", "send"],
      processArgv: ["node", "openclaw", "channels", "send", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // Early argv detection routes literal --json conservatively until Commander metadata resolves.
    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "local", "--json"],
      processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "local", "--json"],
    });

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
    expect(loggingState.forceConsoleToStderr).toBe(false);

    vi.clearAllMocks();

    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "local", "--dry-run", "--json"],
      processArgv: [
        "node",
        "openclaw",
        "config",
        "set",
        "gateway.auth.mode",
        "local",
        "--dry-run",
        "--json",
      ],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(loggingState.forceConsoleToStderr).toBe(true);

    vi.clearAllMocks();

    // non-json command should not route
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("routes logs when command-owned metadata selects machine output", async () => {
    const stdoutDescriptor = Object.getOwnPropertyDescriptor(process.stdout, "isTTY");
    Object.defineProperty(process.stdout, "isTTY", { configurable: true, value: undefined });
    try {
      await runPreAction({
        parseArgv: ["machine"],
        processArgv: ["node", "openclaw", "machine", "--machine-output"],
      });
    } finally {
      if (stdoutDescriptor) {
        Object.defineProperty(process.stdout, "isTTY", stdoutDescriptor);
      } else {
        Reflect.deleteProperty(process.stdout, "isTTY");
      }
    }

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(observedMachineOutputStdoutIsTTY).toBe(false);
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["machine"],
      suppressDoctorStdout: true,
    });
  });

  it("keeps plain model output clean throughout Commander startup", async () => {
    loggingState.forceConsoleToStderr = true;
    loggingState.earlyConsoleRoutingRestore = false;

    await runPreAction({
      parseArgv: ["models", "aliases", "list"],
      processArgv: ["node", "openclaw", "models", "aliases", "list", "--plain"],
    });

    expect(loggingState.forceConsoleToStderr).toBe(true);
    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(emitCliBannerMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["models", "aliases", "list"],
      suppressDoctorStdout: true,
    });
  });

  it("uses the Commander action path for protocol stdout ownership", async () => {
    await runPreAction({
      parseArgv: ["acp"],
      processArgv: ["node", "openclaw", "acp", "--token", "-secret"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["acp"],
      suppressDoctorStdout: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["acp", "client"],
      processArgv: ["node", "openclaw", "acp", "--verbose", "client"],
    });

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["acp", "client"],
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["mcp", "serve"],
      processArgv: ["node", "openclaw", "mcp", "serve"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["mcp", "serve"],
      suppressDoctorStdout: true,
    });
  });

  it("uses the Commander path past parent option values for gateway calls", async () => {
    const parseProgram = buildProgram();
    process.argv = ["node", "openclaw", "gateway", "--token", "secret", "call", "health", "--json"];

    await parseProgram.parseAsync(process.argv);

    const bootstrap = ensureConfigReadyMock.mock.calls.at(-1)?.[0];
    expect(bootstrap).toEqual({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["gateway", "call"],
      suppressDoctorStdout: true,
      validateConfigOnly: true,
    });
  });

  it("uses the shared skip policy for gateway health on the Commander path", async () => {
    const parseProgram = buildProgram();
    process.argv = ["node", "openclaw", "gateway", "--port", "19083", "health", "--json"];

    await parseProgram.parseAsync(process.argv);

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("does not preload plugins for agents list JSON output", async () => {
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("does not preload plugins for remote agent JSON output", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--message", "hi", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config and plugin bootstrap for remote agent text output", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--message", "hi"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it.each([
    ["default profile", ["node", "openclaw", "config", "file"]],
    ["named profile", ["node", "openclaw", "--profile", "work", "config", "file"]],
  ])("bypasses config guard for a %s config path query", async (_name, processArgv) => {
    await runPreAction({
      parseArgv: ["config", "file"],
      processArgv,
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "config", "validate"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate when root option values are present", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "--profile", "work", "config", "validate"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config schema", async () => {
    await runPreAction({
      parseArgv: ["config", "schema"],
      processArgv: ["node", "openclaw", "config", "schema"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("keeps config guard for config unset mutations", async () => {
    await runPreAction({
      parseArgv: ["config", "unset", "gateway.port"],
      processArgv: ["node", "openclaw", "config", "unset", "gateway.port"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      measure: expect.any(Function),
      commandPath: ["config", "unset"],
    });
  });

  it("bypasses config guard for backup create", async () => {
    await runPreAction({
      parseArgv: ["backup", "create"],
      processArgv: ["node", "openclaw", "backup", "create", "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for SQLite snapshot recovery commands", async () => {
    await runPreAction({
      parseArgv: ["backup", "sqlite", "restore"],
      processArgv: [
        "node",
        "openclaw",
        "backup",
        "sqlite",
        "restore",
        "/tmp/snapshot",
        "--target",
        "/tmp/restore.sqlite",
      ],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    let stderrDuringPluginLoad = false;
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      stderrDuringPluginLoad = loggingState.forceConsoleToStderr;
    });

    await runPreAction({
      parseArgv: ["channels", "send"],
      processArgv: ["node", "openclaw", "channels", "send", "--json"],
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({
      scope: "configured-channels",
    });
    expect(stderrDuringPluginLoad).toBe(true);
    // Flag must be restored after plugin loading completes
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not preload plugins or route logs to stderr for agents list without --json", async () => {
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  beforeAll(() => {
    program = buildProgram();
    const hooks = (
      program as unknown as {
        _lifeCycleHooks?: {
          preAction?: Array<(thisCommand: Command, actionCommand: Command) => Promise<void> | void>;
        };
      }
    )["_lifeCycleHooks"]?.preAction;
    preActionHook = hooks?.[0] ?? null;
  });
});
