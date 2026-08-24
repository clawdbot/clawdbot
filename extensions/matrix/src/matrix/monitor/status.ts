// Matrix plugin module implements status behavior.
import type { ChannelAccountSnapshot } from "openclaw/plugin-sdk/channel-contract";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  channelBlockedPatch,
  channelReadyPatch,
  channelStoppedPatch,
  createTransportActivityStatusPatch,
} from "openclaw/plugin-sdk/gateway-runtime";
import { isMatrixAccessTokenInvalidatedError } from "../sdk/client-support.js";
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
  return formatErrorMessage(error);
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
    lifecycle: "starting",
  };

  const emit = () => {
    params.statusSink?.({
      ...status,
      lastDisconnect: cloneLastDisconnect(status.lastDisconnect),
    });
  };

  const noteConnected = (at = Date.now(), options?: { transportActivity?: boolean }) => {
    const lastConnectedAt = status.connected === true ? (status.lastConnectedAt ?? at) : at;
    Object.assign(
      status,
      channelReadyPatch({
        lastConnectedAt,
        lastEventAt: at,
        lastDisconnect: null,
        healthState: "healthy",
      }),
    );
    if (options?.transportActivity) {
      Object.assign(status, createTransportActivityStatusPatch(at));
    }
    emit();
  };

  const noteDisconnected = (paramsLocal: {
    state: MatrixSyncState;
    at?: number;
    error?: unknown;
  }) => {
    const at = paramsLocal.at ?? Date.now();
    const tokenInvalidated = isMatrixAccessTokenInvalidatedError(paramsLocal.error);
    if (status.lifecycle === "blocked" && status.terminalDisconnect === true && !tokenInvalidated) {
      // The invalidated-token diagnosis is authoritative until a ready sync proves recovery.
      // Late startup timeouts must not re-enable supervisor restarts or hide the auth failure.
      status.connected = false;
      status.lastEventAt = at;
      emit();
      return;
    }
    const error = formatSyncError(paramsLocal.error);
    status.connected = false;
    status.lastEventAt = at;
    status.lastDisconnect = {
      at,
      ...(error ? { error } : {}),
    };
    status.healthState = paramsLocal.state.toLowerCase();
    if (tokenInvalidated) {
      Object.assign(status, channelBlockedPatch(error ?? "Matrix access token invalidated"));
    } else {
      status.lastError = error;
      status.lifecycle = "recovering";
      status.terminalDisconnect = undefined;
    }
    emit();
  };

  emit();

  return {
    noteSyncState(state: MatrixSyncState, error?: unknown, at = Date.now()) {
      if (isMatrixReadySyncState(state)) {
        // matrix-js-sdk emits SYNCING after each successful /sync response.
        // PREPARED can be cache-backed and CATCHUP is a lifecycle bridge, so
        // neither should refresh transport liveness.
        noteConnected(at, { transportActivity: state === "SYNCING" });
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
      if (status.lifecycle !== "blocked" && status.healthState !== "error") {
        Object.assign(status, channelStoppedPatch({ lastEventAt: at, healthState: "stopped" }));
      } else {
        status.connected = false;
        status.lastEventAt = at;
      }
      emit();
    },
  };
}
