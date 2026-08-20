// Facts Commander owns after parsing: the active path and which tokens became option values.
import type { Command, Option } from "commander";

const activeErrorCommandByRoot = new WeakMap<Command, Command>();
const lazyCommands = new WeakSet<Command>();

export function markCommanderLazyCommand(command: Command): void {
  lazyCommands.add(command);
}

function getCommandHierarchy(command: Command): Command[] {
  const hierarchy: Command[] = [];
  for (let current: Command | null = command; current; current = current.parent ?? null) {
    hierarchy.unshift(current);
  }
  return hierarchy;
}

function requiresFollowingValue(token: string, options: readonly Option[]): boolean {
  if (token.includes("=")) {
    return false;
  }
  const exact = options.find((option) => option.short === token || option.long === token);
  if (exact) {
    return exact.required;
  }
  if (!token.startsWith("-") || token.startsWith("--")) {
    return false;
  }
  const shortGroup = token.slice(1);
  for (let index = 0; index < shortGroup.length; index += 1) {
    const option = options.find((candidate) => candidate.short === `-${shortGroup[index]}`);
    if (!option) {
      return false;
    }
    if (option.required || option.optional) {
      return option.required && index === shortGroup.length - 1;
    }
  }
  return false;
}

/** Return whether Commander consumed one of the supplied argv tokens as a required option value. */
export function hasCommanderOptionValue(
  command: Command,
  argv: readonly string[],
  tokens: ReadonlySet<string>,
): boolean {
  const hierarchy = getCommandHierarchy(command);
  const args = argv.slice(2);
  let commandIndex = 0;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined || arg === "--") {
      break;
    }
    const nextCommand = hierarchy[commandIndex + 1];
    if (nextCommand && (arg === nextCommand.name() || nextCommand.aliases().includes(arg))) {
      commandIndex += 1;
      continue;
    }
    // The root program enables positional options, so after dispatch Commander
    // parses only the active command's options; ancestor flags there never reach pre-action.
    if (requiresFollowingValue(arg, hierarchy[commandIndex]?.options ?? [])) {
      const value = args[index + 1];
      if (value && tokens.has(value)) {
        return true;
      }
      index += 1;
    }
  }
  return false;
}

/** Return the registered command path for the exact Commander node handling an error or action. */
export function getCommanderCommandPath(command: Command): string[] {
  const commandPath: string[] = [];
  for (let current: Command | null = command; current?.parent; current = current.parent) {
    commandPath.unshift(current.name());
  }
  return commandPath;
}

function getRootCommand(command: Command): Command {
  let root = command;
  while (root.parent) {
    root = root.parent;
  }
  return root;
}

/** Classify a possible child token only after Commander owns its active command node. */
export function getCommanderSubcommandFact(
  command: Command,
  args: readonly string[],
): { kind: "defer" } | { kind: "unknown"; name: string } | undefined {
  const firstArgument = command.args[0];
  const matchesChild = command.commands.some(
    (child) => child.name() === firstArgument || child.aliases().includes(firstArgument ?? ""),
  );
  if (
    command.registeredArguments.length > 0 ||
    firstArgument === undefined ||
    firstArgument.startsWith("-") ||
    matchesChild
  ) {
    return undefined;
  }
  const helpRequested = args.includes("-h") || args.includes("--help");
  if (helpRequested && lazyCommands.has(command)) {
    return { kind: "defer" };
  }
  return command.commands.length > 0 ? { kind: "unknown", name: firstArgument } : undefined;
}

/** Scope the exact Commander node synchronously emitting an error. */
export function setCommanderErrorCommand(command: Command): () => void {
  const root = getRootCommand(command);
  const previous = activeErrorCommandByRoot.get(root);
  activeErrorCommandByRoot.set(root, command);
  return () => {
    if (previous) {
      activeErrorCommandByRoot.set(root, previous);
    } else {
      activeErrorCommandByRoot.delete(root);
    }
  };
}

/** Return the active parse-error path without replacing Commander's configured output handler. */
export function getCommanderErrorCommandPath(program: Command): string[] | undefined {
  const command = activeErrorCommandByRoot.get(getRootCommand(program));
  return command ? getCommanderCommandPath(command) : undefined;
}

/** Return visible children of the non-root command synchronously emitting a parse error. */
export function getCommanderErrorCommandNames(program: Command): string[] | undefined {
  const command = activeErrorCommandByRoot.get(getRootCommand(program));
  return command && getCommanderCommandPath(command).length
    ? command
        .createHelp()
        .visibleCommands(command)
        .flatMap((child) => child.aliases().concat(child.name()))
    : undefined;
}
