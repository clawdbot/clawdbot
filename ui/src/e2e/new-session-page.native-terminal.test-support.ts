export const TERMINAL_START_FEATURE_METHODS = [
  "chat.metadata",
  "chat.startup",
  "sessions.catalog.list",
  "sessions.catalog.startTerminal",
  "sessions.create",
  "sessions.title.prepare",
  "sessions.dispatch",
  "terminal.open",
  "worktrees.create",
] as const;

export function cliAgentCatalog(startTerminal: boolean) {
  return {
    id: "claude",
    label: "Claude Code",
    capabilities: {
      continueSession: true,
      archive: false,
      ...(startTerminal ? { startTerminal: true } : {}),
    },
    hosts: [
      {
        hostId: "gateway:local",
        label: "Local Claude Code",
        kind: "gateway",
        connected: true,
        canStartTerminal: startTerminal,
        sessions: [],
      },
    ],
  };
}
