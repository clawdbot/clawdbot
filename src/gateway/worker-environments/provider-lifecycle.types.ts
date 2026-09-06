import type { WorkerAdmissionHandshake } from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import type { OpenClawConfig } from "../../config/types.js";
import type { SecretRef } from "../../config/types.secrets.js";
import type {
  WorkerNodeEnrollment,
  WorkerNodeRuntimePreparation,
  WorkerProfile,
  WorkerProvider,
  WorkerSshEndpoint,
  WorkerSshIdentity,
} from "../../plugins/types.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import type { WorkerCredentialBroker } from "./credential-broker.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentTransitionPatch,
} from "./environment-record.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerPreparationArtifacts } from "./preparation-identity.js";
import type { createWorkerProjectPreparation } from "./project-preparation.js";
import type { WorkerEnvironmentState } from "./state.js";
import type { WorkerEnvironmentStore } from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";

export type WorkerEnvironmentAbandonment = {
  sessionId: string;
  ownerEpoch: number;
  authorize?: () => void;
};

export type WorkerProviderLifecycleInputOptions = {
  now?: () => number;
  store: WorkerEnvironmentStore;
  getConfig: () => OpenClawConfig;
  resolveProvider: (providerId: string) => WorkerProvider | undefined;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  bootstrapWorker: (params: {
    operationId: string;
    sshEndpoint: WorkerSshEndpoint;
    installation: WorkerInstallationArtifact;
    resolveIdentity: (keyRef: SecretRef) => Promise<WorkerSshIdentity>;
    signal: AbortSignal;
  }) => Promise<WorkerAdmissionHandshake>;
  resolveSshIdentity?: (params: {
    provider: WorkerProvider;
    leaseId: string;
    profile: WorkerProfile;
    keyRef: SecretRef;
  }) => Promise<WorkerSshIdentity>;
  ensureNodeWorkerBundle?: (params: {
    deviceId: string;
    artifact: Extract<WorkerInstallationArtifact, { install: "bundle" }>;
    prewarm: boolean;
    signal?: AbortSignal;
  }) => Promise<WorkerAdmissionHandshake>;
  prepareNodeBootstrap?: (record: WorkerEnvironmentRecord, signal?: AbortSignal) => Promise<void>;
  prepareNodeArtifacts?: (
    profileSnapshot: WorkerProfile,
    signal?: AbortSignal,
  ) => Promise<{ artifacts: WorkerPreparationArtifacts; assertCurrent: () => void }>;
  registerPreparedWorkspace?: (params: {
    record: WorkerEnvironmentRecord;
    deviceId: string;
    workspace: NonNullable<
      ReturnType<ReturnType<typeof createWorkerProjectPreparation>["getPreparedWorkspace"]>
    >;
    assertCurrent: () => void;
    signal?: AbortSignal;
  }) => Promise<void>;
  bindPreparedWorkspace?: (params: {
    environmentId: string;
    ownerEpoch: number;
    sessionId: string;
    sessionKey: string;
    preparationKey: string;
    cacheKey: string;
    signal?: AbortSignal;
    assertCurrent: () => void;
  }) => Promise<void>;
  prepareNodeRuntime?: (
    record: WorkerEnvironmentRecord,
    bundle: Extract<WorkerInstallationArtifact, { install: "bundle" }>,
    signal?: AbortSignal,
  ) => Promise<WorkerNodeRuntimePreparation>;
  closeNodeRuntime?: (preparation: WorkerNodeRuntimePreparation) => void;
  prepareNodeEnrollment?: (
    record: WorkerEnvironmentRecord,
    signal?: AbortSignal,
  ) => Promise<WorkerNodeEnrollment>;
  closeNodeEnrollment?: (enrollment: WorkerNodeEnrollment) => void;
  retireNodeEnrollment?: (record: WorkerEnvironmentRecord) => Promise<void>;
  projectNamespace?: string;
  placementStore?: WorkerSessionPlacementGate;
  providerCallTimeoutMs?: number;
};

export type WorkerProviderLifecycleOptions = Omit<
  WorkerProviderLifecycleInputOptions,
  "prepareInstallation"
> & {
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
    signal?: AbortSignal,
  ) => Promise<WorkerInstallationArtifact>;
  tunnelManager?: {
    stop(
      environmentId: string,
      ownerEpoch?: number,
      reason?: WorkerTunnelStopReason,
    ): Promise<void>;
  };
  credentialBroker: WorkerCredentialBroker;
  callBootstrap: <T>(
    installation: WorkerInstallationArtifact,
    run: (signal: AbortSignal) => Promise<T>,
  ) => Promise<T>;
  callProvider: <T>(environmentId: string, run: () => Promise<T>, timeoutMs?: number) => Promise<T>;
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  isServiceError: (error: unknown, code: string) => boolean;
  isStopping: () => boolean;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: WorkerEnvironmentTransitionPatch,
  ) => WorkerEnvironmentRecord;
  saveError: (record: WorkerEnvironmentRecord, error: unknown) => WorkerEnvironmentRecord;
  serviceError: (
    code:
      | "bootstrap_failure"
      | "environment_not_found"
      | "invalid_profile"
      | "invalid_state"
      | "profile_not_found"
      | "provider_failure"
      | "provider_not_found",
    message: string,
  ) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};
