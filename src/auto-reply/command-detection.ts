import type { ClawdbotConfig } from "../config/types.js";
import {
  type CommandNormalizeOptions,
  listChatCommands,
  listChatCommandsForConfig,
  normalizeCommandBody,
} from "./commands-registry.js";
import { isAbortTrigger } from "./reply/abort.js";

export function hasControlCommand(
  text?: string,
  cfg?: ClawdbotConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const normalizedBody = normalizeCommandBody(trimmed, options);
  if (!normalizedBody) return false;
  const lowered = normalizedBody.toLowerCase();
  const commands = cfg ? listChatCommandsForConfig(cfg) : listChatCommands();
  for (const command of commands) {
    for (const alias of command.textAliases) {
      const normalized = alias.trim().toLowerCase();
      if (!normalized) continue;
      if (lowered === normalized) return true;
      if (command.acceptsArgs && lowered.startsWith(normalized)) {
        const nextChar = normalizedBody.charAt(normalized.length);
        if (nextChar && /\s/.test(nextChar)) return true;
      }
    }
  }
  return false;
}

export function isControlCommandMessage(
  text?: string,
  cfg?: ClawdbotConfig,
  options?: CommandNormalizeOptions,
): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  if (hasControlCommand(trimmed, cfg, options)) return true;
  const normalized = normalizeCommandBody(trimmed, options).trim().toLowerCase();
  return isAbortTrigger(normalized);
}
