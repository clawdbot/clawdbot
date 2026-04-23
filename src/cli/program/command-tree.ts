import type { Command } from "commander";

export function removeCommand(program: Command, command: Command): boolean {
  const commands = program.commands as Command[];
  const index = commands.indexOf(command);
  if (index < 0) {
    return false;
  }
  commands.splice(index, 1);
  return true;
}

export function removeCommandByName(program: Command, name: string): boolean {
  const existing = program.commands.find(
    (command) => command.name() === name || command.aliases().includes(name),
  );
  if (!existing) {
    return false;
  }
  return removeCommand(program, existing);
}
