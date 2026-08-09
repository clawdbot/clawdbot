// Shared mobile pairing setup state for app-level entry points.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DevicePairSetupCodeResult,
  DevicePairSetupCompletedEvent,
  DevicePairSetupStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

type DevicePairSetup = DevicePairSetupCodeResult;
export type DevicePairSetupAccess = "full" | "limited";
// Only the fields the modal actually shows. The event also carries deviceId and
// ts; validating what is never rendered would just be shipped dead weight.
type DevicePairSetupCompletion = Pick<DevicePairSetupCompletedEvent, "setupId" | "access"> & {
  deviceName?: string;
};

export type DevicePairSetupLifecycle =
  | { phase: "selection"; access: DevicePairSetupAccess }
  | { phase: "loading"; access: DevicePairSetupAccess }
  | { phase: "waiting"; access: DevicePairSetupAccess; setup: DevicePairSetup }
  | { phase: "error"; access: DevicePairSetupAccess; message: string }
  | {
      phase: "success";
      access: DevicePairSetupCompletion["access"];
      deviceName?: string;
    }
  | { phase: "expired"; access: DevicePairSetupAccess };

type DevicePairSetupState = {
  client: GatewayRequestClient | null;
  connected: boolean;
  devicePairSetupOpen: boolean;
  devicePairSetupLifecycle: DevicePairSetupLifecycle;
  devicePairSetupExpiryTimer: ReturnType<typeof setTimeout> | null;
  onDevicePairSetupChange: () => void;
};

type DevicePairSetupOverlayState = DevicePairSetupState & { pendingCount: number };

export function createDevicePairSetupState(params: {
  client: DevicePairSetupState["client"];
  connected: boolean;
  onChange?: () => void;
}): DevicePairSetupOverlayState {
  return {
    client: params.client,
    connected: params.connected,
    devicePairSetupOpen: false,
    devicePairSetupLifecycle: { phase: "selection", access: "full" },
    devicePairSetupExpiryTimer: null,
    onDevicePairSetupChange: params.onChange ?? (() => {}),
    pendingCount: 0,
  };
}

export function readDevicePairSetupSnapshot(state: DevicePairSetupOverlayState) {
  return {
    devicePairSetupOpen: state.devicePairSetupOpen,
    devicePairSetupLifecycle: state.devicePairSetupLifecycle,
    devicePairPendingCount: state.pendingCount,
  };
}

// A refresh owns the lifecycle only while its token is current; replacement or close retires it.
const devicePairSetupRequests = new WeakMap<DevicePairSetupState, object>();

function clearDevicePairSetupExpiry(state: DevicePairSetupState) {
  if (state.devicePairSetupExpiryTimer !== null) {
    clearTimeout(state.devicePairSetupExpiryTimer);
    state.devicePairSetupExpiryTimer = null;
  }
}

async function readGatewaySetupCompletion(
  state: DevicePairSetupState,
  setupId: string,
): Promise<DevicePairSetupCompletion | null> {
  const client = state.client;
  if (!client || !state.connected) {
    return null;
  }
  try {
    const result = await client.request<DevicePairSetupStatusResult>("device.pair.setupStatus", {
      setupId,
    });
    return parseDevicePairSetupCompletion(result?.completion);
  } catch {
    return null;
  }
}

async function expireDevicePairSetup(state: DevicePairSetupState, setupId: string) {
  const active = state.devicePairSetupLifecycle;
  // A retired timer must never clear the replacement's timer or expire it.
  if (active.phase !== "waiting" || active.setup.setupId !== setupId) {
    return;
  }
  clearDevicePairSetupExpiry(state);
  // The completion broadcast is best-effort, so a redeemed credential can reach
  // its expiry with the event never delivered. Reconcile the gateway's recorded
  // outcome first or a successful pairing is presented as expired.
  const completion = await readGatewaySetupCompletion(state, setupId);
  if (completion && completeDevicePairSetup(state, completion)) {
    return;
  }
  const lifecycle = state.devicePairSetupLifecycle;
  if (lifecycle.phase !== "waiting" || lifecycle.setup.setupId !== setupId) {
    return;
  }
  state.devicePairSetupLifecycle = { phase: "expired", access: lifecycle.access };
  state.onDevicePairSetupChange();
}

function scheduleDevicePairSetupExpiry(state: DevicePairSetupState, setup: DevicePairSetup) {
  clearDevicePairSetupExpiry(state);
  const expire = () => {
    // Re-check wall time and setup identity so clock shifts or a retired timer cannot expire a replacement.
    const remainingMs = setup.expiresAtMs - Date.now();
    if (remainingMs > 0) {
      state.devicePairSetupExpiryTimer = setTimeout(expire, remainingMs);
      return;
    }
    void expireDevicePairSetup(state, setup.setupId);
  };
  expire();
}

export function parseDevicePairSetupCompletion(payload: unknown): DevicePairSetupCompletion | null {
  if (!isRecord(payload)) {
    return null;
  }
  const { setupId, deviceName, access } = payload;
  if (
    typeof setupId !== "string" ||
    setupId.length === 0 ||
    (access !== "full" && access !== "limited" && access !== "node")
  ) {
    return null;
  }
  const label = typeof deviceName === "string" ? deviceName.trim() : "";
  return { setupId, access, ...(label ? { deviceName: label } : {}) };
}

export function completeDevicePairSetup(
  state: DevicePairSetupState,
  completion: DevicePairSetupCompletion,
): boolean {
  const lifecycle = state.devicePairSetupLifecycle;
  if (lifecycle.phase !== "waiting" || lifecycle.setup.setupId !== completion.setupId) {
    return false;
  }
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupLifecycle = {
    phase: "success",
    access: completion.access,
    ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
  };
  state.onDevicePairSetupChange();
  return true;
}

export async function openDevicePairSetup(state: DevicePairSetupState) {
  state.devicePairSetupOpen = true;
}

export async function refreshDevicePairSetup(state: DevicePairSetupState) {
  const client = state.client;
  const lifecycle = state.devicePairSetupLifecycle;
  const access = lifecycle.access === "limited" ? "limited" : "full";
  if (!client || !state.connected || state.devicePairSetupLifecycle.phase === "loading") {
    return;
  }
  const requestToken = {};
  devicePairSetupRequests.set(state, requestToken);
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupLifecycle = { phase: "loading", access };
  try {
    const result = await client.request<DevicePairSetup>(
      "device.pair.setupCode",
      access === "limited" ? { bootstrapProfile: "limited" } : {},
    );
    if (
      devicePairSetupRequests.get(state) !== requestToken ||
      state.client !== client ||
      !state.connected ||
      !state.devicePairSetupOpen
    ) {
      return;
    }
    const resolvedAccess = result.access === "limited" ? "limited" : access;
    state.devicePairSetupLifecycle = { phase: "waiting", access: resolvedAccess, setup: result };
    scheduleDevicePairSetupExpiry(state, result);
  } catch (err) {
    if (
      devicePairSetupRequests.get(state) === requestToken &&
      state.client === client &&
      state.devicePairSetupOpen
    ) {
      state.devicePairSetupLifecycle = { phase: "error", access, message: String(err) };
    }
  } finally {
    if (devicePairSetupRequests.get(state) === requestToken) {
      devicePairSetupRequests.delete(state);
    }
  }
}

export async function setDevicePairSetupAccess(
  state: DevicePairSetupState,
  access: DevicePairSetupAccess,
) {
  if (
    (state.devicePairSetupLifecycle.phase !== "selection" &&
      state.devicePairSetupLifecycle.phase !== "error") ||
    state.devicePairSetupLifecycle.access === access
  ) {
    return;
  }
  state.devicePairSetupLifecycle = { phase: "selection", access };
}

export function closeDevicePairSetup(state: DevicePairSetupState) {
  devicePairSetupRequests.delete(state);
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupOpen = false;
  state.devicePairSetupLifecycle = { phase: "selection", access: "full" };
}
