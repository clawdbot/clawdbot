import { createSubsystemLogger } from "../logging/subsystem.js";

export type SessionDiscussionState = "none" | "available" | "open";
export type SessionDiscussionInfo = {
  state: SessionDiscussionState;
  embedUrl?: string;
  openUrl?: string;
};
export type SessionDiscussionProvider = {
  id: string;
  info(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
  open(params: { sessionKey: string }): Promise<SessionDiscussionInfo>;
};

const log = createSubsystemLogger("plugins/session-discussion");
const SESSION_DISCUSSION_REGISTRY = Symbol.for("openclaw.sessionDiscussionRegistry");

type SessionDiscussionRegistry = {
  provider?: SessionDiscussionProvider;
};

function getRegistry(): SessionDiscussionRegistry {
  // The public SDK entrypoint and lazy gateway chunks may load separately;
  // a global symbol keeps them on the same process-wide provider slot.
  const globalStore = globalThis as typeof globalThis & {
    [SESSION_DISCUSSION_REGISTRY]?: SessionDiscussionRegistry;
  };
  return (globalStore[SESSION_DISCUSSION_REGISTRY] ??= {});
}

export function registerSessionDiscussionProvider(provider: SessionDiscussionProvider): void {
  const registry = getRegistry();
  if (registry.provider) {
    log.warn(`replacing session discussion provider ${registry.provider.id} with ${provider.id}`);
  }
  registry.provider = provider;
}

export function getSessionDiscussionProvider(): SessionDiscussionProvider | undefined {
  return getRegistry().provider;
}

/** Clears the process-wide provider before a new active plugin registry is assembled. */
export function clearSessionDiscussionProvider(): void {
  getRegistry().provider = undefined;
}

/** Restores the provider when a plugin registration transaction does not become active. */
export function restoreSessionDiscussionProvider(
  provider: SessionDiscussionProvider | undefined,
): void {
  getRegistry().provider = provider;
}
