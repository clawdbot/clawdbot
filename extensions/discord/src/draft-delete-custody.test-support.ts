// Discord test support resets the intentionally cross-loader draft-delete
// custody registry, mirroring the thread-bindings test-support pattern.
type CustodyTestAccountState = {
  pending: unknown[];
  retryTimer: ReturnType<typeof setTimeout> | undefined;
};

type CustodyTestState = {
  byAccount: Map<string, CustodyTestAccountState>;
};

const CUSTODY_STATE_KEY = Symbol.for("openclaw.discordDraftDeleteCustodyState");

export function resetDiscordDraftDeleteCustodyForTest(): void {
  const globalStore = globalThis as Record<PropertyKey, unknown>;
  const state = globalStore[CUSTODY_STATE_KEY] as CustodyTestState | undefined;
  if (!state) {
    return;
  }
  for (const custody of state.byAccount.values()) {
    if (custody.retryTimer) {
      clearTimeout(custody.retryTimer);
    }
  }
  state.byAccount.clear();
}
