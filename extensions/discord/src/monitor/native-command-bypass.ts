import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  // Recovery slash commands still need configured ACP readiness so stale dead
  // bindings are recreated before /new or /reset dispatches through them.
  return normalized === "acp";
}

export function shouldBypassConfiguredAcpGuildGuards(commandName: string): boolean {
  const normalized = normalizeLowercaseStringOrEmpty(commandName);
  return normalized === "new" || normalized === "reset";
}
