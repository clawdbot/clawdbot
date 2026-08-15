// Discord plugin module implements gateway lifecycle behavior.
type GatewayTimer = NodeJS.Timeout;

export class GatewayHeartbeatTimers {
  heartbeatInterval?: GatewayTimer;
  firstHeartbeatTimeout?: GatewayTimer;

  private scheduleHeartbeatCycle(params: {
    intervalMs: number;
    isAcked: () => boolean;
    onAckTimeout: () => void;
    onHeartbeat: () => void;
  }): void {
    this.heartbeatInterval = setTimeout(() => {
      this.heartbeatInterval = undefined;
      if (!params.isAcked()) {
        params.onAckTimeout();
        return;
      }
      params.onHeartbeat();
      this.scheduleHeartbeatCycle(params);
    }, params.intervalMs);
    this.heartbeatInterval.unref?.();
  }

  start(params: {
    intervalMs: number;
    isAcked: () => boolean;
    onAckTimeout: () => void;
    onHeartbeat: () => void;
    random?: () => number;
  }): void {
    this.stop();
    const random = params.random ?? Math.random;
    this.firstHeartbeatTimeout = setTimeout(
      () => {
        this.firstHeartbeatTimeout = undefined;
        params.onHeartbeat();
        this.scheduleHeartbeatCycle(params);
      },
      Math.max(0, params.intervalMs * random()),
    );
    this.firstHeartbeatTimeout.unref?.();
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearTimeout(this.heartbeatInterval);
      this.heartbeatInterval = undefined;
    }
    if (this.firstHeartbeatTimeout) {
      clearTimeout(this.firstHeartbeatTimeout);
      this.firstHeartbeatTimeout = undefined;
    }
  }
}

export class GatewayReconnectTimer {
  timeout?: GatewayTimer;

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
  }

  schedule(delayMs: number, callback: () => void): void {
    this.stop();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      callback();
    }, delayMs);
    this.timeout.unref?.();
  }
}

/**
 * Monitors gateway disconnection duration. If the gateway stays disconnected
 * longer than the configured threshold (reconnect delay + 2x heartbeat
 * interval), forces a fresh connection cycle. This catches cases where the
 * event loop stalls past the reconnect window, leaving the gateway in
 * "reconnect scheduled" state indefinitely.
 *
 * The watchdog is separate from the reconnect timer — it is not stopped when
 * scheduleReconnect reschedules, so it survives reconnect retry cycles.
 */
export class GatewayConnectionWatchdog {
  private timeout?: GatewayTimer;
  private disconnectedAt?: number;

  start(thresholdMs: number, onTimeout: () => void): void {
    // Don't reset an existing watchdog — the deadline must survive across
    // reconnect retries so repeated failures don't indefinitely push it out.
    if (this.timeout) return;
    this.disconnectedAt = Date.now();
    this.timeout = setTimeout(() => {
      this.timeout = undefined;
      onTimeout();
    }, thresholdMs);
    this.timeout.unref?.();
  }

  stop(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = undefined;
    }
    this.disconnectedAt = undefined;
  }

  get elapsedMs(): number | undefined {
    return this.disconnectedAt !== undefined ? Date.now() - this.disconnectedAt : undefined;
  }
}
