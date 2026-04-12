import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  NodePairingPairedNode,
  NodePairingPendingRequest,
  NodePairingRequestInput,
} from "../infra/node-pairing.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { ConnectParams } from "./protocol/index.js";

type PendingNodePairingResult = {
  status: "pending";
  request: NodePairingPendingRequest;
  created: boolean;
};

export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  effectiveCommands: string[];
  pendingPairing?: PendingNodePairingResult;
};

function resolveApprovedReconnectCommands(params: {
  pairedCommands: readonly string[] | undefined;
  allowlist: Set<string>;
}) {
  return normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.pairedCommands) ? params.pairedCommands : [],
    allowlist: params.allowlist,
  });
}

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  commands: string[];
  remoteIp?: string;
}): NodePairingRequestInput {
  return {
    nodeId: params.nodeId,
    displayName: params.connectParams.client.displayName,
    platform: params.connectParams.client.platform,
    version: params.connectParams.client.version,
    deviceFamily: params.connectParams.client.deviceFamily,
    modelIdentifier: params.connectParams.client.modelIdentifier,
    caps: params.connectParams.caps,
    commands: params.commands,
    remoteIp: params.remoteIp,
  };
}

export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<PendingNodePairingResult>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
  });
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    allowlist,
  });

  if (!params.pairedNode) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: declared,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCommands: declared,
      pendingPairing,
    };
  }

  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: params.pairedNode.commands,
    allowlist,
  });
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));

  if (hasCommandUpgrade) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        commands: declared,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCommands: approvedCommands,
      pendingPairing,
    };
  }

  return {
    nodeId,
    effectiveCommands: declared,
  };
}
