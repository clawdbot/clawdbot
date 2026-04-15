import type { Command } from "commander";
import { registerBrowserActionInputCommands } from "./browser-cli-actions-input.js";
import { registerBrowserActionObserveCommands } from "./browser-cli-actions-observe.js";
import { registerBrowserDebugCommands } from "./browser-cli-debug.js";
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
import { registerBrowserInspectCommands } from "./browser-cli-inspect.js";
import { registerBrowserManageCommands } from "./browser-cli-manage.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import { registerBrowserStateCommands } from "./browser-cli-state.js";
import {
  addGatewayClientOptions,
  danger,
  defaultRuntime,
  formatCliCommand,
  formatDocsLink,
  formatHelpExamples,
  theme,
} from "./core-api.js";

export function registerBrowserCli(program: Command) {
  const browser = program
    .command("browser")
    .description("Manage OpenClaw's dedicated browser (Chrome/Chromium)")
    .option("--browser-profile <name>", "Browser profile name (default from config)")
    .option("--json", "Output machine-readable JSON", false)
    .addHelpText(
      "after",
      () =>
        `\n${theme.heading("Examples:")}\n${formatHelpExamples(
          [...browserCoreExamples, ...browserActionExamples].map((cmd) => [cmd, ""]),
          true,
        )}\n\n${theme.muted("Docs:")} ${formatDocsLink(
          "/cli/browser",
          "docs.openclaw.ai/cli/browser",
        )}\n`,
    )
    .action(() => {
      browser.outputHelp();
      defaultRuntime.error(
        danger(`Missing subcommand. Try: "${formatCliCommand("openclaw browser status")}"`),
      );
      defaultRuntime.exit(1);
    });

  addGatewayClientOptions(browser);

  const parentOpts = (cmd: Command) => cmd.parent?.opts?.() as BrowserParentOpts;

  registerBrowserManageCommands(browser, parentOpts);
  registerBrowserInspectCommands(browser, parentOpts);
  registerBrowserActionInputCommands(browser, parentOpts);
  registerBrowserActionObserveCommands(browser, parentOpts);
  registerBrowserDebugCommands(browser, parentOpts);
  registerBrowserStateCommands(browser, parentOpts);
}
