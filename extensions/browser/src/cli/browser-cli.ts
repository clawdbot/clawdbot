import type { Command } from "commander";
import {
  registerCommandGroups,
  resolveCliArgvInvocation,
  shouldEagerRegisterSubcommands,
  type CommandGroupEntry,
  type CommandGroupPlaceholder,
} from "openclaw/plugin-sdk/cli-runtime";
import { browserActionExamples, browserCoreExamples } from "./browser-cli-examples.js";
import type { BrowserParentOpts } from "./browser-cli-shared.js";
import {
  addGatewayClientOptions,
  danger,
  defaultRuntime,
  formatCliCommand,
  formatDocsLink,
  formatHelpExamples,
  theme,
} from "./core-api.js";

type BrowserCommandRegistrar = (args: {
  browser: Command;
  parentOpts: (cmd: Command) => BrowserParentOpts;
}) => Promise<void> | void;

type BrowserCommandGroupDefinition = {
  placeholders: readonly CommandGroupPlaceholder[];
  register: BrowserCommandRegistrar;
};

const command = (
  name: string,
  description: string,
  options?: CommandGroupPlaceholder["options"],
): CommandGroupPlaceholder => ({
  name,
  description,
  ...(options ? { options } : {}),
});

const browserCommandGroupDefinitions: readonly BrowserCommandGroupDefinition[] = [
  {
    placeholders: [
      command("status", "Show browser status"),
      command("start", "Start the browser (no-op if already running)"),
      command("stop", "Stop the browser (best-effort)"),
      command("reset-profile", "Reset browser profile (moves it to Trash)"),
      command("tabs", "List open tabs"),
      command("tab", "Tab shortcuts (index-based)"),
      command("open", "Open a URL in a new tab"),
      command("focus", "Focus a tab by target id, tab id, label, or unique target id prefix"),
      command("close", "Close a tab (target id optional)"),
      command("profiles", "List all browser profiles"),
      command("create-profile", "Create a new browser profile"),
      command("delete-profile", "Delete a browser profile"),
      command("doctor", "Check browser plugin readiness", [
        { flags: "--deep", description: "Run a live snapshot probe" },
      ]),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-manage.js");
      module.registerBrowserManageCommands(args.browser, args.parentOpts);
    },
  },
  {
    placeholders: [
      command("screenshot", "Capture a screenshot (MEDIA:<path>)"),
      command("snapshot", "Capture a snapshot (default: ai; aria is the accessibility tree)"),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-inspect.js");
      module.registerBrowserInspectCommands(args.browser, args.parentOpts);
    },
  },
  {
    placeholders: [
      command("navigate", "Navigate the current tab to a URL"),
      command("resize", "Resize the viewport"),
      command("click", "Click an element by ref from snapshot"),
      command("click-coords", "Click viewport coordinates"),
      command("type", "Type into an element by ref from snapshot"),
      command("press", "Press a key"),
      command("hover", "Hover an element by ai ref"),
      command("scrollintoview", "Scroll an element into view by ref from snapshot"),
      command("drag", "Drag from one ref to another"),
      command("select", "Select option(s) in a select element"),
      command("upload", "Arm file upload for the next file chooser"),
      command("waitfordownload", "Wait for the next download (and save it)"),
      command("download", "Click a ref and save the resulting download"),
      command("dialog", "Arm the next modal dialog (alert/confirm/prompt)"),
      command("fill", "Fill a form with JSON field descriptors"),
      command("wait", "Wait for time, selector, URL, load state, or JS conditions"),
      command("evaluate", "Evaluate a function against the page or a ref"),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-actions-input.js");
      module.registerBrowserActionInputCommands(args.browser, args.parentOpts);
    },
  },
  {
    placeholders: [
      command("console", "Get recent console messages"),
      command("pdf", "Save page as PDF"),
      command("responsebody", "Wait for a network response and return its body"),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-actions-observe.js");
      module.registerBrowserActionObserveCommands(args.browser, args.parentOpts);
    },
  },
  {
    placeholders: [
      command("highlight", "Highlight an element by ref"),
      command("errors", "Get recent page errors"),
      command("requests", "Get recent network requests (best-effort)"),
      command("trace", "Record a Playwright trace"),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-debug.js");
      module.registerBrowserDebugCommands(args.browser, args.parentOpts);
    },
  },
  {
    placeholders: [
      command("cookies", "Read/write cookies"),
      command("storage", "Read/write localStorage/sessionStorage"),
      command("set", "Browser environment settings"),
    ],
    register: async (args) => {
      const module = await import("./browser-cli-state.js");
      module.registerBrowserStateCommands(args.browser, args.parentOpts);
    },
  },
];

function buildBrowserCommandGroups(params: {
  browser: Command;
  parentOpts: (cmd: Command) => BrowserParentOpts;
}): CommandGroupEntry[] {
  return browserCommandGroupDefinitions.map((entry) => ({
    placeholders: entry.placeholders,
    register: async () => await entry.register(params),
  }));
}

function registerLazyBrowserCommands(
  browser: Command,
  parentOpts: (cmd: Command) => BrowserParentOpts,
  argv: string[],
) {
  const { primary, commandPath } = resolveCliArgvInvocation(argv);
  const subcommand = primary === "browser" ? (commandPath[1] ?? null) : null;
  registerCommandGroups(browser, buildBrowserCommandGroups({ browser, parentOpts }), {
    eager: shouldEagerRegisterSubcommands(),
    primary: subcommand,
    registerPrimaryOnly: subcommand !== null,
  });
}

export function registerBrowserCli(program: Command, argv: string[] = process.argv) {
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

  registerLazyBrowserCommands(browser, parentOpts, argv);
}
