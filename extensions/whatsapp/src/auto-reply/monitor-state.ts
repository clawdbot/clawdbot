import {
  createConnectedChannelStatusPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { WebChannelHealthState, WebChannelStatus } from "./types.js";

function cloneStatus(status: WebChannelStatus): WebChannelStatus {
  return {
    ...status,
    lastDisconnect: status.lastDisconnect ? { ...status.lastDisconnect } : null,
  };
}

function isTerminalHealthState(healthState: WebChannelHealthState | undefined): boolean {
  return healthState === "conflict" || healthState === "logged-out" || healthState === "stopped";
}

export function createWebChannelStatusController(statusSink?: (status: WebChannelStatus) => void) {
  const status: WebChannelStatus = {
    running: true,
    connected: false,
    reconnectAttempts: 0,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastInboundAt: null,
    lastMessageAt: null,
    lastEventAt: null,
    lastError: null,
    healthState: "starting",
  };

  const emit = () => {
    statusSink?.(cloneStatus(status));
  };

  return {
    emit,
    snapshot: () => status,
    noteConnected(at = Date.now()) {
      Object.assign(status, createConnectedChannelStatusPatch(at));
      Object.assign(status, createTransportActivityStatusPatch(at));
      status.lastError = null;
      status.healthState = "healthy";
      emit();
    },
    noteInbound(at = Date.now()) {
      status.lastInboundAt = at;
      status.lastMessageAt = at;
      status.lastEventAt = at;
      Object.assign(status, createTransportActivityStatusPatch(at));
      if (status.connected) {
        status.healthState = "healthy";
      }
      emit();
    },
    noteTransportActivity(at = Date.now()) {
      if (status.lastTransportActivityAt === at) {
        return;
      }
      Object.assign(status, createTransportActivityStatusPatch(at));
      emit();
    },
    noteWatchdogStale(at = Date.now()) {
      status.lastEventAt = at;
      if (status.connected) {
        status.healthState = "stale";
      }
      emit();
    },
    noteReconnectAttempts(reconnectAttempts: number) {
      status.reconnectAttempts = reconnectAttempts;
      emit();
    },
    noteClose(params: {
      at?: number;
      statusCode?: number;
      loggedOut?: boolean;
      error?: string;
      reconnectAttempts: number;
      healthState: WebChannelHealthState;
    }) {
      const at = params.at ?? Date.now();
      status.connected = false;
      status.lastEventAt = at;
      status.lastDisconnect = {
        at,
        status: params.statusCode,
        error: params.error,
        loggedOut: Boolean(params.loggedOut),
      };
      status.lastError = params.error ?? null;
      status.reconnectAttempts = params.reconnectAttempts;
      status.healthState = params.healthState;
      emit();
    },
    markStopped(at = Date.now()) {
      status.running = false;
      status.connected = false;
      status.lastEventAt = at;
      if (!isTerminalHealthState(status.healthState)) {
        status.healthState = "stopped";
      }
      emit();
    },
  };
}
