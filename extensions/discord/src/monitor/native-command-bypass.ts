export function shouldBypassConfiguredAcpEnsure(commandName: string): boolean {
  // Recovery slash commands still need configured ACP readiness so stale dead
  // bindings are recreated before /new or /reset dispatches through them.
  return commandName.trim().toLowerCase() === "acp";
}

export function shouldBypassConfiguredAcpGuildGuards(commandName: string): boolean {
  const command = commandName.trim().toLowerCase();
  return command === "new" || command === "reset";
}
