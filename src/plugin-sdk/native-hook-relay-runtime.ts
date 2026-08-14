import type { RegisterNativeHookRelayParams } from "../agents/harness/native-hook-relay-types.js";
// Private retained native-hook relay capability for bundled runtime owners.
import {
  registerRetainedNativeHookRelay,
  type NativeHookRelayRetention,
} from "../agents/harness/native-hook-relay.js";

export type RetainedNativeHookRelayParams = RegisterNativeHookRelayParams & {
  retention: NativeHookRelayRetention;
};

/** Registers a bundled-only relay that may retain host policy for direct children. */
export function registerRetainedNativeHookRelayForBundledRuntime(
  params: RetainedNativeHookRelayParams,
) {
  return registerRetainedNativeHookRelay(params);
}
