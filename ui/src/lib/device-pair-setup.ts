// Shared mobile pairing setup state for app-level entry points.
import type { DevicePairSetupCodeResult } from "../../../packages/gateway-protocol/src/index.js";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type DevicePairSetup = DevicePairSetupCodeResult;
export type DevicePairSetupAccess = "full" | "limited";

type DevicePairSetupState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  devicePairSetupOpen: boolean;
  devicePairSetupLoading: boolean;
  devicePairSetupError: string | null;
  devicePairSetup: DevicePairSetup | null;
  devicePairSetupAccess: DevicePairSetupAccess;
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
      state.devicePairSetupAccess === "limited" ? { bootstrapProfile: "limited" } : {},
    );
    if (
      devicePairSetupRequests.get(state) !== requestToken ||
      state.client !== client ||
      !state.connected ||
      !state.devicePairSetupOpen
    ) {
      return;
    }
    if (result.access === "full" || result.access === "limited") {
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
  devicePairSetupRequests.delete(state);
  state.devicePairSetupOpen = false;
  state.devicePairSetupLoading = false;
  state.devicePairSetupError = null;
  state.devicePairSetup = null;
  state.devicePairSetupAccess = "full";
}
