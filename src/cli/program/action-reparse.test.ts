// Action reparse tests cover Commander action reparsing for nested CLI commands.
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { reparseProgramFromActionCommand } from "./action-reparse.js";

function setRawArgs(command: Command, rawArgs: string[]): void {
  (command as Command & { rawArgs: string[] }).rawArgs = rawArgs;
}

async function expectReparseArgv(params: {
  parent: Command;
  action: Command;
  argv: string[];
  expected: string[];
}): Promise<void> {
  let root = params.parent;
  while (root.parent) {
    root = root.parent;
  }
  setRawArgs(root, params.argv);
  const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);

  await reparseProgramFromActionCommand(params.parent, params.action);

  expect(parseAsync).toHaveBeenCalledWith(params.expected);
}

describe("reparseProgramFromActionCommand", () => {
  it("uses root raw args and reparses the root for nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    setRawArgs(root, ["node", "openclaw", "workspaces", "audit", "export", "--since", "1"]);
    const workspaces = root.command("workspaces");
    const audit = workspaces.command("audit");
    const exportCommand = audit.command("export");
    const parseAsync = vi.spyOn(root, "parseAsync").mockResolvedValue(root);
    const auditParseAsync = vi.spyOn(audit, "parseAsync");

    await reparseProgramFromActionCommand(audit, exportCommand);

    expect(parseAsync).toHaveBeenCalledWith([
      "node",
      "openclaw",
      "workspaces",
      "audit",
      "export",
      "--since",
      "1",
    ]);
    expect(auditParseAsync).not.toHaveBeenCalled();
  });

  it("hoists a trailing lazy-parent option before the loaded command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: ["node", "openclaw", "browser", "tabs", "--browser-profile", "remote"],
      expected: ["node", "openclaw", "browser", "--browser-profile", "remote", "tabs"],
    });
  });

  it("skips root option values that match the parent command name", async () => {
    const root = new Command().name("openclaw").option("--profile <name>");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    await expectReparseArgv({
      parent: browser,
      action: tabs,
      argv: [
        "node",
        "openclaw",
        "--profile",
        "browser",
        "browser",
        "tabs",
        "--browser-profile",
        "remote",
      ],
      expected: [
        "node",
        "openclaw",
        "--profile",
        "browser",
        "browser",
        "--browser-profile",
        "remote",
        "tabs",
      ],
    });
  });

  it("hoists parent options after nested lazy commands", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tab = browser.command("tab");
    tab.command("new");
    await expectReparseArgv({
      parent: browser,
      action: tab,
      argv: ["node", "openclaw", "browser", "tab", "new", "--browser-profile", "work"],
      expected: ["node", "openclaw", "browser", "--browser-profile", "work", "tab", "new"],
    });
  });

  it("leaves a child-owned option collision after the child command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--json");
    const extension = browser.command("extension");
    extension.command("path");
    extension.command("pair").option("--json");
    const argv = ["node", "openclaw", "browser", "extension", "pair", "--json"];
    await expectReparseArgv({ parent: browser, action: extension, argv, expected: argv });
  });

  it("hoists a parent option when only a sibling command owns the same flag", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--url <url>");
    const cookies = browser.command("cookies");
    cookies.command("list");
    cookies.command("set").option("--url <url>");
    await expectReparseArgv({
      parent: browser,
      action: cookies,
      argv: ["node", "openclaw", "browser", "cookies", "list", "--url", "ws://gateway"],
      expected: ["node", "openclaw", "browser", "--url", "ws://gateway", "cookies", "list"],
    });
  });

  it("keeps a missing parent option value after the loaded command", async () => {
    const root = new Command().name("openclaw");
    const browser = root.command("browser").option("--browser-profile <name>");
    const tabs = browser.command("tabs");
    const argv = ["node", "openclaw", "browser", "tabs", "--browser-profile"];
    await expectReparseArgv({ parent: browser, action: tabs, argv, expected: argv });
  });
});
