// Reparse support for lazy commands after their placeholder has been replaced.
import type { Command, Option } from "commander";
import { buildParseArgv } from "../argv.js";

function getCommandPathFromRoot(command: Command | undefined): Command[] {
  const path: Command[] = [];
  let current = command;
  while (current?.parent) {
    if (current.name()) {
      path.unshift(current);
    }
    current = current.parent;
  }
  return path;
}

function findRootCommand(cmd: Command): Command {
  let current: Command = cmd;
  while (current.parent) {
    current = current.parent;
  }
  return current;
}

function findOption(command: Command, token: string): Option | undefined {
  const equalsIndex = token.indexOf("=");
  const flag = equalsIndex === -1 ? token : token.slice(0, equalsIndex);
  return command.options.find(
    (candidate) =>
      (candidate.short === flag || candidate.long === flag) &&
      (equalsIndex === -1 || candidate.required || candidate.optional),
  );
}

function findNearestOption(commands: readonly Command[], token: string): Option | undefined {
  for (let index = commands.length - 1; index >= 0; index -= 1) {
    const command = commands[index];
    const option = command ? findOption(command, token) : undefined;
    if (option) {
      return option;
    }
  }
  return undefined;
}

function matchesCommandName(command: Command, token: string): boolean {
  return command.name() === token || command.aliases().includes(token);
}

// Returns 0 for a missing required value, otherwise the number of consumed tokens.
function optionTokenCount(option: Option, argv: readonly string[], index: number): number {
  const token = argv[index] ?? "";
  if (token.includes("=") || (!option.required && !option.optional)) {
    return 1;
  }
  const next = argv[index + 1];
  if (option.required) {
    return next === undefined ? 0 : 2;
  }
  const optionalValue = next && (!next.startsWith("-") || /^-\d/.test(next));
  return optionalValue ? 2 : 1;
}

function findCommandPathEnd(argv: readonly string[], command: Command): number {
  const path = getCommandPathFromRoot(command);
  const root = path[0]?.parent;
  if (!root) {
    return -1;
  }
  const selectedCommands = [root];
  let pathIndex = 0;
  for (let index = 2; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    const option = findNearestOption(selectedCommands, token);
    if (option) {
      const count = optionTokenCount(option, argv, index);
      if (count === 0) {
        return -1;
      }
      index += count - 1;
      continue;
    }
    const nextCommand = path[pathIndex];
    if (!nextCommand || !matchesCommandName(nextCommand, token)) {
      return -1;
    }
    selectedCommands.push(nextCommand);
    pathIndex += 1;
    if (pathIndex === path.length) {
      return index + 1;
    }
  }
  return -1;
}

/** Restore parent-option placement without stealing options owned by the loaded child command. */
function hoistLazyParentOptions(
  argv: string[],
  parentCommand: Command,
  lazyCommandName: string,
): string[] {
  let lazyCommandIndex = findCommandPathEnd(argv, parentCommand);
  if (lazyCommandIndex === -1) {
    return argv;
  }
  while (lazyCommandIndex < argv.length) {
    const option = findOption(parentCommand, argv[lazyCommandIndex] ?? "");
    if (!option) {
      break;
    }
    const count = optionTokenCount(option, argv, lazyCommandIndex);
    if (count === 0) {
      return argv;
    }
    lazyCommandIndex += count;
  }
  if (argv[lazyCommandIndex] !== lazyCommandName) {
    return argv;
  }

  const lazyCommand = parentCommand.commands.find((command) =>
    matchesCommandName(command, lazyCommandName),
  );
  if (!lazyCommand) {
    return argv;
  }
  let selectedCommand = lazyCommand;
  const selectedCommands = [selectedCommand];

  const hoisted: string[] = [];
  const remaining: string[] = [];
  let acceptsSubcommands = true;
  for (let index = lazyCommandIndex + 1; index < argv.length; index += 1) {
    const token = argv[index] ?? "";
    if (token === "--") {
      remaining.push(...argv.slice(index));
      break;
    }
    const childOption = findNearestOption(selectedCommands, token);
    const parentOption = findOption(parentCommand, token);
    const option = childOption ?? parentOption;
    if (option) {
      const count = optionTokenCount(option, argv, index);
      if (count === 0) {
        return argv;
      }
      const tokens = argv.slice(index, index + count);
      (childOption ? remaining : hoisted).push(...tokens);
      index += count - 1;
      continue;
    }
    if (acceptsSubcommands && !token.startsWith("-")) {
      const nextCommand: Command | undefined = selectedCommand.commands.find((command) =>
        matchesCommandName(command, token),
      );
      if (nextCommand) {
        selectedCommand = nextCommand;
        selectedCommands.push(nextCommand);
      } else {
        acceptsSubcommands = false;
      }
    }
    remaining.push(token);
  }
  return hoisted.length === 0
    ? argv
    : [...argv.slice(0, lazyCommandIndex), ...hoisted, lazyCommandName, ...remaining];
}

/** Re-run parsing after replacing a lazy command placeholder. */
export async function reparseProgramFromActionCommand(
  program: Command,
  actionCommand: Command,
): Promise<void> {
  const rootProgram = findRootCommand(actionCommand) as Command & { rawArgs: string[] };
  // Commander 15 snapshots the full parse input on the root before actions run.
  const parseArgv = buildParseArgv(rootProgram.rawArgs, rootProgram.name());
  const normalizedArgv = hoistLazyParentOptions(parseArgv, program, actionCommand.name());
  await rootProgram.parseAsync(normalizedArgv);
}
