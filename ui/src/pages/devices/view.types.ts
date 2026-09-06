import type { EnvironmentSummary, SystemInfoResult } from "@openclaw/gateway-protocol";
// Devices page view contracts.
import type { PresenceEntry } from "../../api/types.ts";
import type {
  DevicePairingList,
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
  InventoryRemovalRequest,
} from "../../lib/nodes/index.ts";

export type DevicesProps = {
  loading: boolean;
  nodes: Array<Record<string, unknown>>;
  presence: PresenceEntry[];
  gatewayVersion: string | null;
  basePath: string;
  gatewaySystemInfo?: SystemInfoResult | null;
  desktopEnvironments?: EnvironmentSummary[];
  lastError: string | null;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  canPairDevice: boolean;
  canManagePairing: boolean;
  canAdmin: boolean;
  configForm: Record<string, unknown> | null;
  configLoading: boolean;
  configSaving: boolean;
  configDirty: boolean;
  configFormMode: "form" | "raw";
  execApprovalsLoading: boolean;
  execApprovalsSaving: boolean;
  execApprovalsDirty: boolean;
  execApprovalsSnapshot: ExecApprovalsSnapshot | null;
  execApprovalsForm: ExecApprovalsFile | null;
  execApprovalsSelectedAgent: string | null;
  execApprovalsTarget: "gateway" | "node";
  execApprovalsTargetNodeId: string | null;
  onDevicePairSetupOpen: () => void;
  onDeviceApprove: (requestId: string) => void;
  onDeviceReject: (requestId: string) => void;
  /** Carries the row's resolved display name so the rotation outcome names the same
   *  device the operator just clicked, without rederiving the label precedence. */
  onDeviceRotate: (device: { id: string; name: string }, role: string, scopes?: string[]) => void;
  onDeviceRevoke: (deviceId: string, role: string) => void;
  /**
   * Opens the alias editor for one paired device. `operatorLabel` is the alias
   * currently stored for it, undefined while the device still shows its
   * self-reported name.
   */
  onDeviceRename: (device: { id: string; name: string; operatorLabel?: string }) => void;
  onNodeApprove: (requestId: string) => void;
  onNodeReject: (requestId: string) => void;
  onInventoryRemove: (entry: InventoryRemovalRequest) => void;
  onInventoryCleanup: (entries: InventoryRemovalRequest[]) => void;
  onLoadConfig: () => void;
  onLoadExecApprovals: () => void;
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentId: string, nodeId: string | null) => void;
  onSaveBindings: () => void;
  onExecApprovalsTargetChange: (kind: "gateway" | "node", nodeId: string | null) => void;
  onExecApprovalsSelectAgent: (agentId: string) => void;
  onExecApprovalsPatch: (path: Array<string | number>, value: unknown) => void;
  onExecApprovalsRemove: (path: Array<string | number>) => void;
  onSaveExecApprovals: () => void;
};
