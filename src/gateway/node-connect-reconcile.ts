// Gateway node connect reconciliation.
// Computes approved runtime surfaces and pending pairing upgrades on reconnect.
import type { ConnectParams } from "../../packages/gateway-protocol/src/index.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeNodeApprovalSurfaceList } from "../infra/node-pairing-surface.js";
import type {
  NodePairingPairedNode,
  NodePairingRequestInput,
  RequestNodePairingResult,
} from "../infra/node-pairing.js";
import {
  normalizeDeclaredNodeCommands,
  resolveNodePairingCommandAllowlist,
} from "./node-command-policy.js";

// Node connect reconciliation turns declared caps/commands/permissions into the
// effective runtime surface. New or upgraded surfaces create a pending pairing
// request while already-approved surfaces are intersected with the declaration.
type NodeConnectPairingReconcileResult = {
  nodeId: string;
  declaredCaps: string[];
  effectiveCaps: string[];
  declaredCommands: string[];
  effectiveCommands: string[];
  declaredPermissions?: Record<string, boolean>;
  effectivePermissions?: Record<string, boolean>;
  pendingPairing?: RequestNodePairingResult;
  shouldClearPendingPairings?: boolean;
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

// Permissions are sorted before comparison/results so reconnects are stable
// even when clients send JSON object keys in different orders.
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

function intersectApprovalSurfaceList(params: {
  approved: readonly string[] | undefined;
  declared: readonly string[];
}): string[] {
  const approved = new Set(normalizeNodeApprovalSurfaceList(params.approved));
  return normalizeNodeApprovalSurfaceList(params.declared).filter((entry) => approved.has(entry));
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

function hasPermissionUpgrade(params: {
  approved: Record<string, boolean> | undefined;
  declared: Record<string, boolean> | undefined;
}): boolean {
  return Object.entries(params.declared ?? {}).some(
    ([key, declaredValue]) => declaredValue && params.approved?.[key] !== true,
  );
}

function buildNodePairingRequestInput(params: {
  nodeId: string;
  connectParams: ConnectParams;
  caps: string[];
  commands: string[];
  permissions?: Record<string, boolean>;
  remoteIp?: string;
  silent?: boolean;
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
    ...(params.silent ? { silent: true } : {}),
  };
}

/** Reconciles a connecting node against stored approval and requests pairing when needed. */
export async function reconcileNodePairingOnConnect(params: {
  cfg: OpenClawConfig;
  connectParams: ConnectParams;
  pairedNode: NodePairingPairedNode | null;
  reportedClientIp?: string;
  /**
   * Marks the first-surface capability request silent when device pairing was
   * approved non-interactively; approval UIs may then auto-approve it (macOS
   * SSH trust probe) instead of prompting. Upgrade requests stay interactive.
   */
  initialSurfaceSilent?: boolean;
  requestPairing: (input: NodePairingRequestInput) => Promise<RequestNodePairingResult | null>;
}): Promise<NodeConnectPairingReconcileResult> {
  const nodeId = params.connectParams.device?.id ?? params.connectParams.client.id;
  const policyNode = {
    platform: params.connectParams.client.platform,
    deviceFamily: params.connectParams.client.deviceFamily,
    caps: params.connectParams.caps,
    commands: params.connectParams.commands,
  };
  const pairingAllowlist = resolveNodePairingCommandAllowlist(params.cfg, policyNode);
  const declared = normalizeDeclaredNodeCommands({
    declaredCommands: Array.isArray(params.connectParams.commands)
      ? params.connectParams.commands
      : [],
    allowlist: pairingAllowlist,
  });
  const declaredCaps = normalizeNodeApprovalSurfaceList(params.connectParams.caps);
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
        silent: params.initialSurfaceSilent,
      }),
    );
    if (!pendingPairing) {
      throw new Error("node pairing request required");
    }
    return {
      nodeId,
      declaredCaps,
      effectiveCaps: [],
      declaredCommands: declared,
      effectiveCommands: [],
      declaredPermissions,
      effectivePermissions: undefined,
      pendingPairing,
    };
  }

  // Approved commands reconcile against the pairing allowlist: an approved
  // dangerous surface awaiting arming (e.g. computer.act without an
  // allowCommands entry) must not read as a pairing upgrade on every
  // reconnect. Invoke-time policy still gates every call on the runtime
  // allowlist, so keeping it effective here grants nothing by itself.
  const approvedCommands = resolveApprovedReconnectCommands({
    pairedCommands: params.pairedNode.commands,
    allowlist: pairingAllowlist,
  });
  const approvedCaps = normalizeNodeApprovalSurfaceList(params.pairedNode.caps);
  const approvedPermissions = normalizePermissionMap(params.pairedNode.permissions);
  const hasCommandUpgrade = declared.some((command) => !approvedCommands.includes(command));
  const hasCapabilityUpgrade = declaredCaps.some(
    (capability) => !approvedCaps.includes(capability),
  );
  const permissionUpgrade = hasPermissionUpgrade({
    approved: approvedPermissions,
    declared: declaredPermissions,
  });
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

  // Availability and permission loss only narrow the live surface. Reapproval
  // is required when a reconnect widens authority beyond the durable approval.
  if (hasCommandUpgrade || hasCapabilityUpgrade || permissionUpgrade) {
    const pendingPairing = await params.requestPairing(
      buildNodePairingRequestInput({
        nodeId,
        connectParams: params.connectParams,
        caps: declaredCaps,
        commands: declared,
        permissions: declaredPermissions ?? (permissionUpgrade ? {} : undefined),
        remoteIp: params.reportedClientIp,
      }),
    );
    return {
      nodeId,
      declaredCaps,
      effectiveCaps: effectiveApprovedDeclaredCaps,
      declaredCommands: declared,
      effectiveCommands: effectiveApprovedDeclaredCommands,
      declaredPermissions,
      effectivePermissions: effectiveApprovedDeclaredPermissions,
      ...(pendingPairing ? { pendingPairing } : {}),
    };
  }

  return {
    nodeId,
    declaredCaps,
    effectiveCaps: declaredCaps,
    declaredCommands: declared,
    effectiveCommands: declared,
    declaredPermissions,
    effectivePermissions: declaredPermissions,
    shouldClearPendingPairings: true,
  };
}
