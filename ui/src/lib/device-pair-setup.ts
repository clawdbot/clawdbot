// Shared mobile pairing setup state for app-level entry points.
import type { DevicePairSetupCodeResult } from "../../../packages/gateway-protocol/src/index.js";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type DevicePairSetup = DevicePairSetupCodeResult;
export type DevicePairSetupAccess = "full" | "limited" | "node";

export function requestDevicePairJoinSetup(client: GatewayRequestClient) {
  return client.request<DevicePairSetup>("device.pair.setupCode", {
    includeQr: false,
    joinUrl: true,
  });
}

type DevicePairSetupState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  devicePairSetupOpen: boolean;
  devicePairSetupLoading: boolean;
  devicePairSetupError: string | null;
  devicePairSetup: DevicePairSetup | null;
  devicePairSetupAccess: DevicePairSetupAccess;
  devicePairSetupTimer: ReturnType<typeof setInterval> | null;
};

type DevicePairSetupOverlayState = DevicePairSetupState & { pendingCount: number };

export function createDevicePairSetupState(params: {
  client: DevicePairSetupState["client"];
  connected: boolean;
}): DevicePairSetupOverlayState {
  return {
    ...params,
    devicePairSetupOpen: false,
    devicePairSetupLoading: false,
    devicePairSetupError: null,
    devicePairSetup: null,
    devicePairSetupAccess: "full",
    devicePairSetupTimer: null,
    pendingCount: 0,
  };
}

export function readDevicePairSetupSnapshot(state: DevicePairSetupOverlayState) {
  return {
    devicePairSetupOpen: state.devicePairSetupOpen,
    devicePairSetupLoading: state.devicePairSetupLoading,
    devicePairSetupError: state.devicePairSetupError,
    devicePairSetup: state.devicePairSetup,
    devicePairSetupAccess: state.devicePairSetupAccess,
    devicePairPendingCount: state.pendingCount,
  };
}

function stopDevicePairSetupCountdown(state: DevicePairSetupState) {
  if (state.devicePairSetupTimer) {
    clearInterval(state.devicePairSetupTimer);
    state.devicePairSetupTimer = null;
  }
}

export function syncDevicePairSetupCountdown(state: DevicePairSetupState, onTick: () => void) {
  stopDevicePairSetupCountdown(state);
  const expiresAtMs = state.devicePairSetup?.expiresAtMs;
  if (
    state.devicePairSetupAccess !== "node" ||
    !state.devicePairSetupOpen ||
    typeof expiresAtMs !== "number" ||
    expiresAtMs <= Date.now()
  ) {
    return;
  }
  state.devicePairSetupTimer = setInterval(() => {
    if (!state.devicePairSetupOpen || expiresAtMs <= Date.now()) {
      stopDevicePairSetupCountdown(state);
    }
    onTick();
  }, 1_000);
}

const devicePairSetupRequests = new WeakMap<DevicePairSetupState, object>();

export async function openDevicePairSetup(state: DevicePairSetupState) {
  state.devicePairSetupOpen = true;
}

export async function refreshDevicePairSetup(state: DevicePairSetupState) {
  const client = state.client;
  if (!client || !state.connected || state.devicePairSetupLoading) {
    return;
  }
  const requestToken = {};
  devicePairSetupRequests.set(state, requestToken);
  state.devicePairSetupLoading = true;
  state.devicePairSetupError = null;
  try {
    const result = await client.request<DevicePairSetup>(
      "device.pair.setupCode",
      state.devicePairSetupAccess === "full"
        ? {}
        : state.devicePairSetupAccess === "node"
          ? { bootstrapProfile: "node", includeQr: false }
          : { bootstrapProfile: "limited" },
    );
    if (
      devicePairSetupRequests.get(state) !== requestToken ||
      state.client !== client ||
      !state.connected ||
      !state.devicePairSetupOpen
    ) {
      return;
    }
    if (result.access === "full" || result.access === "limited" || result.access === "node") {
      state.devicePairSetupAccess = result.access;
    }
    state.devicePairSetup = result;
  } catch (err) {
    if (
      devicePairSetupRequests.get(state) === requestToken &&
      state.client === client &&
      state.devicePairSetupOpen
    ) {
      state.devicePairSetupError = String(err);
    }
  } finally {
    // A retired request must not clear the loading state of a replacement request.
    if (devicePairSetupRequests.get(state) === requestToken) {
      devicePairSetupRequests.delete(state);
      state.devicePairSetupLoading = false;
    }
  }
}

export async function setDevicePairSetupAccess(
  state: DevicePairSetupState,
  access: DevicePairSetupAccess,
) {
  if (
    state.devicePairSetupAccess === access ||
    state.devicePairSetupLoading ||
    state.devicePairSetup !== null
  ) {
    return;
  }
  // Choose access before minting a bearer setup credential. Once a code exists,
  // closing the dialog starts a fresh selection instead of implying revocation.
  state.devicePairSetupAccess = access;
  state.devicePairSetupError = null;
}

export function closeDevicePairSetup(state: DevicePairSetupState) {
  stopDevicePairSetupCountdown(state);
  devicePairSetupRequests.delete(state);
  state.devicePairSetupOpen = false;
  state.devicePairSetupLoading = false;
  state.devicePairSetupError = null;
  state.devicePairSetup = null;
  state.devicePairSetupAccess = "full";
}
