// Host directory browsing for the new-session folder picker. Write-scoped
// callers stay inside configured agent workspaces; admin retains host access.
import { safeParseJson } from "@openclaw/normalization-core";
import {
  ErrorCodes,
  errorShape,
  missingScopeErrorShape,
  validateFsListDirParams,
  validateFsListDirResult,
} from "../../../packages/gateway-protocol/src/index.js";
import { listHostDirectories } from "../../infra/host-directory-listing.js";
import { NODE_FS_LIST_DIR_COMMAND } from "../../infra/node-commands.js";
import { errorShapeFromError } from "../error-shape.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import { ADMIN_SCOPE } from "../operator-scopes.js";
import type { GatewayRequestHandlers } from "./types.js";
import { resolveWorkspacePathContainment } from "./workspace-path-containment.js";

function parseNodePayload(payload: unknown, payloadJSON?: string | null): unknown {
  if (payloadJSON) {
    return safeParseJson(payloadJSON);
  }
  return payload;
}

export const fsHandlers: GatewayRequestHandlers = {
  "fs.listDir": async ({ params, respond, context, client }) => {
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
        const allowed = isNodeCommandAllowed({
          command: NODE_FS_LIST_DIR_COMMAND,
          declaredCommands: node.commands,
          allowlist: resolveNodeCommandAllowlist(context.getRuntimeConfig(), {
            ...node,
            approvedCommands: node.commands,
          }),
        });
        if (!allowed.ok) {
          respond(
            false,
            undefined,
            errorShape(
              ErrorCodes.INVALID_REQUEST,
              `node command not allowed: ${NODE_FS_LIST_DIR_COMMAND} (${allowed.reason})`,
              {
                details: { command: NODE_FS_LIST_DIR_COMMAND, reason: allowed.reason },
              },
            ),
          );
          return;
        }
        const result = await context.nodeRegistry.invoke({
          nodeId: params.nodeId,
          expectedConnId: node.connId,
          ...(node.pairingGeneration ? { expectedPairingGeneration: node.pairingGeneration } : {}),
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
      const scopes = Array.isArray(client?.connect.scopes) ? client.connect.scopes : [];
      if (scopes.includes(ADMIN_SCOPE)) {
        respond(true, await listHostDirectories(params.path), undefined);
        return;
      }
      const containment = await resolveWorkspacePathContainment(
        params.path?.trim() || undefined,
        context.getRuntimeConfig(),
        { allowMissing: true },
      );
      if (!containment) {
        respond(
          false,
          undefined,
          missingScopeErrorShape({ missingScope: ADMIN_SCOPE, requiredScopes: [ADMIN_SCOPE] }),
        );
        return;
      }
      const listing = await listHostDirectories(containment.path);
      if (listing.path === containment.workspaceRoot) {
        const { parent: _parent, ...clamped } = listing;
        respond(true, clamped, undefined);
        return;
      }
      respond(true, listing, undefined);
    } catch (error) {
      respond(false, undefined, errorShapeFromError(ErrorCodes.INVALID_REQUEST, error));
    }
  },
};
