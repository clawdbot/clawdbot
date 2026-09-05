// Whatsapp plugin module implements monitor state behavior.
import {
  channelReadyPatch,
  channelStoppedPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import type { WebChannelHealthState, WebChannelStatus } from "./types.js";

const LIFECYCLE_BY_HEALTH_STATE = {
  starting: "starting",
  healthy: "ready",
  stale: "recovering",
  reconnecting: "recovering",
  conflict: "blocked",
  "logged-out": "blocked",
  stopped: "blocked", // Retry exhaustion is terminal; manual stops bypass this mapping.
} satisfies Record<WebChannelHealthState, NonNullable<WebChannelStatus["lifecycle"]>>;

const BUSY_ACTIVITY_HEARTBEAT_MS = 60_000;

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
  let lastDisconnectWasWatchdogRecovery = false;
  let busyActivityHeartbeat: ReturnType<typeof setInterval> | null = null;
  let busyWorkAwaitingConnection = false;
  let activeConnectionToken: symbol | null = null;
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
    busy: false,
    lastRunActivityAt: null,
    healthState: "starting",
    lifecycle: "starting",
  };

  const emit = () => {
    statusSink?.(cloneStatus(status));
  };

  const clearBusyActivityHeartbeat = () => {
    if (!busyActivityHeartbeat) {
      return;
    }
    clearInterval(busyActivityHeartbeat);
    busyActivityHeartbeat = null;
  };

  const ensureBusyActivityHeartbeat = () => {
    if (busyActivityHeartbeat || !status.connected || !status.busy) {
      return;
    }
    // Pending-work counts publish only on transitions, so a long-running handler
    // needs its own activity signal to remain distinguishable from a stuck run.
    busyActivityHeartbeat = setInterval(() => {
      if (!status.connected || !status.busy) {
        clearBusyActivityHeartbeat();
        return;
      }
      status.lastRunActivityAt = Date.now();
      emit();
    }, BUSY_ACTIVITY_HEARTBEAT_MS);
    busyActivityHeartbeat.unref?.();
  };

  const noteBusy = (busy: boolean, at = Date.now()) => {
    const changed = status.busy !== busy || status.lastRunActivityAt !== at;
    status.busy = busy;
    status.lastRunActivityAt = at;
    if (busy && status.connected) {
      // Only a current pending-work report may arm this timer. Reconnect must
      // not revive busy state inherited from the prior socket lifecycle.
      ensureBusyActivityHeartbeat();
    } else if (busy) {
      // Inbox attachment can admit work before the connection is published.
      // Carry that current setup fact to noteConnected, but never across close.
      busyWorkAwaitingConnection = true;
    } else {
      busyWorkAwaitingConnection = false;
      clearBusyActivityHeartbeat();
    }
    if (!changed) {
      return;
    }
    if (status.connected && busy) {
      status.healthState = "healthy";
      status.lifecycle = "ready";
    }
    emit();
  };

  return {
    emit,
    snapshot: () => status,
    beginConnectionSetup() {
      const token = Symbol();
      activeConnectionToken = token;
      return {
        noteBusy(busy: boolean, at = Date.now()) {
          if (activeConnectionToken !== token) {
            return;
          }
          noteBusy(busy, at);
        },
      };
    },
    noteConnected(at = Date.now()) {
      Object.assign(status, channelReadyPatch({ lastConnectedAt: at, lastEventAt: at }));
      Object.assign(status, createTransportActivityStatusPatch(at));
      if (lastDisconnectWasWatchdogRecovery) {
        status.lastDisconnect = null;
        status.reconnectAttempts = 0;
        lastDisconnectWasWatchdogRecovery = false;
      }
      status.healthState = "healthy";
      if (busyWorkAwaitingConnection) {
        busyWorkAwaitingConnection = false;
        ensureBusyActivityHeartbeat();
      }
      emit();
    },
    noteInbound(at = Date.now()) {
      status.lastInboundAt = at;
      status.lastMessageAt = at;
      status.lastEventAt = at;
      Object.assign(status, createTransportActivityStatusPatch(at));
      if (status.connected) {
        status.healthState = "healthy";
        status.lifecycle = "ready";
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
    noteBusy,
    noteWatchdogStale(at = Date.now()) {
      status.lastEventAt = at;
      if (status.connected) {
        status.healthState = "stale";
        status.lifecycle = "recovering";
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
      watchdogRecovery?: boolean;
    }) {
      const at = params.at ?? Date.now();
      clearBusyActivityHeartbeat();
      busyWorkAwaitingConnection = false;
      activeConnectionToken = null;
      lastDisconnectWasWatchdogRecovery = params.watchdogRecovery === true;
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
      status.lifecycle = LIFECYCLE_BY_HEALTH_STATE[params.healthState];
      emit();
    },
    markStopped(at = Date.now()) {
      clearBusyActivityHeartbeat();
      busyWorkAwaitingConnection = false;
      activeConnectionToken = null;
      const terminalDisconnect = status.lifecycle === "blocked";
      if (!isTerminalHealthState(status.healthState)) {
        Object.assign(status, channelStoppedPatch({ lastEventAt: at, terminalDisconnect }));
        status.healthState = "stopped";
      } else {
        Object.assign(status, {
          running: false,
          connected: false,
          lastEventAt: at,
          terminalDisconnect,
        });
      }
      emit();
    },
  };
}
