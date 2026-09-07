import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type {
  WorkerDesktopEndpoint,
  WorkerProfile,
  WorkerSshEndpoint,
} from "../../plugins/capability-provider.types.js";
import type { WorkerSessionPlacementDispatchIdentity } from "./placement-record.js";
import type { WorkerEnvironmentLeasedState, WorkerEnvironmentUnleasedState } from "./state.js";

export type WorkerEnvironmentPreparation = {
  key: string;
  demandAtMs: number;
  expiresAtMs: number;
  consumedAtMs: number | null;
};
export type WorkerEnvironmentPreparationIntent = Omit<WorkerEnvironmentPreparation, "consumedAtMs">;
export type WorkerEnvironmentBootstrapReceipt = WorkerAdmissionHandshake & {
  /** Provenance only; admission authority remains the exact stored build identity. */
  installKind?: "bundle" | "local";
};
export type WorkerEnvironmentTeardownTerminalState = "destroyed" | "failed";
type RecordIdentity = { environmentId: string; providerId: string; profileId: string };
type RecordBase = RecordIdentity & {
  profileSnapshot: WorkerProfile;
  preparation: WorkerEnvironmentPreparation | null;
  provisionOperationId: string;
  nodeSetupId: string | null;
  nodeDeviceId: string | null;
  sharedHost: boolean | null;
  desktop: WorkerDesktopEndpoint | null;
  bootstrapReceipt: WorkerEnvironmentBootstrapReceipt | null;
  ownerEpoch: number;
  teardownTerminalState: WorkerEnvironmentTeardownTerminalState | null;
  attachedSessionIds: string[];
  lastError: string | null;
} & { createdAtMs: number; updatedAtMs: number; stateChangedAtMs: number } & {
  lastActivatedAtMs: number | null;
  idleSinceAtMs: number | null;
  destroyRequestedAtMs: number | null;
};
type UnleasedRecord = {
  state: WorkerEnvironmentUnleasedState;
  leaseId: null;
  sshEndpoint: null;
};
type LeasedRecord = {
  state: WorkerEnvironmentLeasedState;
  leaseId: string;
  sshEndpoint: WorkerSshEndpoint | null;
};
export type WorkerEnvironmentRecord = RecordBase & (UnleasedRecord | LeasedRecord);
export type WorkerEnvironmentCredentialInput = {
  credentialHash: string;
  sessionId: string | null;
  rpcSetVersion: number;
  expiresAtMs: number;
};
export type WorkerEnvironmentTransitionPatch = {
  leaseId?: string | null;
  nodeDeviceId?: string | null;
  sshEndpoint?: WorkerSshEndpoint | null;
  sharedHost?: boolean;
  desktop?: WorkerDesktopEndpoint | null;
  bootstrapReceipt?: WorkerEnvironmentBootstrapReceipt;
  attachedSessionIds?: readonly string[];
  lastError?: string | null;
  credential?: WorkerEnvironmentCredentialInput;
};
export type WorkerEnvironmentIntentInput = RecordIdentity & {
  preparation?: WorkerEnvironmentPreparationIntent;
  profileSnapshot: WorkerProfile;
  provisionOperationId: string;
};
export type PreparedEnvironmentPlacementBinding = WorkerSessionPlacementDispatchIdentity & {
  generation: number;
  preparationKey: string;
  assertCurrent: () => void;
};
export type PreparedEnvironmentSelection = WorkerSessionPlacementDispatchIdentity & {
  expectedGeneration: number;
  environmentId: string;
  ownerEpoch: number;
  providerId: string;
  profileId: string;
  preparationKey: string;
  nodeDeviceId: string;
  leaseId: string;
  bundleHash: string;
  assertCurrent: () => void;
};
