// Host directory browsing for the new-session folder picker. operator.admin
// only (see core-descriptors): listing arbitrary host paths carries the same
// trust as starting a session with an explicit cwd.
import {
  ErrorCodes,
  errorShape,
  validateFsListDirParams,
  validateFsListDirResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { listHostDirectories } from "../../infra/host-directory-listing.js";
import { NODE_FS_LIST_DIR_COMMAND } from "../../infra/node-commands.js";
import type { GatewayRequestHandlers } from "./types.js";

function parseNodePayload(payload: unknown, payloadJSON?: string | null): unknown {
  if (payloadJSON) {
    try {
      return JSON.parse(payloadJSON) as unknown;
    } catch {
      return undefined;
    }
  }
  return payload;
}

export const fsHandlers: GatewayRequestHandlers = {
  "fs.listDir": async ({ params, respond, context }) => {
    if (!validateFsListDirParams(params)) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "invalid fs parameters"));
      return;
    }
    try {
      if (params.nodeId) {
        const node = context.nodeRegistry.get(params.nodeId);
        if (!node) {
          respond(false, undefined, errorShape(ErrorCodes.UNAVAILABLE, "node not connected"));
          return;
        }
        if (!node.commands.includes(NODE_FS_LIST_DIR_COMMAND)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.INVALID_REQUEST, "node does not support directory browsing"),
          );
          return;
        }
        const result = await context.nodeRegistry.invoke({
          nodeId: params.nodeId,
          expectedConnId: node.connId,
          command: NODE_FS_LIST_DIR_COMMAND,
          params: params.path ? { path: params.path } : {},
        });
        if (!result.ok) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, result.error?.message ?? "node browse failed"),
          );
          return;
        }
        const payload = parseNodePayload(result.payload, result.payloadJSON);
        if (!validateFsListDirResult(payload)) {
          respond(
            false,
            undefined,
            errorShape(ErrorCodes.UNAVAILABLE, "node returned an invalid directory listing"),
          );
          return;
        }
        respond(true, payload, undefined);
        return;
      }
      respond(true, await listHostDirectories(params.path), undefined);
    } catch (error) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, String(error)));
    }
  },
};
