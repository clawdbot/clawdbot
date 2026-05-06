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
