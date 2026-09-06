import type { ChatAbortControllerEntry } from "./chat-abort.js";

export function readLifecycleState(entry: ChatAbortControllerEntry) {
  return {
    projectSessionActive: entry.projectSessionActive,
    projectSessionTerminalPending: entry.projectSessionTerminalPending,
    projectSessionTerminalObservedAt: entry.projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence: entry.projectSessionTerminalPersistence,
    projectSessionTerminalPersisted: entry.projectSessionTerminalPersisted,
    registrationCleanupRequested: entry.registrationCleanupRequested,
  };
}

export function lifecycleState(
  projectSessionActive: boolean | undefined,
  projectSessionTerminalPending?: boolean,
  projectSessionTerminalObservedAt?: number,
  projectSessionTerminalPersistence?: Promise<void>,
  projectSessionTerminalPersisted?: boolean,
  registrationCleanupRequested?: boolean,
): ReturnType<typeof readLifecycleState> {
  return {
    projectSessionActive,
    projectSessionTerminalPending,
    projectSessionTerminalObservedAt,
    projectSessionTerminalPersistence,
    projectSessionTerminalPersisted,
    registrationCleanupRequested,
  };
}
