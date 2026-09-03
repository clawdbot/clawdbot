import type { EnvironmentSummary, SystemInfoResult } from "@openclaw/gateway-protocol";
import type { DevicesProps } from "../pages/devices/view.types.ts";

export const deviceSystemInfo: SystemInfoResult = {
  machineName: "Gateway",
  hostname: "gateway.test",
  platform: "darwin",
  release: "25.0.0",
  arch: "arm64",
  osLabel: "macOS 26.0",
  nodeVersion: "24.15.0",
  pid: 100,
  uptimeMs: 86_400_000,
  cpuCount: 8,
  loadAverage: [1.5, 1.2, 1],
  memoryTotalBytes: 32 * 1024 ** 3,
  memoryFreeBytes: 12 * 1024 ** 3,
};
export function createOfflineDeviceNode(nowMs = Date.now()) {
  return {
    nodeId: "offline-studio",
    displayName: "Offline Studio",
    platform: "darwin",
    paired: true,
    connected: false,
    caps: ["system", "file"],
    commands: ["system.run"],
    hostStats: {
      cpuCount: 24,
      loadAverage: [3.2, 2.8, 2.4],
      memoryTotalBytes: 192 * 1024 ** 3,
      memoryFreeBytes: 41 * 1024 ** 3,
      diskTotalBytes: 2 * 1024 ** 4,
      diskAvailableBytes: 1.2 * 1024 ** 4,
      updatedAtMs: nowMs - 27 * 86_400_000,
    },
  };
}

export const deviceDesktopEnvironments: EnvironmentSummary[] = [
  { id: "gateway", type: "host", status: "available", desktop: true },
];

export function createDevicesViewProps(overrides: Partial<DevicesProps> = {}): DevicesProps {
  return {
    loading: false,
    nodes: [],
    presence: [],
    gatewayVersion: null,
    basePath: "",
    lastError: null,
    devicesLoading: false,
    devicesError: null,
    devicesList: {
      pending: [],
      paired: [],
    },
    canPairDevice: true,
    canManagePairing: true,
    canAdmin: true,
    configForm: null,
    configLoading: false,
    configSaving: false,
    configDirty: false,
    configFormMode: "form",
    execApprovalsLoading: false,
    execApprovalsSaving: false,
    execApprovalsDirty: false,
    execApprovalsSnapshot: null,
    execApprovalsForm: null,
    execApprovalsSelectedAgent: null,
    execApprovalsTarget: "gateway",
    execApprovalsTargetNodeId: null,
    onDevicePairSetupOpen: () => undefined,
    onDeviceApprove: () => undefined,
    onDeviceReject: () => undefined,
    onDeviceRotate: () => undefined,
    onDeviceRevoke: () => undefined,
    onNodeApprove: () => undefined,
    onNodeReject: () => undefined,
    onInventoryRemove: () => undefined,
    onInventoryCleanup: () => undefined,
    onLoadConfig: () => undefined,
    onLoadExecApprovals: () => undefined,
    onBindDefault: () => undefined,
    onBindAgent: () => undefined,
    onSaveBindings: () => undefined,
    onExecApprovalsTargetChange: () => undefined,
    onExecApprovalsSelectAgent: () => undefined,
    onExecApprovalsPatch: () => undefined,
    onExecApprovalsRemove: () => undefined,
    onSaveExecApprovals: () => undefined,
    ...overrides,
  };
}
