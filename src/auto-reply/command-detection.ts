import { listChatCommands, normalizeCommandBody } from "./commands-registry.js";

export function hasControlCommand(text?: string): boolean {
  if (!text) return false;
  const trimmed = text.trim();
  if (!trimmed) return false;
  const normalizedBody = normalizeCommandBody(trimmed);
  if (!normalizedBody) return false;
  const lowered = normalizedBody.toLowerCase();
  for (const command of listChatCommands()) {
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
