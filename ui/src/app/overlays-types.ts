import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { DevicePairSetupAccess, DevicePairSetupLifecycle } from "../lib/device-pair-setup.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "./exec-approval.ts";
import type { ApplicationStatusBanner, RecordedUpdateAttempt } from "./update-overlay-helpers.ts";

export type ApplicationOverlaySnapshot = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateRunning: boolean;
  updateStatusRefreshing: boolean;
  updateReconciliationPending: boolean;
  updateStatusBanner: ApplicationStatusBanner | null;
  recordedUpdateAttempt: RecordedUpdateAttempt | null;
  controlUiRefreshRequired: boolean;
  approvalQueue: readonly ExecApprovalRequest[];
  approvalBusy: boolean;
  approvalErrors: ReadonlyMap<string, string>;
  approvalNowMs: number;
  devicePairSetupOpen: boolean;
  devicePairSetupLifecycle: DevicePairSetupLifecycle;
  devicePairPendingCount: number;
};

export type ApplicationOverlays = {
  readonly snapshot: ApplicationOverlaySnapshot;
  subscribe: (listener: (snapshot: ApplicationOverlaySnapshot) => void) => () => void;
  refreshUpdateStatus: () => Promise<void>;
  runUpdate: () => Promise<void>;
  holdUpdate: () => Promise<boolean>;
  decideApproval: (decision: ExecApprovalDecision, approvalId?: string) => Promise<void>;
  openDevicePairSetup: () => Promise<boolean>;
  refreshDevicePairSetup: () => Promise<void>;
  setDevicePairSetupAccess: (access: DevicePairSetupAccess) => Promise<void>;
  closeDevicePairSetup: () => void;
  dispose: () => void;
};
