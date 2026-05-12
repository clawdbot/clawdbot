import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  NodePairingPairedNode,
  NodePairingRequestInput,
  RequestNodePairingResult,
} from "../infra/node-pairing.js";
import { normalizeArrayBackedTrimmedStringList } from "../shared/string-normalization.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodeCommandAllowlist,
} from "./node-command-policy.js";
import type { ConnectParams } from "./protocol/index.js";

export type NodeConnectPairingReconcileResult = {
  nodeId: string;
  effectiveCaps: string[];
  effectiveCommands: string[];
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
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

function normalizeApprovalSurfaceList(value: readonly string[] | undefined): string[] {
  return normalizeArrayBackedTrimmedStringList(value) ?? [];
}

function sameApprovalSurfaceSet(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined,
): boolean {
  const normalizedLeft = new Set(normalizeApprovalSurfaceList(left));
  const normalizedRight = new Set(normalizeApprovalSurfaceList(right));
  if (normalizedLeft.size !== normalizedRight.size) {
    return false;
  }
  for (const entry of normalizedLeft) {
    if (!normalizedRight.has(entry)) {
      return false;
    }
  }
  return true;
}

function normalizePermissionMap(
  value: Record<string, boolean> | undefined,
): Record<string, boolean> | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function samePermissions(
  left: Record<string, boolean> | undefined,
  right: Record<string, boolean> | undefined,
): boolean {
  const leftEntries = Object.entries(left ?? {}).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  const rightEntries = Object.entries(right ?? {}).toSorted(([leftKey], [rightKey]) =>
    leftKey.localeCompare(rightKey),
  );
  if (leftEntries.length !== rightEntries.length) {
    return false;
  }
  return leftEntries.every(([key, value], index) => {
    const rightEntry = rightEntries[index];
    return rightEntry !== undefined && rightEntry[0] === key && rightEntry[1] === value;
  });
}

function intersectApprovalSurfaceList(params: {
  approved: readonly string[] | undefined;
  declared: readonly string[];
}): string[] {
  const approved = new Set(normalizeApprovalSurfaceList(params.approved));
  return normalizeApprovalSurfaceList(params.declared).filter((entry) => approved.has(entry));
}

function intersectPermissionSurface(params: {
  approved: Record<string, boolean> | undefined;
  declared: Record<string, boolean> | undefined;
}): Record<string, boolean> | undefined {
  const entries: Array<[string, boolean]> = [];
  for (const [key, declaredValue] of Object.entries(params.declared ?? {})) {
    const approvedValue = params.approved?.[key];
    if (!declaredValue) {
      entries.push([key, false]);
      continue;
    }
    if (approvedValue === true) {
      entries.push([key, true]);
      continue;
    }
    if (approvedValue === false) {
      entries.push([key, false]);
    }
  }
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
}): NodePairingRequestInput {
  return {
    nodeId: params.nodeId,
    displayName: params.connectParams.client.displayName,
    platform: params.connectParams.client.platform,
    version: params.connectParams.client.version,
    deviceFamily: params.connectParams.client.deviceFamily,
    modelIdentifier: params.connectParams.client.modelIdentifier,
    caps: params.caps,
    commands: params.commands,
    permissions: params.permissions,
    remoteIp: params.remoteIp,
  };
}

export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  requestPairing: (input: NodePairingRequestInput) => Promise<RequestNodePairingResult>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const allowlist = resolveNodeCommandAllowlist(params.cfg, {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
    caps: params.connectParams.caps,
    commands: params.connectParams.commands,
  });
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    allowlist,
  });
  const declaredCaps = normalizeApprovalSurfaceList(params.connectParams.caps);
  const declaredPermissions = normalizePermissionMap(params.connectParams.permissions);

  if (!params.pairedNode) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        caps: declaredCaps,
        commands: declared,
        permissions: declaredPermissions,
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCaps: declaredCaps,
      effectiveCommands: declared,
      effectivePermissions: declaredPermissions,
      pendingPairing,
    };
  }

  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: params.pairedNode.commands,
    allowlist,
  });
  const approvedCaps = normalizeApprovalSurfaceList(params.pairedNode.caps);
  const approvedPermissions = normalizePermissionMap(params.pairedNode.permissions);
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));
  const hasCapabilityChange = !sameApprovalSurfaceSet(params.pairedNode.caps, declaredCaps);
  const hasPermissionChange = !samePermissions(params.pairedNode.permissions, declaredPermissions);
  const effectiveApprovedDeclaredCaps = intersectApprovalSurfaceList({
    approved: approvedCaps,
    declared: declaredCaps,
  });
  const effectiveApprovedDeclaredCommands = intersectApprovalSurfaceList({
    approved: approvedCommands,
    declared,
  });
  const effectiveApprovedDeclaredPermissions = intersectPermissionSurface({
    approved: approvedPermissions,
    declared: declaredPermissions,
  });

  if (hasCommandUpgrade || hasCapabilityChange || hasPermissionChange) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        caps: declaredCaps,
        commands: declared,
        permissions: declaredPermissions ?? (hasPermissionChange ? {} : undefined),
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      effectiveCaps: effectiveApprovedDeclaredCaps,
      effectiveCommands: effectiveApprovedDeclaredCommands,
      effectivePermissions: effectiveApprovedDeclaredPermissions,
      pendingPairing,
    };
  }

  return {
    nodeId,
    effectiveCaps: declaredCaps,
    effectiveCommands: declared,
    effectivePermissions: declaredPermissions,
  };
}
