import { isPlainObject } from "../infra/plain-object.js";
import type { CommandsConfig } from "./types.js";

export type CommandFlagKey = {
  [K in keyof CommandsConfig]-?: Exclude<CommandsConfig[K], undefined> extends boolean ? K : never;
}[keyof CommandsConfig];

function getOwnCommandFlagValue(
  config: { commands?: unknown } | undefined,
  key: CommandFlagKey,
): unknown {
  const { commands } = config ?? {};
  if (!isPlainObject(commands) || !Object.hasOwn(commands, key)) {
    return undefined;
  }
  return commands[key];
}

export function isCommandFlagEnabled(
  config: { commands?: unknown } | undefined,
  key: CommandFlagKey,
): boolean {
  return getOwnCommandFlagValue(config, key) === true;
}

export function isModelsWriteEnabled(config?: { commands?: unknown }): boolean {
  return getOwnCommandFlagValue(config, "modelsWrite") !== false;
}

export function isRestartEnabled(config?: { commands?: unknown }): boolean {
  return getOwnCommandFlagValue(config, "restart") !== false;
}
