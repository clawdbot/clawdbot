type GatewayTimer = NodeJS.Timeout;

export class GatewayHeartbeatTimers {
  heartbeatInterval?: GatewayTimer;
  firstHeartbeatTimeout?: GatewayTimer;

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
      params.onHeartbeat,
      Math.max(0, params.intervalMs * random()),
    );
    this.firstHeartbeatTimeout.unref?.();
    this.heartbeatInterval = setInterval(() => {
      if (!params.isAcked()) {
        params.onAckTimeout();
        return;
      }
      params.onHeartbeat();
    }, params.intervalMs);
    this.heartbeatInterval.unref?.();
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
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
