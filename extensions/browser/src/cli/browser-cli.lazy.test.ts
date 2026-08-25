// Browser tests cover browser cli.lazy plugin behavior.
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isBrowserMachineOutput } from "../../cli-output-mode.js";

const manageMocks = vi.hoisted(() => {
  const doctorAction = vi.fn();
  const openAction = vi.fn();
  const startAction = vi.fn();
  const statusAction = vi.fn();
  const tabNewAction = vi.fn();
  const tabsAction = vi.fn();
  const registerBrowserManageCommands = vi.fn((browser: Command) => {
    browser.command("start").description("Start browser").action(startAction);
    browser.command("status").description("Show browser status").action(statusAction);
    browser.command("tabs").description("List tabs").action(tabsAction);
    browser
      .command("tab")
      .description("Tab shortcuts")
      .command("new")
      .description("Open a new tab")
      .action(tabNewAction);
    browser.command("open").description("Open URL").argument("<url>").action(openAction);
    browser
      .command("doctor")
      .description("Check browser plugin readiness")
      .option("--deep", "Run a live snapshot probe")
      .action(doctorAction);
  });
  return {
    doctorAction,
    openAction,
    registerBrowserManageCommands,
    startAction,
    statusAction,
    tabNewAction,
    tabsAction,
  };
});
const cookieSyncMocks = vi.hoisted(() => ({
  registerBrowserCookieSyncCommand: vi.fn(),
}));
const inspectMocks = vi.hoisted(() => ({
  registerBrowserInspectCommands: vi.fn(),
}));
const actionInputMocks = vi.hoisted(() => {
  const waitAction = vi.fn();
  const registerBrowserActionInputCommands = vi.fn(
    (browser: Command, parentOpts: (command: Command) => unknown) => {
      browser
        .command("wait")
        .option("--url <pattern>")
        .action((opts, command) => waitAction(opts, parentOpts(command)));
    },
  );
  return { registerBrowserActionInputCommands, waitAction };
});
const actionObserveMocks = vi.hoisted(() => ({
  registerBrowserActionObserveCommands: vi.fn(),
}));
const debugMocks = vi.hoisted(() => ({
  registerBrowserDebugCommands: vi.fn(),
}));
const stateMocks = vi.hoisted(() => {
  const cookieSetAction = vi.fn();
  const registerBrowserStateCommands = vi.fn(
    (browser: Command, parentOpts: (command: Command) => unknown) => {
      browser
        .command("cookies")
        .command("set")
        .argument("<name>")
        .argument("<value>")
        .option("--url <url>")
        .action((name, value, opts, command) =>
          cookieSetAction(name, value, opts, parentOpts(command)),
        );
    },
  );
  return { cookieSetAction, registerBrowserStateCommands };
});
const extensionMocks = vi.hoisted(() => ({
  registerBrowserExtensionCommands: vi.fn(),
}));

vi.mock("./browser-cli-manage.js", () => manageMocks);
vi.mock("./browser-cli-cookie-sync.js", () => cookieSyncMocks);
vi.mock("./browser-cli-inspect.js", () => inspectMocks);
vi.mock("./browser-cli-actions-input.js", () => actionInputMocks);
vi.mock("./browser-cli-actions-observe.js", () => actionObserveMocks);
vi.mock("./browser-cli-debug.js", () => debugMocks);
vi.mock("./browser-cli-state.js", () => stateMocks);
vi.mock("./browser-cli-extension.js", () => extensionMocks);

const { registerBrowserCli } = await import("./browser-cli.js");

function requireFirstCall<TArgs extends unknown[]>(
  mock: { mock: { calls: TArgs[] } },
  label: string,
): TArgs {
  const [call] = mock.mock.calls;
  if (!call) {
    throw new Error(`expected ${label}`);
  }
  return call;
}

function requireTrailingCommand(args: unknown[], label: string): Command {
  const command = args.at(-1);
  if (!(command instanceof Command)) {
    throw new Error(`expected trailing command for ${label}`);
  }
  return command;
}

describe("registerBrowserCli lazy browser subcommands", () => {
  it.each([
    ["evaluate", ["browser", "evaluate", "--fn", "return 1"]],
    ["console", ["browser", "console"]],
    ["cookies", ["browser", "cookies"]],
    ["local storage", ["browser", "storage", "local", "get"]],
    ["session storage", ["browser", "storage", "session", "get", "key"]],
    ["native host", ["browser", "extension", "native-host"]],
  ])("declares default JSON output for %s", (_name, args) => {
    expect(isBrowserMachineOutput({ argv: ["node", "openclaw", ...args] })).toBe(true);
  });

  it.each(["install", "status", "uninstall-host", "pair", "cdp"])(
    "declares explicit JSON output for extension %s",
    (subcommand) => {
      expect(
        isBrowserMachineOutput({
          argv: ["node", "openclaw", "browser", "extension", subcommand, "--json"],
        }),
      ).toBe(true);
    },
  );

  it("keeps human browser commands out of machine-output mode", () => {
    expect(isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", "status"] })).toBe(false);
    expect(
      isBrowserMachineOutput({ argv: ["node", "openclaw", "browser", "cookies", "set"] }),
    ).toBe(false);
  });

  it("accepts supported root options after browser", () => {
    expect(
      isBrowserMachineOutput({
        argv: ["node", "openclaw", "browser", "--log-level", "debug", "evaluate"],
      }),
    ).toBe(true);
  });

  beforeEach(() => {
    vi.unstubAllEnvs();
    manageMocks.registerBrowserManageCommands.mockClear();
    manageMocks.doctorAction.mockClear();
    manageMocks.openAction.mockClear();
    manageMocks.startAction.mockClear();
    manageMocks.statusAction.mockClear();
    manageMocks.tabNewAction.mockClear();
    manageMocks.tabsAction.mockClear();
    cookieSyncMocks.registerBrowserCookieSyncCommand.mockClear();
    inspectMocks.registerBrowserInspectCommands.mockClear();
    actionInputMocks.registerBrowserActionInputCommands.mockClear();
    actionInputMocks.waitAction.mockClear();
    actionObserveMocks.registerBrowserActionObserveCommands.mockClear();
    debugMocks.registerBrowserDebugCommands.mockClear();
    stateMocks.registerBrowserStateCommands.mockClear();
    stateMocks.cookieSetAction.mockClear();
    extensionMocks.registerBrowserExtensionCommands.mockClear();
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
    if (!doctor) {
      throw new Error("expected browser doctor command placeholder");
    }
    expect(doctor.options.map((option) => option.long)).toContain("--deep");
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
    const [doctorOptions] = requireFirstCall(manageMocks.doctorAction, "doctor action call");
    expect(doctorOptions.deep).toBe(true);
  });

  it("preserves parent --json while reparsing lazy manage commands", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--json", "open", "about:blank"]);

    await program.parseAsync(["browser", "--json", "open", "about:blank"], { from: "user" });

    expect(manageMocks.openAction).toHaveBeenCalledTimes(1);
    const openCommand = requireTrailingCommand(
      requireFirstCall(manageMocks.openAction, "open action call"),
      "open action",
    );
    expect(openCommand.parent?.opts().json).toBe(true);

    const tabsProgram = new Command();
    tabsProgram.name("openclaw");
    registerBrowserCli(tabsProgram, ["node", "openclaw", "browser", "--json", "tabs"]);

    await tabsProgram.parseAsync(["browser", "--json", "tabs"], { from: "user" });

    expect(manageMocks.tabsAction).toHaveBeenCalledTimes(1);
    const tabsCommand = requireTrailingCommand(
      requireFirstCall(manageMocks.tabsAction, "tabs action call"),
      "tabs action",
    );
    expect(tabsCommand.parent?.opts().json).toBe(true);
  });

  it("keeps wait action URLs out of Gateway transport options", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, ["node", "openclaw", "browser", "wait", "--url", "**/done"]);

    await program.parseAsync(["browser", "wait", "--url", "**/done"], { from: "user" });

    const [opts, parent] = requireFirstCall(actionInputMocks.waitAction, "wait action call");
    expect(opts).toMatchObject({ url: "**/done" });
    expect(parent).not.toHaveProperty("url");
  });

  it("keeps explicit Gateway and wait URLs under their separate owners", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "--url",
      "ws://127.0.0.1:18789",
      "wait",
      "--url",
      "**/done",
    ]);

    await program.parseAsync(
      ["browser", "--url", "ws://127.0.0.1:18789", "wait", "--url", "**/done"],
      { from: "user" },
    );

    const [opts, parent] = requireFirstCall(actionInputMocks.waitAction, "wait action call");
    expect(opts).toMatchObject({ url: "**/done" });
    expect(parent).toMatchObject({ url: "ws://127.0.0.1:18789" });
  });

  it("keeps cookie action URLs out of Gateway transport options", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
    ]);

    await program.parseAsync(
      ["browser", "cookies", "set", "session", "abc", "--url", "https://example.com"],
      { from: "user" },
    );

    const cookieCall = requireFirstCall(stateMocks.cookieSetAction, "cookie set action call");
    const opts = cookieCall[2];
    const parent = cookieCall[3];
    expect(opts).toMatchObject({ url: "https://example.com" });
    expect(parent).not.toHaveProperty("url");
  });

  it("keeps explicit Gateway and cookie URLs under their separate owners", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "--url",
      "ws://127.0.0.1:18789",
      "cookies",
      "set",
      "session",
      "abc",
      "--url",
      "https://example.com",
    ]);

    await program.parseAsync(
      [
        "browser",
        "--url",
        "ws://127.0.0.1:18789",
        "cookies",
        "set",
        "session",
        "abc",
        "--url",
        "https://example.com",
      ],
      { from: "user" },
    );

    const cookieCall = requireFirstCall(stateMocks.cookieSetAction, "cookie set action call");
    const opts = cookieCall[2];
    const parent = cookieCall[3];
    expect(opts).toMatchObject({ url: "https://example.com" });
    expect(parent).toMatchObject({ url: "ws://127.0.0.1:18789" });
  });

  it("accepts the shipped trailing browser profile order after lazy loading", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "tabs",
      "--browser-profile",
      "remote",
    ]);

    await program.parseAsync(["browser", "tabs", "--browser-profile", "remote"], {
      from: "user",
    });

    const tabsCommand = requireTrailingCommand(
      requireFirstCall(manageMocks.tabsAction, "tabs action call"),
      "tabs action",
    );
    expect(tabsCommand.parent?.opts().browserProfile).toBe("remote");
  });

  it.each([
    ["before", ["browser", "--timeout", "60000", "status"]],
    ["after", ["browser", "status", "--timeout", "60000"]],
  ])(
    "preserves parent timeout %s a lazily loaded leaf in positional mode",
    async (_place, args) => {
      const program = new Command().name("openclaw").enablePositionalOptions();
      registerBrowserCli(program, ["node", "openclaw", ...args]);

      await program.parseAsync(args, { from: "user" });

      const command = requireTrailingCommand(
        requireFirstCall(manageMocks.statusAction, "status action call"),
        "status action",
      );
      expect(command.parent?.opts().timeout).toBe("60000");
    },
  );

  it("preserves parent timeout before a nested lazily loaded storage-family leaf", async () => {
    const program = new Command().name("openclaw").enablePositionalOptions();
    const args = ["browser", "--timeout", "60000", "cookies", "set", "session", "abc"];
    registerBrowserCli(program, ["node", "openclaw", ...args]);

    await program.parseAsync(args, { from: "user" });

    const cookieCall = requireFirstCall(stateMocks.cookieSetAction, "cookie set action call");
    expect(cookieCall[3]).toMatchObject({ timeout: "60000" });
  });

  it("skips browser option values when selecting the lazy command group", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "--browser-profile",
      "status",
      "start",
    ]);

    const browser = program.commands.find((command) => command.name() === "browser");
    expect(browser?.commands.map((command) => command.name())).toContain("start");

    await program.parseAsync(["browser", "--browser-profile", "status", "start"], {
      from: "user",
    });

    expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
    expect(manageMocks.startAction).toHaveBeenCalledTimes(1);
    expect(manageMocks.statusAction).not.toHaveBeenCalled();
  });

  it("resolves browser parent options for nested commands", async () => {
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, [
      "node",
      "openclaw",
      "browser",
      "--browser-profile",
      "work",
      "tab",
      "new",
    ]);

    await program.parseAsync(["browser", "--browser-profile", "work", "--json", "tab", "new"], {
      from: "user",
    });

    expect(manageMocks.tabNewAction).toHaveBeenCalledTimes(1);
    const tabCommand = requireTrailingCommand(
      requireFirstCall(manageMocks.tabNewAction, "tab new action call"),
      "tab new action",
    );
    expect(tabCommand.parent?.parent?.opts()).toMatchObject({ browserProfile: "work", json: true });
  });

  it("can eagerly register all browser groups for compatibility", async () => {
    vi.stubEnv("OPENCLAW_DISABLE_LAZY_SUBCOMMANDS", "1");
    const program = new Command();
    program.name("openclaw");

    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);

    await vi.waitFor(() => {
      expect(manageMocks.registerBrowserManageCommands).toHaveBeenCalledTimes(1);
      expect(cookieSyncMocks.registerBrowserCookieSyncCommand).toHaveBeenCalledTimes(1);
      expect(inspectMocks.registerBrowserInspectCommands).toHaveBeenCalledTimes(1);
      expect(actionInputMocks.registerBrowserActionInputCommands).toHaveBeenCalledTimes(1);
      expect(actionObserveMocks.registerBrowserActionObserveCommands).toHaveBeenCalledTimes(1);
      expect(debugMocks.registerBrowserDebugCommands).toHaveBeenCalledTimes(1);
      expect(stateMocks.registerBrowserStateCommands).toHaveBeenCalledTimes(1);
      expect(extensionMocks.registerBrowserExtensionCommands).toHaveBeenCalledTimes(1);
    });
  });
});
