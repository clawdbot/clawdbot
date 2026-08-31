import type {
  ActiveNativeHookRelayRegistration,
  NativeHookRelaySharedState,
} from "./native-hook-relay-types.js";

const NATIVE_HOOK_RELAY_STATE_SYMBOL = Symbol.for("openclaw.nativeHookRelay.state");
export const MAX_NATIVE_HOOK_RELAY_INVOCATIONS = 200;

function getNativeHookRelaySharedState(): NativeHookRelaySharedState {
  const globalRecord = globalThis as typeof globalThis & {
    [key: symbol]: NativeHookRelaySharedState | undefined;
  };
  globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL] ??= {
    relays: new Map(),
    relayBridges: new Map(),
    invocations: [],
    pendingPermissionApprovals: new Map(),
    pendingPreToolUseApprovals: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

export const nativeHookRelayState = getNativeHookRelaySharedState();

// Upgrade shared state created by an older module copy that predates the
// registration slot map (duplicate module instances share this object via the
// global symbol, so the property can be missing at runtime).
export const nativeHookRelayRegistrationsById: Map<
  string,
  Set<ActiveNativeHookRelayRegistration>
> = (nativeHookRelayState.relayRegistrationsById ??= new Map());
