import { Command } from "commander";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { repoInstallSpec } from "../../../test/helpers/bundled-plugin-paths.js";
import { loggingState } from "../../logging/state.js";
import { setCommandJsonMode } from "./json-mode.js";

const MATRIX_REPO_INSTALL_SPEC = repoInstallSpec("matrix");

const setVerboseMock = vi.fn();
const emitCliBannerMock = vi.fn();
const ensureConfigReadyMock = vi.fn(async () => {});
const ensurePluginRegistryLoadedMock = vi.fn();
const routeLogsToStderrMock = vi.fn();

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

let registerPreActionHooks: typeof import("./preaction.js").registerPreActionHooks;
let originalProcessArgv: string[];
let originalProcessTitle: string;
let originalProcessTitleDescriptor: PropertyDescriptor | undefined;
let observedProcessTitle: string;
let originalNodeNoWarnings: string | undefined;
let originalHideBanner: string | undefined;
let originalForceStderr: boolean;

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
    const program = new Command().name("openclaw");
    program
      .command("agent")
      .requiredOption("-m, --message <text>")
      .option("--local")
      .option("--json")
      .action(() => {});
    program
      .command("status")
      .option("--json")
      .action(() => {});
    program
      .command("backup")
      .command("create")
      .option("--json")
      .action(() => {});
    program.command("doctor").action(() => {});
    program.command("completion").action(() => {});
    program.command("secrets").action(() => {});
    program
      .command("agents")
      .command("list")
      .option("--json")
      .action(() => {});
    program.command("configure").action(() => {});
    program.command("onboard").action(() => {});
    const channels = program.command("channels");
    channels.command("add").action(() => {});
    program
      .command("plugins")
      .command("install")
      .argument("<spec>")
      .option("--marketplace <marketplace>")
      .action(() => {});
    program
      .command("update")
      .command("status")
      .option("--json")
      .action(() => {});
    program
      .command("message")
      .command("send")
      .option("--json")
      .action(() => {});
    const config = program.command("config");
    setCommandJsonMode(config.command("set"), "parse-only")
      .argument("<path>")
      .argument("<value>")
      .option("--json")
      .action(() => {});
    config
      .command("validate")
      .option("--json")
      .action(() => {});
    config.command("schema").action(() => {});
    registerPreActionHooks(program, "9.9.9-test");
    return program;
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

  it("handles debug mode and plugin-required command preaction", async () => {
    const processTitleSetSpy = vi.spyOn(process, "title", "set");
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--debug"],
    });

    expect(emitCliBannerMock).toHaveBeenCalledWith("9.9.9-test");
    expect(setVerboseMock).toHaveBeenCalledWith(true);
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["status"],
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
    expect(processTitleSetSpy).toHaveBeenCalledWith("openclaw-status");

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(setVerboseMock).toHaveBeenCalledWith(false);
    expect(process.env.NODE_NO_WARNINGS).toBe("1");
    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["agents", "list"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "all" });
    processTitleSetSpy.mockRestore();
  });

  it("loads plugins for local agent runs", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--local", "--message", "hi"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["agent", "hi"],
    });
    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalledWith({ scope: "all" });
  });

  it("keeps setup alias and channels add manifest-first", async () => {
    await runPreAction({
      parseArgv: ["onboard"],
      processArgv: ["node", "openclaw", "onboard"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
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
      commandPath: ["channels", "add"],
    });
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

  it("only allows invalid config for explicit Matrix reinstall requests", async () => {
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/matrix"],
      processArgv: ["node", "openclaw", "plugins", "install", "@openclaw/matrix"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
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
      commandPath: ["plugins", "install"],
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", MATRIX_REPO_INSTALL_SPEC],
      processArgv: ["node", "openclaw", "plugins", "install", MATRIX_REPO_INSTALL_SPEC],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["plugins", "install"],
      allowInvalid: true,
    });

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["plugins", "install", "@openclaw/matrix", "--marketplace", "local/repo"],
      processArgv: [
        "node",
        "openclaw",
        "plugins",
        "install",
        "@openclaw/matrix",
        "--marketplace",
        "local/repo",
      ],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
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
    expect(ensureConfigReadyMock).toHaveBeenCalledTimes(1);
  });

  it("applies --json stdout suppression only for explicit JSON output commands", async () => {
    await runPreAction({
      parseArgv: ["status"],
      processArgv: ["node", "openclaw", "status", "--json"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["status"],
      suppressDoctorStdout: true,
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["update", "status", "--json"],
      processArgv: ["node", "openclaw", "update", "status", "--json"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["update", "status"],
      suppressDoctorStdout: true,
    });
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();

    vi.clearAllMocks();
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "{bad", "--json"],
      processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "{bad", "--json"],
    });

    expect(ensureConfigReadyMock).toHaveBeenCalledWith({
      runtime: runtimeMock,
      commandPath: ["config", "set"],
    });
  });

  it("routes logs to stderr in --json mode so stdout stays clean", async () => {
    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--message", "hi", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();

    vi.clearAllMocks();

    // config set --json is parse-only (not JSON output mode), should not route
    await runPreAction({
      parseArgv: ["config", "set", "gateway.auth.mode", "local", "--json"],
      processArgv: ["node", "openclaw", "config", "set", "gateway.auth.mode", "local", "--json"],
    });

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();

    vi.clearAllMocks();

    // non-json command should not route
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(routeLogsToStderrMock).not.toHaveBeenCalled();
  });

  it("does not preload plugins for agents list JSON output", async () => {
    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list", "--json"],
    });

    expect(routeLogsToStderrMock).toHaveBeenCalledOnce();
    expect(ensurePluginRegistryLoadedMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "config", "validate"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config validate when root option values are present", async () => {
    await runPreAction({
      parseArgv: ["config", "validate"],
      processArgv: ["node", "openclaw", "--profile", "work", "config", "validate"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for config schema", async () => {
    await runPreAction({
      parseArgv: ["config", "schema"],
      processArgv: ["node", "openclaw", "config", "schema"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("bypasses config guard for backup create", async () => {
    await runPreAction({
      parseArgv: ["backup", "create"],
      processArgv: ["node", "openclaw", "backup", "create", "--json"],
    });

    expect(ensureConfigReadyMock).not.toHaveBeenCalled();
  });

  it("routes logs to stderr during plugin loading in --json mode and restores after", async () => {
    let stderrDuringPluginLoad = false;
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      stderrDuringPluginLoad = loggingState.forceConsoleToStderr;
    });

    await runPreAction({
      parseArgv: ["agent"],
      processArgv: ["node", "openclaw", "agent", "--message", "hi", "--json"],
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
    expect(stderrDuringPluginLoad).toBe(true);
    // Flag must be restored after plugin loading completes
    expect(loggingState.forceConsoleToStderr).toBe(false);
  });

  it("does not route logs to stderr during plugin loading without --json", async () => {
    let stderrDuringPluginLoad = false;
    ensurePluginRegistryLoadedMock.mockImplementation(() => {
      stderrDuringPluginLoad = loggingState.forceConsoleToStderr;
    });

    await runPreAction({
      parseArgv: ["agents", "list"],
      processArgv: ["node", "openclaw", "agents", "list"],
    });

    expect(ensurePluginRegistryLoadedMock).toHaveBeenCalled();
    expect(stderrDuringPluginLoad).toBe(false);
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
    )._lifeCycleHooks?.preAction;
    preActionHook = hooks?.[0] ?? null;
  });
});
