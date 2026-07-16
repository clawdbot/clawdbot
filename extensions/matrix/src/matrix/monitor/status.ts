import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { createConnectedChannelStatusPatch } from "openclaw/plugin-sdk/gateway-runtime";
import { formatMatrixErrorMessage } from "../errors.js";
import {
  isMatrixDisconnectedSyncState,
  isMatrixReadySyncState,
  type MatrixSyncState,
} from "../sync-state.js";

type MatrixMonitorStatusSink = (patch: ChannelAccountSnapshot) => void;

function cloneLastDisconnect(
  value: ChannelAccountSnapshot["lastDisconnect"],
): ChannelAccountSnapshot["lastDisconnect"] {
  if (!value || typeof value === "string") {
    return value ?? null;
  }
  return { ...value };
}

function formatSyncError(error: unknown): string | null {
  if (!error) {
    return null;
  }
  if (error instanceof Error) {
    return error.message || error.name || "unknown";
  }
  return formatMatrixErrorMessage(error);
}

export type MatrixMonitorStatusController = ReturnType<typeof createMatrixMonitorStatusController>;

export function createMatrixMonitorStatusController(params: {
  accountId: string;
  baseUrl?: string;
  statusSink?: MatrixMonitorStatusSink;
}) {
  const status: ChannelAccountSnapshot = {
    accountId: params.accountId,
    ...(params.baseUrl ? { baseUrl: params.baseUrl } : {}),
    connected: false,
    lastConnectedAt: null,
    lastDisconnect: null,
    lastError: null,
    healthState: "starting",
  };

  const emit = () => {
    params.statusSink?.({
      ...status,
      lastDisconnect: cloneLastDisconnect(status.lastDisconnect),
    });
  };

  const noteConnected = (at = Date.now()) => {
    if (status.connected === true) {
      status.lastEventAt = at;
    } else {
      Object.assign(status, createConnectedChannelStatusPatch(at));
    }
    status.lastError = null;
    status.lastDisconnect = null;
    status.healthState = "healthy";
    emit();
  };

  const noteDisconnected = (params: { state: MatrixSyncState; at?: number; error?: unknown }) => {
    const at = params.at ?? Date.now();
    const error = formatSyncError(params.error);
    status.connected = false;
    status.lastEventAt = at;
    status.lastDisconnect = {
      at,
      ...(error ? { error } : {}),
    };
    status.lastError = error;
    status.healthState = params.state.toLowerCase();
    emit();
  };

  emit();

  return {
    noteSyncState(state: MatrixSyncState, error?: unknown, at = Date.now()) {
      if (isMatrixReadySyncState(state)) {
        noteConnected(at);
        return;
      }
      if (isMatrixDisconnectedSyncState(state)) {
        noteDisconnected({ state, at, error });
        return;
      }
      // Unknown future SDK states inherit the current connectivity bit until the
      // SDK classifies them as ready or disconnected. Avoid guessing here.
      status.lastEventAt = at;
      status.healthState = state.toLowerCase();
      emit();
    },
    noteUnexpectedError(error: unknown, at = Date.now()) {
      noteDisconnected({ state: "ERROR", at, error });
    },
    markStopped(at = Date.now()) {
      status.connected = false;
      status.lastEventAt = at;
      if (status.healthState !== "error") {
        status.healthState = "stopped";
      }
      emit();
    },
  };
}
