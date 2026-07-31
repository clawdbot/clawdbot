// Nodes page view contracts.
import type { PresenceEntry } from "../../api/types.ts";
import type {
  DevicePairingList,
  ExecApprovalsFile,
  ExecApprovalsSnapshot,
  InventoryRemovalRequest,
} from "../../lib/nodes/index.ts";

/**
 * Pending destructive inventory action awaiting in-page confirmation. Native
 * `window.confirm` silently returns false in webviews without a dialog bridge
 * (macOS app before the confirm-panel fix, Tauri), so the page renders its own
 * confirm dialog instead.
 */
export type InventoryRemovalPrompt =
  | { kind: "entry"; entry: InventoryRemovalRequest }
  | { kind: "stale"; entries: InventoryRemovalRequest[] };

export type NodesProps = {
  loading: boolean;
  nodes: Array<Record<string, unknown>>;
  presence: PresenceEntry[];
  gatewayVersion: string | null;
  lastError: string | null;
  devicesLoading: boolean;
  devicesError: string | null;
  devicesList: DevicePairingList | null;
  canPairDevice: boolean;
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
  onDeviceRotate: (deviceId: string, role: string, scopes?: string[]) => void;
  onDeviceRevoke: (deviceId: string, role: string) => void;
  onNodeApprove: (requestId: string) => void;
  onNodeReject: (requestId: string) => void;
  inventoryRemovalPrompt: InventoryRemovalPrompt | null;
  onInventoryRemove: (entry: InventoryRemovalRequest) => void;
  onInventoryCleanup: (entries: InventoryRemovalRequest[]) => void;
  onInventoryRemovalConfirm: () => void;
  onInventoryRemovalCancel: () => void;
  onLoadConfig: () => void;
  onLoadExecApprovals: () => void;
  onBindDefault: (nodeId: string | null) => void;
  onBindAgent: (agentIndex: number, nodeId: string | null) => void;
  onSaveBindings: () => void;
  onExecApprovalsTargetChange: (kind: "gateway" | "node", nodeId: string | null) => void;
  onExecApprovalsSelectAgent: (agentId: string) => void;
  onExecApprovalsPatch: (path: Array<string | number>, value: unknown) => void;
  onExecApprovalsRemove: (path: Array<string | number>) => void;
  onSaveExecApprovals: () => void;
};
