// Friendly parse-error formatter for Commander errors and root CLI recovery hints.
import { formatDocsLink } from "../../../packages/terminal-core/src/links.js";
import { theme } from "../../../packages/terminal-core/src/theme.js";
import { getCommandPathWithRootOptions } from "../argv.js";
import { formatCliCommand } from "../command-format.js";
import { CliParseError } from "../failure-output.js";
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
  return `${theme.muted("Try:")} ${theme.command(resolveHelpCommand(argv, options))}`;
}

function formatDocsHint(): string {
  return `${theme.muted("Docs:")} ${formatDocsLink("/cli", "docs.openclaw.ai/cli")}`;
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
): CliParseError {
  const message = stripCommanderErrorPrefix(raw);
  const unknownCommand = message.match(/^unknown command ['"`](.+?)['"`]/i);
  if (unknownCommand) {
    const command = unknownCommand[1] ?? "";
    const commandPath = options.commandPath ?? [];
    return new CliParseError({
      message: formatUnknownCommandMessage(command, commandPath),
      humanOutput: formatCliUnknownCommandOutput(command, options),
      humanOutputWritten: errorOptions.humanOutputWritten,
    });
  }
  return new CliParseError({
    message,
    humanOutput: formatCliParseErrorOutput(raw, options),
    humanOutputWritten: errorOptions.humanOutputWritten,
  });
}

export function createCliUnknownCommandError(
  command: string,
  options: FormatCliParseErrorOptions = {},
): CliParseError {
  const commandPath = options.commandPath ?? [];
  return new CliParseError({
    message: formatUnknownCommandMessage(command, commandPath),
    humanOutput: formatCliUnknownCommandOutput(command, options),
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
    return lines(
      theme.error(`OpenClaw does not recognize option ${quote(option)}.`),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  const missingArgument = message.match(/^missing required argument ['"`](.+?)['"`]/i);
  if (missingArgument) {
    const argument = missingArgument[1] ?? "";
    return lines(
      theme.error(`Missing required argument ${quote(argument)}.`),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  const missingOption = message.match(/^required option ['"`](.+?)['"`] not specified/i);
  if (missingOption) {
    const option = missingOption[1] ?? "";
    return lines(
      theme.error(`Missing required option ${quote(option)}.`),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  if (/^too many arguments\b/i.test(message)) {
    return lines(
      theme.error("Too many arguments for this command."),
      formatHelpHint(options.argv, { commandPath: options.commandPath }),
    );
  }

  return lines(
    theme.error(`OpenClaw could not parse this command: ${message}`),
    formatHelpHint(options.argv, { commandPath: options.commandPath }),
  );
}
