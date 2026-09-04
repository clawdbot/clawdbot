// Keeps bounded session-subscription failure injection outside the shared PTY fixture.
export const TUI_PTY_SESSION_SUBSCRIPTION_FIXTURE_SCRIPT = `
  private sessionSubscriptionAttempts = 0;

  reconnectSessionSubscription() {
    if (process.env.OPENCLAW_TUI_PTY_SUBSCRIBE_RECONNECT !== "1") {
      return;
    }
    process.env.OPENCLAW_TUI_PTY_SUBSCRIBE_RECONNECT = "0";
    record("subscriptionReconnect");
    this.onDisconnected?.("fixture subscription reconnect");
    queueMicrotask(() => this.onConnected?.());
  }

  async subscribeSessionEvents() {
    record("subscribeSessionEvents");
    const configuredFailures = Number(process.env.OPENCLAW_TUI_PTY_SUBSCRIBE_FAILURES ?? 0);
    if (this.sessionSubscriptionAttempts++ < configuredFailures) {
      record("subscribeSessionFailure");
      throw new Error("fixture session subscription unavailable");
    }
    return { subscribed: true };
  }
`;
