import type { Command } from "commander";
import { resolveCommitHash } from "../../infra/git-commit.js";
import { formatDocsLink } from "../../terminal/links.js";
import { isRich, theme } from "../../terminal/theme.js";
import { escapeRegExp } from "../../utils.js";
import { hasFlag, hasRootVersionAlias } from "../argv.js";
import { formatCliBannerLine, hasEmittedCliBanner } from "../banner.js";
import { replaceCliName, resolveCliName } from "../cli-name.js";
import { CLI_LOG_LEVEL_VALUES, parseCliLogLevelOption } from "../log-level-option.js";
import type { ProgramContext } from "./context.js";
import { getCoreCliCommandsWithSubcommands } from "./core-command-descriptors.js";
import { formatCliParseErrorOutput } from "./error-output.js";
import { getSubCliCommandsWithSubcommands } from "./subcli-descriptors.js";

const CLI_NAME = resolveCliName();
const CLI_NAME_PATTERN = escapeRegExp(CLI_NAME);
const ROOT_COMMANDS_WITH_SUBCOMMANDS = new Set([
  ...getCoreCliCommandsWithSubcommands(),
  ...getSubCliCommandsWithSubcommands(),
]);
const ROOT_COMMANDS_HINT =
  "Hint: commands suffixed with * have subcommands. Run <command> --help for details.";

const EXAMPLES = [
  ["openclaw onboard", "Run guided setup for a local Gateway, workspace, auth, and channels."],
  ["openclaw setup", "Create the baseline config, workspace, and session folders."],
  ["openclaw configure", "Change models, Gateway, channels, plugins, skills, and health checks."],
  ["openclaw status", "Check Gateway, channel, model, and recent-session status."],
  ["openclaw doctor --fix", "Repair common config, service, plugin, and channel problems."],
  ["openclaw channels add", "Add or update a chat channel account with guided prompts."],
  ["openclaw channels status", "See connected messaging accounts and login state."],
  ["openclaw --dev gateway", "Run a dev Gateway (isolated state/config) on ws://127.0.0.1:19001."],
  ["openclaw gateway run --force", "Start the Gateway and replace anything bound to its port."],
  ["openclaw models status", "Show model/provider auth health before running agents."],
  ["openclaw plugins list", "Inspect enabled, disabled, and installed plugins."],
  [
    'openclaw agent --to +15555550123 --message "Run summary" --deliver',
    "Run one agent turn through the Gateway and optionally deliver the reply.",
  ],
  [
    'openclaw message send --channel telegram --target @mychat --message "Hi"',
    "Send via your Telegram bot.",
  ],
] as const;

export function configureProgramHelp(program: Command, ctx: ProgramContext) {
  program
    .name(CLI_NAME)
    .description("")
    .version(ctx.programVersion)
    .option(
      "--container <name>",
      "Run the CLI inside a running Podman/Docker container named <name> (default: env OPENCLAW_CONTAINER)",
    )
    .option(
      "--dev",
      "Dev profile: isolate state under ~/.openclaw-dev, default gateway port 19001, and shift derived ports (browser/canvas)",
    )
    .option(
      "--profile <name>",
      "Use a named profile (isolates OPENCLAW_STATE_DIR/OPENCLAW_CONFIG_PATH under ~/.openclaw-<name>)",
    )
    .option(
      "--log-level <level>",
      `Global log level override for file + console (${CLI_LOG_LEVEL_VALUES})`,
      parseCliLogLevelOption,
    );

  program.option("--no-color", "Disable ANSI colors", false);
  program.helpOption("-h, --help", "Display help for command");
  program.helpCommand("help [command]", "Display help for command");

  program.configureHelp({
    // sort options and subcommands alphabetically
    sortSubcommands: true,
    sortOptions: true,
    optionTerm: (option) => theme.option(option.flags),
    subcommandTerm: (cmd) => {
      const isRootCommand = cmd.parent === program;
      const hasSubcommands = isRootCommand && ROOT_COMMANDS_WITH_SUBCOMMANDS.has(cmd.name());
      return theme.command(hasSubcommands ? `${cmd.name()} *` : cmd.name());
    },
  });

  const formatHelpOutput = (str: string) => {
    let output = str;
    const isRootHelp = new RegExp(
      `^Usage:\\s+${CLI_NAME_PATTERN}\\s+\\[options\\]\\s+\\[command\\]\\s*$`,
      "m",
    ).test(output);
    if (isRootHelp && /^Commands:/m.test(output)) {
      output = output.replace(/^Commands:/m, `Commands:\n  ${theme.muted(ROOT_COMMANDS_HINT)}`);
    }

    return output
      .replace(/^Usage:/gm, theme.heading("Usage:"))
      .replace(/^Options:/gm, theme.heading("Options:"))
      .replace(/^Commands:/gm, theme.heading("Commands:"));
  };

  program.configureOutput({
    writeOut: (str) => {
      process.stdout.write(formatHelpOutput(str));
    },
    writeErr: (str) => {
      process.stderr.write(formatHelpOutput(str));
    },
    outputError: (str, write) => write(formatCliParseErrorOutput(str, { argv: process.argv })),
  });

  if (
    hasFlag(process.argv, "-V") ||
    hasFlag(process.argv, "--version") ||
    hasRootVersionAlias(process.argv)
  ) {
    const commit = resolveCommitHash({ moduleUrl: import.meta.url });
    console.log(
      commit ? `OpenClaw ${ctx.programVersion} (${commit})` : `OpenClaw ${ctx.programVersion}`,
    );
    process.exit(0);
  }

  program.addHelpText("beforeAll", () => {
    if (hasEmittedCliBanner() || process.env.OPENCLAW_SUPPRESS_HELP_BANNER === "1") {
      return "";
    }
    const rich = isRich();
    const line = formatCliBannerLine(ctx.programVersion, { richTty: rich, mode: "default" });
    return `\n${line}\n`;
  });

  const fmtExamples = EXAMPLES.map(
    ([cmd, desc]) => `  ${theme.command(replaceCliName(cmd, CLI_NAME))}\n    ${theme.muted(desc)}`,
  ).join("\n");

  program.addHelpText("afterAll", ({ command }) => {
    if (command !== program) {
      return "";
    }
    const docs = formatDocsLink("/cli", "docs.openclaw.ai/cli");
    return `\n${theme.heading("Examples:")}\n${fmtExamples}\n\n${theme.muted("Docs:")} ${docs}\n`;
  });
}
