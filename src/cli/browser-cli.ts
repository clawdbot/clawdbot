import type { Command } from "commander";

import { danger } from "../globals.js";
import { defaultRuntime } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { theme } from "../terminal/theme.js";
import { registerBrowserActionInputCommands } from "./browser-cli-actions-input.js";
import { registerBrowserActionObserveCommands } from "./browser-cli-actions-observe.js";
import { registerBrowserDebugCommands } from "./browser-cli-debug.js";
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
import { registerBrowserExtensionCommands } from "./browser-cli-extension.js";
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import { registerBrowserServeCommands } from "./browser-cli-serve.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import { registerBrowserStateCommands } from "./browser-cli-state.js";

export function registerBrowserCli(program: Command) {
  const browser = program
    .command("browser")
    .description("Manage clawd's dedicated browser (Chrome/Chromium)")
    .option("--url <url>", "Override browser control URL (default from ~/.clawdbot/clawdbot.json)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\nExamples:\n  ${[...browserCoreExamples, ...browserActionExamples].join("\n  ")}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/browser",
          "docs.clawd.bot/cli/browser",
        )}\n`,
    )
    .action(() => {
      browser.outputHelp();
      defaultRuntime.error(danger('Missing subcommand. Try: "clawdbot browser status"'));
      defaultRuntime.exit(1);
    });

  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;

  registerBrowserManageCommands(browser, parentOpts);
  registerBrowserExtensionCommands(browser, parentOpts);
  registerBrowserServeCommands(browser, parentOpts);
  registerBrowserInspectCommands(browser, parentOpts);
  registerBrowserActionInputCommands(browser, parentOpts);
  registerBrowserActionObserveCommands(browser, parentOpts);
  registerBrowserDebugCommands(browser, parentOpts);
  registerBrowserStateCommands(browser, parentOpts);
}
