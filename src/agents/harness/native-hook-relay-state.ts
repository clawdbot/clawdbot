import type { NativeHookRelaySharedState } from "./native-hook-relay-types.js";

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
    approvalOwners: new WeakMap(),
    pendingPermissionApprovals: new Map(),
    pendingPermissionApprovalOwners: new Map(),
    pendingPreToolUseApprovals: new Map(),
    pendingPreToolUseApprovalOwners: new Map(),
    permissionApprovalWindows: new Map(),
    permissionAllowAlwaysApprovals: new Map(),
  };
  return globalRecord[NATIVE_HOOK_RELAY_STATE_SYMBOL];
}

export const nativeHookRelayState = getNativeHookRelaySharedState();
