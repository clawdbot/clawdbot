// Friendly parse-error formatter for Commander errors and root CLI recovery hints.
import { stripAnsi } from "../../../packages/terminal-core/src/ansi.js";
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { getCommandPathWithRootOptions } from "../argv.js";
import { formatCliCommand } from "../command-format.js";
import { ExpectedCliError } from "../failure-output.js";
import { formatCliCommandSuggestions } from "./command-suggestions.js";

type FormatCliParseErrorOptions = {
  argv?: string[];
  commandPath?: string[];
  commandNames?: readonly string[];
};

function stripCommanderErrorPrefix(raw: string): string {
  return raw
    .trim()
    .replace(/^error:\s*/i, "")
    .trim();
}

function quote(value: string): string {
  return `"${value}"`;
}

function resolveHelpCommand(
  argv: string[] | undefined,
  options?: { commandPath?: string[] },
): string {
  const commandPath = options?.commandPath ?? (argv ? getCommandPathWithRootOptions(argv, 2) : []);
  if (commandPath.length === 0) {
    return formatCliCommand("openclaw --help");
  }
  return formatCliCommand(`openclaw ${commandPath.join(" ")} --help`);
}

function lines(...items: Array<string | undefined>): string {
  return `${items.filter((item): item is string => Boolean(item)).join("\n")}\n`;
}

function formatHelpHint(argv: string[] | undefined, options?: { commandPath?: string[] }): string {
  const command = resolveHelpCommand(argv, options);
  return `${theme.muted("Try:")} ${theme.command(command)}`;
}

function formatDocsHint(): string {
  return `${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}`;
}

function formatCliMachineOutput(humanOutput: string): string {
  const docs = `Docs: ${formatDocsLink("/cli", "docs.openclaw.ai/cli", { force: false })}`;
  return stripAnsi(humanOutput).replace(/^Docs:.*$/mu, docs);
}

function formatUnknownCommandMessage(command: string, commandPath: readonly string[]): string {
  return commandPath.length > 0
    ? `OpenClaw ${commandPath.join(" ")} has no command ${quote(command)}.`
    : `OpenClaw does not know the command ${quote(command)}.`;
}

function formatCliUnknownCommandOutput(
  command: string,
  options: FormatCliParseErrorOptions = {},
): string {
  const commandPath = options.commandPath ?? [];
  const hasParentCommand = commandPath.length > 0;
  return lines(
    theme.error(formatUnknownCommandMessage(command, commandPath)),
    formatCliCommandSuggestions(command, commandPath, options.commandNames),
    formatHelpHint(options.argv, { commandPath }),
    hasParentCommand
      ? undefined
      : `${theme.muted("Plugin command?")} ${theme.command(formatCliCommand("openclaw plugins list"))}`,
    formatDocsHint(),
  );
}

export function createCliParseError(
  raw: string,
  options: FormatCliParseErrorOptions = {},
  errorOptions: { humanOutputWritten?: boolean } = {},
): ExpectedCliError {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    const command = unknownCommand[1] ?? "";
    const commandPath = options.commandPath ?? [];
    const humanOutput = formatCliUnknownCommandOutput(command, options);
    return new ExpectedCliError({
      message: formatUnknownCommandMessage(command, commandPath),
      humanOutput,
      humanOutputWritten: errorOptions.humanOutputWritten,
      machineOutput: formatCliMachineOutput(humanOutput),
    });
  }
  const humanOutput = formatCliParseErrorOutput(raw, options);
  return new ExpectedCliError({
    message,
    humanOutput,
    humanOutputWritten: errorOptions.humanOutputWritten,
    machineOutput: formatCliMachineOutput(humanOutput),
  });
}

export function createCliUnknownCommandError(
  command: string,
  options: FormatCliParseErrorOptions = {},
): ExpectedCliError {
  const commandPath = options.commandPath ?? [];
  const humanOutput = formatCliUnknownCommandOutput(command, options);
  return new ExpectedCliError({
    message: formatUnknownCommandMessage(command, commandPath),
    humanOutput,
    machineOutput: formatCliMachineOutput(humanOutput),
  });
}

/** Convert Commander parse errors into OpenClaw-specific help and docs guidance. */
export function formatCliParseErrorOutput(
  raw: string,
  options: FormatCliParseErrorOptions = {},
): string {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    return formatCliUnknownCommandOutput(unknownCommand[1] ?? "", options);
  }

  const unknownOption = message.match(/^unknown option ['"`](.+?)['"`]/i);
  if (unknownOption) {
    const option = unknownOption[1] ?? "";
    const output = `OpenClaw does not recognize option ${quote(option)}.`;
    return lines(
      theme.error(output),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  const missingArgument = message.match(/^missing required argument ['"`](.+?)['"`]/i);
  if (missingArgument) {
    const argument = missingArgument[1] ?? "";
    const output = `Missing required argument ${quote(argument)}.`;
    return lines(
      theme.error(output),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  const missingOption = message.match(/^required option ['"`](.+?)['"`] not specified/i);
  if (missingOption) {
    const option = missingOption[1] ?? "";
    const output = `Missing required option ${quote(option)}.`;
    return lines(
      theme.error(output),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  if (/^too many arguments\b/i.test(message)) {
    const output = "Too many arguments for this command.";
    return lines(
      theme.error(output),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  const output = `OpenClaw could not parse this command: ${message}`;
  return lines(
    theme.error(output),
    formatHelpHint(options.argv, { commandPath: options.commandPath }),
  );
}
