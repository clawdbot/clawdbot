import type { RegisterNativeHookRelayParams } from "../agents/harness/native-hook-relay-types.js";
// Private native-hook relay capabilities for bundled runtime owners.
import {
  registerNativeHookRelayForBundledRuntime,
  registerRetainedNativeHookRelay,
  type NativeHookRelayRetention,
} from "../agents/harness/native-hook-relay.js";

export { registerNativeHookRelayForBundledRuntime };

export type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  composeWithExistingRoute?: boolean;
  retention: NativeHookRelayRetention;
};

/** Registers a bundled-only relay that may retain host policy for direct children. */
export function registerRetainedNativeHookRelayForBundledRuntime(
  params: RetainedNativeHookRelayParams,
) {
  return registerRetainedNativeHookRelay(params);
}
