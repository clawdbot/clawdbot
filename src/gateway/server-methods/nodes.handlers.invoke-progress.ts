// Gateway RPC handler for ordered node invocation progress.
import {
  ErrorCodes,
  errorShape,
  validateNodeInvokeProgressParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { respondInvalidParams } from "./nodes.helpers.js";
import type { GatewayRequestHandler } from "./types.js";

const MAX_PROGRESS_CHUNK_BYTES = 16 * 1024;

/** Accept one bounded stdout chunk for an active node invocation. */
export const handleNodeInvokeProgress: GatewayRequestHandler = async ({
  params,
  respond,
  context,
  client,
}) => {
  if (!validateNodeInvokeProgressParams(params)) {
    respondInvalidParams({
      respond,
      method: "node.invoke.progress",
      validator: validateNodeInvokeProgressParams,
    });
    return;
  }
  const progress = params as {
    invokeId: string;
    nodeId: string;
    seq: number;
    chunk: string;
  };
  const callerNodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
  if (callerNodeId && callerNodeId !== progress.nodeId) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId mismatch"));
    return;
  }
  if (Buffer.byteLength(progress.chunk, "utf8") > MAX_PROGRESS_CHUNK_BYTES) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "progress chunk too large"));
    return;
  }
  const accepted = context.nodeRegistry.handleInvokeProgress({
    ...progress,
    connId: client?.connId,
  });
  respond(true, { ok: true, ignored: !accepted }, undefined);
};
