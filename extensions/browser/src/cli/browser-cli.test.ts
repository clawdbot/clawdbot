// Browser tests cover browser cli plugin behavior.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";

vi.mock("../control-service.js", () => {
  throw new Error("Browser CLI registration must not load browser control services");
});
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => {
  throw new Error("Browser CLI registration must not load agent runtime");
});
vi.mock("openclaw/plugin-sdk/media-understanding-runtime", () => {
  throw new Error("Browser CLI registration must not load media understanding runtime");
});
vi.mock("openclaw/plugin-sdk/media-runtime", () => {
  throw new Error("Browser CLI registration must not load media runtime");
});

describe("Browser CLI import boundary", () => {
  it("registers root help without loading browser services or agent/media runtime", async () => {
    const { registerBrowserCli } = await import("./browser-cli.js");
    const program = new Command();
    registerBrowserCli(program, ["node", "openclaw", "browser", "--help"]);
    const browser = program.commands[0];
    expect(browser?.helpInformation()).toContain("--browser-profile");
    expect(browser?.commands.map((command) => command.name())).toContain("extension");
  });

  it("registers extension leaves without loading browser services or agent/media runtime", async () => {
    const { registerBrowserExtensionCommands } = await import("./browser-cli-extension.js");
    const program = new Command();
    const browser = program.command("browser");
    registerBrowserExtensionCommands(browser, () => ({}));
    expect(browser.commands[0]?.commands.map((command) => command.name())).toEqual([
      "path",
      "install",
      "status",
      "uninstall-host",
      "pair",
      "cdp",
    ]);
  });

  it("registers Gateway-backed command siblings without loading local browser services", async () => {
    const { registerBrowserManageCommands } = await import("./browser-cli-manage.js");
    const { registerBrowserInspectCommands } = await import("./browser-cli-inspect.js");
    const { registerBrowserStateCommands } = await import("./browser-cli-state.js");
    const program = new Command();
    const browser = program.command("browser");
    for (const register of [
      registerBrowserManageCommands,
      registerBrowserInspectCommands,
      registerBrowserStateCommands,
    ]) {
      register(browser, () => ({}));
    }
    expect(browser.commands.map((command) => command.name())).toEqual(
      expect.arrayContaining([
        "start",
        "doctor",
        "import-profile",
        "snapshot",
        "screenshot",
        "cookies",
        "storage",
        "set",
      ]),
    );
  });
});

function runBrowserStatus(argv: string[]) {
  const program = new Command();
  program.name("test");
  program.option("--profile <name>", "Global config profile");

  const browser = program
    .command("browser")
    .option("--browser-profile <name>", "Browser profile name");

  let globalProfile: string | undefined;
  let browserProfile: string | undefined = "should-be-undefined";

  browser.command("status").action((_opts, cmd) => {
    const parent = cmd.parent?.opts?.() as { browserProfile?: string };
    browserProfile = parent?.browserProfile;
    globalProfile = program.opts().profile;
  });

  program.parse(["node", "test", ...argv]);

  return { globalProfile, browserProfile };
}

describe("browser CLI --browser-profile flag", () => {
  it.each([
    {
      label: "parses --browser-profile from parent command options",
      argv: ["browser", "--browser-profile", "onasset", "status"],
      expectedBrowserProfile: "onasset",
    },
    {
      label: "defaults to undefined when --browser-profile not provided",
      argv: ["browser", "status"],
      expectedBrowserProfile: undefined,
    },
  ])("$label", ({ argv, expectedBrowserProfile }) => {
    const { browserProfile } = runBrowserStatus(argv);
    expect(browserProfile).toBe(expectedBrowserProfile);
  });

  it("does not conflict with global --profile flag", () => {
    // The global --profile flag is handled by /entry.js before Commander
    // This test verifies --browser-profile is a separate option
    const { globalProfile, browserProfile } = runBrowserStatus([
      "--profile",
      "dev",
      "browser",
      "--browser-profile",
      "onasset",
      "status",
    ]);

    expect(globalProfile).toBe("dev");
    expect(browserProfile).toBe("onasset");
  });
});
