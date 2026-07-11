import type { NodePluginToolDescriptor } from "../../packages/gateway-protocol/src/schema/nodes.js";

/** Node record returned by gateway node-list endpoints. */
export type NodeListNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  clientId?: string;
  clientMode?: string;
  remoteIp?: string;
  deviceFamily?: string;
  modelIdentifier?: string;
  pathEnv?: string;
  caps?: string[];
  commands?: string[];
  nodePluginTools?: NodePluginToolDescriptor[];
  permissions?: Record<string, boolean>;
  approvalState?: "approved" | "pending-approval" | "pending-reapproval" | "unapproved";
  pendingRequestId?: string;
  pendingDeclaredCaps?: string[];
  pendingDeclaredCommands?: string[];
  pendingDeclaredPermissions?: Record<string, boolean>;
  paired?: boolean;
  connected?: boolean;
  connectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
  approvedAtMs?: number;
};

/** Pending pairing/access request shown to operators. */
export type PendingRequest = {
  requestId: string;
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  ts: number;
  commands?: string[];
  requiredApproveScopes?: Array<"operator.pairing" | "operator.write" | "operator.admin">;
};

/** Persisted paired node entry with permission metadata. */
export type PairedNode = {
  nodeId: string;
  displayName?: string;
  platform?: string;
  version?: string;
  coreVersion?: string;
  uiVersion?: string;
  remoteIp?: string;
  permissions?: Record<string, boolean>;
  createdAtMs?: number;
  approvedAtMs?: number;
  lastConnectedAtMs?: number;
  lastSeenAtMs?: number;
  lastSeenReason?: string;
};

/** Combined pairing list result used by CLI/UI node approval surfaces. */
export type PairingList = {
  pending: PendingRequest[];
  paired: PairedNode[];
};
