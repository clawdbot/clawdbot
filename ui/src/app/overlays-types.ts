import type { UpdateRunRecord } from "../../../src/infra/update-run-record.js";
import type { UpdateAvailable, UpdateScheduleState } from "../api/types.ts";
import type { DevicePairSetupAccess, DevicePairSetupLifecycle } from "../lib/device-pair-setup.ts";
import type { ExecApprovalDecision, ExecApprovalRequest } from "./exec-approval.ts";
import type { SubmittedUpdateReport } from "./update-failure-report.ts";
import type { ApplicationStatusBanner, RecordedUpdateAttempt } from "./update-overlay-helpers.ts";

export type UpdateFailureReportNotice = {
  attemptId: string;
  result: SubmittedUpdateReport | { message: string; status: "error" };
};

export type ApplicationUpdateOverlaySnapshot = {
  updateAvailable: UpdateAvailable | null;
  updateSchedule: UpdateScheduleState | null;
  heldUpdateCampaignId: string | null;
  updateRunning: boolean;
  updateStatusRefreshing: boolean;
  updateCampaignStatusHydrated: boolean;
  updateReconciliationPending: boolean;
  updateStatusBanner: ApplicationStatusBanner | null;
  recordedUpdateAttempt: RecordedUpdateAttempt | null;
  reportableUpdateFailureId: string | null;
  updateFailureReportBusy: boolean;
  updateFailureReportNotice: UpdateFailureReportNotice | null;
  updateRun: UpdateRunRecord | null;
  updateRunAcknowledged: boolean;
  controlUiRefreshRequired: boolean;
};

export type ApplicationOverlaySnapshot = ApplicationUpdateOverlaySnapshot & {
  approvalQueue: readonly ExecApprovalRequest[];
  approvalBusy: boolean;
  approvalCanGrant: boolean;
  approvalErrors: ReadonlyMap<string, string>;
  devicePairSetupOpen: boolean;
  devicePairSetupLifecycle: DevicePairSetupLifecycle;
  devicePairPendingCount: number;
};

export type ApplicationOverlays = {
  readonly snapshot: ApplicationOverlaySnapshot;
  subscribe: (listener: (snapshot: ApplicationOverlaySnapshot) => void) => () => void;
  refreshUpdateStatus: () => Promise<void>;
  acknowledgeUpdateRun: () => void;
  runUpdate: (options?: { sessionKey?: string }) => Promise<void>;
  holdUpdate: () => Promise<boolean>;
  reportUpdateFailure: (attemptId: string) => Promise<void>;
  decideApproval: (
    decision: ExecApprovalDecision,
    approvalId?: string,
    projectedApproval?: ExecApprovalRequest,
  ) => Promise<void>;
  openDevicePairSetup: () => Promise<boolean>;
  refreshDevicePairSetup: () => Promise<void>;
  setDevicePairSetupAccess: (access: DevicePairSetupAccess) => Promise<void>;
  closeDevicePairSetup: () => void;
  dispose: () => void;
};
