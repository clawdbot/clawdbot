// Shared mobile pairing setup state for app-level entry points.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type {
  DevicePairSetupCodeResult,
  DevicePairSetupCompletedEvent,
  DevicePairSetupDeliveryUncertainEvent,
  DevicePairSetupStatusResult,
} from "../../../packages/gateway-protocol/src/index.js";

type GatewayRequestClient = {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
};

export type DevicePairSetup = DevicePairSetupCodeResult & {
  setupId: string;
  expiresAtMs: number;
};
export type DevicePairSetupAccess = "full" | "limited" | "node";
// Only the fields the modal actually shows. The event also carries deviceId and
// ts; validating what is never rendered would just be shipped dead weight.
type DevicePairSetupCompletion = Pick<DevicePairSetupCompletedEvent, "setupId" | "access"> & {
  deviceName?: string;
};
type DevicePairSetupDeliveryUncertain = Pick<
  DevicePairSetupDeliveryUncertainEvent,
  "setupId" | "access"
>;

export type DevicePairSetupLifecycle =
  | { phase: "selection"; access: DevicePairSetupAccess }
  | { phase: "loading"; access: DevicePairSetupAccess }
  | { phase: "waiting"; access: DevicePairSetupAccess; setup: DevicePairSetup }
  | {
      phase: "reconciling";
      access: DevicePairSetupAccess;
      setupId: string;
    }
  | { phase: "error"; source: "create"; access: DevicePairSetupAccess; message: string }
  | {
      phase: "error";
      source: "status";
      access: DevicePairSetupAccess;
      setupId: string;
      message: string;
    }
  | {
      phase: "success";
      access: DevicePairSetupCompletion["access"];
      deviceName?: string;
    }
  | {
      phase: "delivery-uncertain";
      access: DevicePairSetupDeliveryUncertain["access"];
    }
  | { phase: "expired"; access: DevicePairSetupAccess };
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
  devicePairSetupLifecycle: DevicePairSetupLifecycle;
  devicePairSetupExpiryTimer: ReturnType<typeof setTimeout> | null;
  devicePairSetupCountdownTimer: ReturnType<typeof setInterval> | null;
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
    devicePairSetupCountdownTimer: null,
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
function stopDevicePairSetupCountdown(state: DevicePairSetupState) {
  if (state.devicePairSetupCountdownTimer) {
    clearInterval(state.devicePairSetupCountdownTimer);
    state.devicePairSetupCountdownTimer = null;
  }
}

export function syncDevicePairSetupCountdown(state: DevicePairSetupState, onTick: () => void) {
  stopDevicePairSetupCountdown(state);
  const lifecycle = state.devicePairSetupLifecycle;
  const expiresAtMs = lifecycle.phase === "waiting" ? lifecycle.setup.expiresAtMs : undefined;
  if (
    lifecycle.access !== "node" ||
    !state.devicePairSetupOpen ||
    typeof expiresAtMs !== "number" ||
    expiresAtMs <= Date.now()
  ) {
    return;
  }
  state.devicePairSetupCountdownTimer = setInterval(() => {
    if (!state.devicePairSetupOpen || expiresAtMs <= Date.now()) {
      stopDevicePairSetupCountdown(state);
    }
    onTick();
  }, 1_000);
}

const devicePairSetupRequests = new WeakMap<DevicePairSetupState, object>();

function hasDevicePairSetupLifecycle(setup: DevicePairSetupCodeResult): setup is DevicePairSetup {
  return (
    typeof setup.setupId === "string" &&
    setup.setupId.length > 0 &&
    typeof setup.expiresAtMs === "number" &&
    Number.isInteger(setup.expiresAtMs) &&
    setup.expiresAtMs >= 0
  );
}

function clearDevicePairSetupExpiry(state: DevicePairSetupState) {
  if (state.devicePairSetupExpiryTimer !== null) {
    clearTimeout(state.devicePairSetupExpiryTimer);
    state.devicePairSetupExpiryTimer = null;
  }
}

type DevicePairSetupCompletionLookup =
  | { status: "found"; completion: DevicePairSetupCompletion }
  | { status: "delivery-uncertain"; outcome: DevicePairSetupDeliveryUncertain }
  | { status: "missing" }
  | { status: "unavailable"; message: string };

async function readGatewaySetupCompletion(
  state: DevicePairSetupState,
  setupId: string,
): Promise<DevicePairSetupCompletionLookup> {
  const client = state.client;
  if (!client || !state.connected) {
    return { status: "unavailable", message: "Gateway unavailable" };
  }
  try {
    const result = await client.request<DevicePairSetupStatusResult>("device.pair.setupStatus", {
      setupId,
    });
    if (result?.completion === undefined) {
      if (result?.deliveryUncertain === undefined) {
        return { status: "missing" };
      }
      const outcome = parseDevicePairSetupDeliveryUncertain(result.deliveryUncertain);
      return outcome?.setupId === setupId
        ? { status: "delivery-uncertain", outcome }
        : { status: "unavailable", message: "Invalid setup status response" };
    }
    const completion = parseDevicePairSetupCompletion(result.completion);
    return completion?.setupId === setupId
      ? { status: "found", completion }
      : { status: "unavailable", message: "Invalid setup status response" };
  } catch (err) {
    return { status: "unavailable", message: String(err) };
  }
}

function applyDevicePairSetupCompletionLookup(
  state: DevicePairSetupState,
  setupId: string,
  access: DevicePairSetupAccess,
  lookup: DevicePairSetupCompletionLookup,
): void {
  const lifecycle = state.devicePairSetupLifecycle;
  const ownsLifecycle =
    (lifecycle.phase === "waiting" && lifecycle.setup.setupId === setupId) ||
    (lifecycle.phase === "reconciling" && lifecycle.setupId === setupId) ||
    (lifecycle.phase === "error" && lifecycle.source === "status" && lifecycle.setupId === setupId);
  if (!ownsLifecycle) {
    return;
  }
  if (lookup.status === "found") {
    completeDevicePairSetup(state, lookup.completion);
    return;
  }
  if (lookup.status === "delivery-uncertain") {
    markDevicePairSetupDeliveryUncertain(state, lookup.outcome);
    return;
  }
  state.devicePairSetupLifecycle =
    lookup.status === "missing"
      ? { phase: "expired", access }
      : { phase: "error", source: "status", access, setupId, message: lookup.message };
  state.onDevicePairSetupChange();
}

async function expireDevicePairSetup(state: DevicePairSetupState, setupId: string) {
  const active = state.devicePairSetupLifecycle;
  // A retired timer must never clear the replacement's timer or expire it.
  if (active.phase !== "waiting" || active.setup.setupId !== setupId) {
    return;
  }
  clearDevicePairSetupExpiry(state);
  stopDevicePairSetupCountdown(state);
  const access = active.access;
  // Retire bearer presentation before the status round-trip. Correlation remains
  // so a delayed event or response can still settle this exact setup.
  state.devicePairSetupLifecycle = { phase: "reconciling", access, setupId };
  state.onDevicePairSetupChange();
  // The completion broadcast is best-effort, so a redeemed credential can reach
  // its expiry with the event never delivered. Reconcile the gateway's recorded
  // outcome first or a successful pairing is presented as expired.
  const completion = await readGatewaySetupCompletion(state, setupId);
  applyDevicePairSetupCompletionLookup(state, setupId, access, completion);
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

export function parseDevicePairSetupDeliveryUncertain(
  payload: unknown,
): DevicePairSetupDeliveryUncertain | null {
  const completion = parseDevicePairSetupCompletion(payload);
  return completion ? { setupId: completion.setupId, access: completion.access } : null;
}

export function completeDevicePairSetup(
  state: DevicePairSetupState,
  completion: DevicePairSetupCompletion,
): boolean {
  const lifecycle = state.devicePairSetupLifecycle;
  const matchesActiveSetup =
    (lifecycle.phase === "waiting" && lifecycle.setup.setupId === completion.setupId) ||
    (lifecycle.phase === "reconciling" && lifecycle.setupId === completion.setupId) ||
    (lifecycle.phase === "error" &&
      lifecycle.source === "status" &&
      lifecycle.setupId === completion.setupId);
  if (!matchesActiveSetup) {
    return false;
  }
  stopDevicePairSetupCountdown(state);
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupLifecycle = {
    phase: "success",
    access: completion.access,
    ...(completion.deviceName ? { deviceName: completion.deviceName } : {}),
  };
  state.onDevicePairSetupChange();
  return true;
}

export function markDevicePairSetupDeliveryUncertain(
  state: DevicePairSetupState,
  outcome: DevicePairSetupDeliveryUncertain,
): boolean {
  const lifecycle = state.devicePairSetupLifecycle;
  const matchesActiveSetup =
    (lifecycle.phase === "waiting" && lifecycle.setup.setupId === outcome.setupId) ||
    (lifecycle.phase === "reconciling" && lifecycle.setupId === outcome.setupId) ||
    (lifecycle.phase === "error" &&
      lifecycle.source === "status" &&
      lifecycle.setupId === outcome.setupId);
  if (!matchesActiveSetup) {
    return false;
  }
  stopDevicePairSetupCountdown(state);
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupLifecycle = {
    phase: "delivery-uncertain",
    access: outcome.access,
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
  const access = lifecycle.access;
  if (
    !client ||
    !state.connected ||
    state.devicePairSetupLifecycle.phase === "loading" ||
    devicePairSetupRequests.has(state)
  ) {
    return;
  }
  const requestToken = {};
  devicePairSetupRequests.set(state, requestToken);
  if (lifecycle.phase === "error" && lifecycle.source === "status") {
    const lookup = await readGatewaySetupCompletion(state, lifecycle.setupId);
    if (devicePairSetupRequests.get(state) === requestToken) {
      applyDevicePairSetupCompletionLookup(state, lifecycle.setupId, access, lookup);
      devicePairSetupRequests.delete(state);
    }
    return;
  }
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupLifecycle = { phase: "loading", access };
  try {
    const result = await client.request<DevicePairSetup>(
      "device.pair.setupCode",
      access === "full"
        ? {}
        : access === "node"
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
    if (!hasDevicePairSetupLifecycle(result)) {
      throw new Error(
        "Gateway does not provide pairing lifecycle metadata. Update the Gateway and try again.",
      );
    }
    const resolvedAccess =
      result.access === "full" || result.access === "limited" || result.access === "node"
        ? result.access
        : access;
    state.devicePairSetupLifecycle = { phase: "waiting", access: resolvedAccess, setup: result };
    scheduleDevicePairSetupExpiry(state, result);
  } catch (err) {
    if (
      devicePairSetupRequests.get(state) === requestToken &&
      state.client === client &&
      state.devicePairSetupOpen
    ) {
      state.devicePairSetupLifecycle = {
        phase: "error",
        source: "create",
        access,
        message: String(err),
      };
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
      (state.devicePairSetupLifecycle.phase !== "error" ||
        state.devicePairSetupLifecycle.source !== "create")) ||
    state.devicePairSetupLifecycle.access === access
  ) {
    return;
  }
  state.devicePairSetupLifecycle = { phase: "selection", access };
}

export function closeDevicePairSetup(state: DevicePairSetupState) {
  stopDevicePairSetupCountdown(state);
  devicePairSetupRequests.delete(state);
  clearDevicePairSetupExpiry(state);
  state.devicePairSetupOpen = false;
  state.devicePairSetupLifecycle = { phase: "selection", access: "full" };
}
