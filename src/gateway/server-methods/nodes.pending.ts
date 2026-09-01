import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { normalizeUniqueTrimmedStringList } from "@openclaw/normalization-core/string-normalization";
import {
  ErrorCodes,
  errorShape,
  validateNodeListParams,
  validateNodePendingAckParams,
  type ConnectParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  captureNodePairingGeneration,
  isNodePairingGenerationCurrent,
} from "../../infra/device-pairing-node-state.js";
import { isNodeCommandAllowed, resolveNodeCommandAllowlist } from "../node-command-policy.js";
import {
  acknowledgePendingNodeActions,
  listPendingNodeActions,
  replacePendingNodeActionsForGeneration,
  type PendingNodeAction,
} from "../node-runtime-state.js";
import { nodeInvokePolicy } from "./nodes-policy.js";
import { respondUnavailableOnThrow } from "./nodes.helpers.js";
import { respondPairingChanged } from "./nodes.shared.js";
import type { GatewayRequestHandlers } from "./types.js";
import { assertValidParams } from "./validation.js";

function resolveAllowedPendingNodeActions(params: {
  nodeId: string;
  pairingGeneration: string;
  client: { connect?: ConnectParams | null } | null;
  cfg: OpenClawConfig;
}): PendingNodeAction[] {
  const pending = listPendingNodeActions({
    nodeId: params.nodeId,
    pairingGeneration: params.pairingGeneration,
    ttlMs: nodeInvokePolicy.pendingActionTtlMs,
  });
  if (pending.length === 0) {
    return pending;
  }
  // Re-filter queued actions against the node's current declared commands and
  // allowlist; app upgrades or permission changes can make old actions unsafe.
  const connect = params.client?.connect;
  const declaredCommands = Array.isArray(connect?.commands) ? connect.commands : [];
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: connect?.client?.platform,
    deviceFamily: connect?.client?.deviceFamily,
    caps: connect?.caps,
    commands: declaredCommands,
  });
  const allowed = pending.filter((entry) => {
    const result = isNodeCommandAllowed({
      command: entry.command,
      declaredCommands,
      allowlist,
    });
    return result.ok;
  });
  if (allowed.length !== pending.length) {
    replacePendingNodeActionsForGeneration({
      nodeId: params.nodeId,
      pairingGeneration: params.pairingGeneration,
      replacement: allowed,
      ttlMs: nodeInvokePolicy.pendingActionTtlMs,
    });
  }
  return allowed;
}

function ackPendingNodeActions(
  nodeId: string,
  ids: string[],
  pairingGeneration: string,
): PendingNodeAction[] {
  if (ids.length === 0) {
    return listPendingNodeActions({
      nodeId,
      pairingGeneration,
      ttlMs: nodeInvokePolicy.pendingActionTtlMs,
    });
  }
  return acknowledgePendingNodeActions({
    nodeId,
    pairingGeneration,
    ids,
    ttlMs: nodeInvokePolicy.pendingActionTtlMs,
  });
}

export function toPendingParamsJSON(params: unknown): string | undefined {
  if (params === undefined) {
    return undefined;
  }
  try {
    return JSON.stringify(params);
  } catch {
    return undefined;
  }
}

export const nodePendingActionHandlers: GatewayRequestHandlers = {
  "node.pending.pull": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateNodeListParams, "node.pending.pull", respond)) {
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }

    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(trimmedNodeId);
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const session = context.nodeRegistry.getForPairingGeneration(trimmedNodeId, generation.key);
      if (!session || session.connId !== client?.connId) {
        respondPairingChanged(respond);
        return;
      }
      const pending = resolveAllowedPendingNodeActions({
        nodeId: trimmedNodeId,
        pairingGeneration: generation.key,
        client,
        cfg: context.getRuntimeConfig(),
      });
      if (!(await isNodePairingGenerationCurrent(generation))) {
        respondPairingChanged(respond);
        return;
      }
      respond(
        true,
        {
          nodeId: trimmedNodeId,
          actions: pending.map((entry) => ({
            id: entry.id,
            command: entry.command,
            paramsJSON: entry.paramsJSON ?? null,
            enqueuedAtMs: entry.enqueuedAtMs,
          })),
        },
        undefined,
      );
    });
  },
  "node.pending.ack": async ({ params, respond, client, context }) => {
    if (!assertValidParams(params, validateNodePendingAckParams, "node.pending.ack", respond)) {
      return;
    }
    const nodeId = client?.connect?.device?.id ?? client?.connect?.client?.id;
    const trimmedNodeId = normalizeOptionalString(nodeId) ?? "";
    if (!trimmedNodeId) {
      respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "nodeId required"));
      return;
    }
    await respondUnavailableOnThrow(respond, async () => {
      const generation = await captureNodePairingGeneration(trimmedNodeId);
      if (!generation) {
        respondPairingChanged(respond);
        return;
      }
      const session = context.nodeRegistry.getForPairingGeneration(trimmedNodeId, generation.key);
      if (!session || session.connId !== client?.connId) {
        respondPairingChanged(respond);
        return;
      }
      const ackIds = normalizeUniqueTrimmedStringList(params.ids);
      const remaining = ackPendingNodeActions(trimmedNodeId, ackIds, generation.key);
      if (!(await isNodePairingGenerationCurrent(generation))) {
        respondPairingChanged(respond);
        return;
      }
      respond(
        true,
        {
          nodeId: trimmedNodeId,
          ackedIds: ackIds,
          remainingCount: remaining.length,
        },
        undefined,
      );
    });
  },
};
