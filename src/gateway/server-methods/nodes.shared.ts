import { ErrorCodes, errorShape } from "../../../packages/gateway-protocol/src/index.js";
import {
  isNodePairingGenerationCurrent,
  type NodePairingGeneration,
} from "../../infra/node-pairing-state.js";
import type { NodeSession } from "../node-registry.js";
import { isNodeWakeLifecycleCurrent, type NodeWakeLifecycle } from "../node-wake-state.js";
import type { RespondFn } from "./shared-types.js";

export function respondPairingChanged(respond: RespondFn) {
  respond(
    false,
    undefined,
    errorShape(ErrorCodes.UNAVAILABLE, "node pairing changed while invocation was active", {
      retryable: true,
      details: { code: "PAIRING_CHANGED" },
    }),
  );
}

export async function isNodePairingWorkCurrent(params: {
  nodeId: string;
  generation: NodePairingGeneration;
  lifecycle: NodeWakeLifecycle;
}): Promise<boolean> {
  if (!isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle, params.generation.key)) {
    return false;
  }
  if (!(await isNodePairingGenerationCurrent(params.generation))) {
    return false;
  }
  // Pairing mutation owners invalidate the lifecycle after persistence. Check
  // it again because the keyed generation lookup may yield before side effects.
  return isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle, params.generation.key);
}

export async function isNodePushAttemptCurrent(params: {
  nodeId: string;
  lifecycle: NodeWakeLifecycle;
  generation?: NodePairingGeneration;
}): Promise<boolean> {
  return params.generation
    ? isNodePairingWorkCurrent({
        nodeId: params.nodeId,
        generation: params.generation,
        lifecycle: params.lifecycle,
      })
    : isNodeWakeLifecycleCurrent(params.nodeId, params.lifecycle);
}

export function resolveDispatchableNodeSession(
  session: NodeSession | undefined,
): NodeSession | undefined {
  return session?.client?.invalidated === true ? undefined : session;
}
