// Gateway RPC handler for asynchronous node invocation results.
import {
  ErrorCodes,
  errorShape,
  validateNodeInvokeResultParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { GatewayRequestHandler } from "./types.js";
import { assertValidParams } from "./validation.js";

function normalizeNodeInvokeResultParams(params: unknown): unknown {
  if (!params || typeof params !== "object") {
    return params;
  }
  const raw = params as Record<string, unknown>;
  const normalized: Record<string, unknown> = { ...raw };
  if (normalized.payloadJSON === null) {
    delete normalized.payloadJSON;
  } else if (normalized.payloadJSON !== undefined && typeof normalized.payloadJSON !== "string") {
    if (normalized.payload === undefined) {
      normalized.payload = normalized.payloadJSON;
    }
    delete normalized.payloadJSON;
  }
  if (normalized.error === null) {
    delete normalized.error;
  }
  return normalized;
}

/** Handle a node's response to an earlier gateway `node.invoke` request. */
export const handleNodeInvokeResult: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  const normalizedParams = normalizeNodeInvokeResultParams(params);
  if (
    !assertValidParams(
      normalizedParams,
      validateNodeInvokeResultParams,
      "node.invoke.result",
      respond,
    )
  ) {
    return;
  }
  const p = normalizedParams;
  const callerNodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
  if (callerNodeId && callerNodeId !== p.nodeId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId mismatch"));
    return;
  }

  const ok = context.nodeRegistry.handleInvokeResult({
    id: p.id,
    nodeId: p.nodeId,
    connId: client?.connId,
    ok: p.ok,
    payload: p.payload,
    payloadJSON: p.payloadJSON ?? null,
    error: p.error ?? null,
  });
  if (!ok) {
    // Late-arriving results (after invoke timeout) are expected and harmless.
    // Return success instead of error to reduce log noise; client can discard.
    context.logGateway.debug(`late invoke result ignored: id=${p.id} node=${p.nodeId}`);
    respond(true, { ok: true, ignored: true }, undefined);
    return;
  }

  respond(true, { ok: true }, undefined);
};
