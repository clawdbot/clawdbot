// Discord test support resets the intentionally cross-loader thread-binding registry.
type ThreadBindingsTestState = {
  managersByAccountId: Map<string, { stop(): void }>;
  bindingsByThreadId: Map<string, unknown>;
  bindingsBySessionKey: Map<string, Set<string>>;
  tokensByAccountId: Map<string, string>;
  reusableWebhooksByAccountChannel: Map<string, unknown>;
  persistByAccountId: Map<string, boolean>;
  loadedBindings: boolean;
  loadedPersistentBindings: boolean;
  persistenceAvailable: boolean;
  lastPersistedAtMs: number;
};

const THREAD_BINDINGS_STATE_KEY = Symbol.for("openclaw.discordThreadBindingsState");

export function resetThreadBindingsForTests() {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[THREAD_BINDINGS_STATE_KEY] as ThreadBindingsTestState | undefined;
  if (!state) {
    return;
  }
  for (const manager of state.managersByAccountId.values()) {
    manager.stop();
  }
  state.managersByAccountId.clear();
  state.bindingsByThreadId.clear();
  state.bindingsBySessionKey.clear();
  state.reusableWebhooksByAccountChannel.clear();
  state.tokensByAccountId.clear();
  state.persistByAccountId.clear();
  state.loadedBindings = false;
  state.loadedPersistentBindings = false;
  state.persistenceAvailable = true;
  state.lastPersistedAtMs = 0;
}
