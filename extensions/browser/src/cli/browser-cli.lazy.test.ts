import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const manageMocks = vi.hoisted(() => {
  const doctorAction = vi.fn();
  const openAction = vi.fn();
  const statusAction = vi.fn();
  const tabsAction = vi.fn();
  const registerBrowserManageCommands = vi.fn((browser: Command) => {
    browser.command("status").description("Show browser status").action(statusAction);
    browser.command("tabs").description("List tabs").action(tabsAction);
    browser.command("open").description("Open URL").argument("<url>").action(openAction);
    browser
      .command("doctor")
      .description("Check browser plugin readiness")
      .option("--deep", "Run a live snapshot probe")
      .action(doctorAction);
  });
  return { doctorAction, openAction, registerBrowserManageCommands, statusAction, tabsAction };
});
const inspectMocks = vi.hoisted(() => ({
  registerBrowserInspectCommands: vi.fn(),
}));
const actionInputMocks = vi.hoisted(() => ({
  registerBrowserActionInputCommands: vi.fn(),
}));
const actionObserveMocks = vi.hoisted(() => ({
  registerBrowserActionObserveCommands: vi.fn(),
}));
const debugMocks = vi.hoisted(() => ({
  registerBrowserDebugCommands: vi.fn(),
}));
const stateMocks = vi.hoisted(() => ({
  registerBrowserStateCommands: vi.fn(),
}));

vi.mock("./browser-cli-manage.js", () => manageMocks);
vi.mock("./browser-cli-inspect.js", () => inspectMocks);
vi.mock("./browser-cli-actions-input.js", () => actionInputMocks);
vi.mock("./browser-cli-actions-observe.js", () => actionObserveMocks);
vi.mock("./browser-cli-debug.js", () => debugMocks);
vi.mock("./browser-cli-state.js", () => stateMocks);

const { registerBrowserCli } = await import("./browser-cli.js");

describe("registerBrowserCli lazy browser subcommands", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    manageMocks.registerBrowserManageCommands.mockClear();
    manageMocks.doctorAction.mockClear();
    manageMocks.openAction.mockClear();
    manageMocks.statusAction.mockClear();
    manageMocks.tabsAction.mockClear();
    inspectMocks.registerBrowserInspectCommands.mockClear();
    actionInputMocks.registerBrowserActionInputCommands.mockClear();
    actionObserveMocks.registerBrowserActionObserveCommands.mockClear();
    debugMocks.registerBrowserDebugCommands.mockClear();
    stateMocks.registerBrowserStateCommands.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers browser placeholders without loading handlers for help", () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toContain("status");
    expect(browser?.commands.map((command) => command.name())).toContain("snapshot");
    const doctor = browser?.commands.find((command) => command.name() === "doctor");
    expect(doctor).toBeDefined();
    expect(doctor?.options.map((option) => option.long)).toContain("--deep");
    expect(manageMocks.registerBrowserManageCommands).not.toHaveBeenCalled();
    expect(inspectMocks.registerBrowserInspectCommands).not.toHaveBeenCalled();
    expect(actionInputMocks.registerBrowserActionInputCommands).not.toHaveBeenCalled();
  });

  it("registers only the requested browser group before dispatch", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "status"]);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toEqual(["status"]);

    await program.parseAsync(["browser", "status"], { from: "user" });

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(inspectMocks.registerBrowserInspectCommands).not.toHaveBeenCalled();
    expect(manageMocks.statusAction).toHaveBeenCalledTimes(1);
  });

  it("loads browser doctor from the manage group so --deep is available", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "doctor", "--deep"]);

    await program.parseAsync(["browser", "doctor", "--deep"], { from: "user" });

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(debugMocks.registerBrowserDebugCommands).not.toHaveBeenCalled();
    expect(manageMocks.doctorAction).toHaveBeenCalledTimes(1);
    expect(manageMocks.doctorAction.mock.calls[0]?.[0]).toMatchObject({ deep: true });
  });

  it("preserves parent --json while reparsing lazy manage commands", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--json", "open", "about:blank"]);

    await program.parseAsync(["browser", "--json", "open", "about:blank"], { from: "user" });

    expect(manageMocks.openAction).toHaveBeenCalledTimes(1);
    const openCommand = manageMocks.openAction.mock.calls[0]?.at(-1) as Command | undefined;
    expect(openCommand?.parent?.opts()).toMatchObject({ json: true });

    const tabsProgram = new Command();
    tabsProgram.name("openclaw");
    registerBrowserCli(tabsProgram, ["node", "openclaw", "browser", "--json", "tabs"]);

    await tabsProgram.parseAsync(["browser", "--json", "tabs"], { from: "user" });

    expect(manageMocks.tabsAction).toHaveBeenCalledTimes(1);
    const tabsCommand = manageMocks.tabsAction.mock.calls[0]?.at(-1) as Command | undefined;
    expect(tabsCommand?.parent?.opts()).toMatchObject({ json: true });
  });

  it("can eagerly register all browser groups for compatibility", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    await vi.waitFor(() =>
      expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1),
    );
    expect(inspectMocks.registerBrowserInspectCommands).toHaveBeenCalledTimes(1);
    expect(actionInputMocks.registerBrowserActionInputCommands).toHaveBeenCalledTimes(1);
    expect(actionObserveMocks.registerBrowserActionObserveCommands).toHaveBeenCalledTimes(1);
    expect(debugMocks.registerBrowserDebugCommands).toHaveBeenCalledTimes(1);
    expect(stateMocks.registerBrowserStateCommands).toHaveBeenCalledTimes(1);
  });
});
