// Gateway RPC handler for native hook relay invocation.
import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  invokeNativeHookRelay,
  type NativeHookRelayProcessResponse,
} from "../../agents/harness/native-hook-relay.js";
import type { GatewayRequestHandlers } from "./types.js";

/** Gateway request handlers for invoking registered native hook relays. */
export const nativeHookRelayHandlers: GatewayRequestHandlers = {
  "nativeHook.invoke": async ({ params, respond }) => {
    try {
      // Relay invocations are one-shot bridges into a live native harness.
      // Require the current generation so stale clients cannot post into a
      // newly registered relay with the same id.
      const result: NativeHookRelayProcessResponse = await invokeNativeHookRelay({
        provider: params.provider,
        relayId: params.relayId,
        generation: params.generation,
        event: params.event,
        rawPayload: params.rawPayload,
        requireGeneration: true,
      });
      respond(true, result);
    } catch (error) {
      respond(
        false,
        undefined,
        errorShape(
          ErrorCodes.INVALID_REQUEST,
          error instanceof Error ? error.message : "native hook relay failed",
        ),
      );
    }
  },
};
