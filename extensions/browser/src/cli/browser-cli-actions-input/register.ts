/**
 * Registers Browser CLI action commands that mutate page state or user input.
 */
import type { Command } from "commander";
import type { BrowserParentOpts } from "../browser-cli-shared.js";
import { registerBrowserElementCommands } from "./register.element.js";
import { registerBrowserFilesAndDownloadsCommands } from "./register.files-downloads.js";
import { registerBrowserFormWaitEvalCommands } from "./register.form-wait-eval.js";
import { registerBrowserNavigationCommands } from "./register.navigation.js";

/** Registers navigation, element, file/download, form, wait, and evaluate commands. */
export function registerBrowserActionInputCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
) {
  registerBrowserNavigationCommands(browser, parentOpts);
  registerBrowserElementCommands(browser, parentOpts);
  registerBrowserFilesAndDownloadsCommands(browser, parentOpts);
  registerBrowserFormWaitEvalCommands(browser, parentOpts);
}
