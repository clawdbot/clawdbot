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
import type { WorkerEnvironmentState } from "./state.js";
import type {
  WorkerEnvironmentRecord,
  WorkerEnvironmentStore,
  WorkerEnvironmentTransitionPatch,
} from "./store.js";
import type { WorkerTunnelStopReason } from "./tunnel-contract.js";

export type WorkerProviderLifecycleInputOptions = {
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
  ensureNodeWorkerBundle?: (deviceId: string) => Promise<WorkerAdmissionHandshake>;
  prepareNodeBootstrap?: (record: WorkerEnvironmentRecord) => Promise<void>;
  prepareNodeRuntime?: (
    record: WorkerEnvironmentRecord,
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
  providerCallTimeoutMs?: number;
};

export type WorkerProviderLifecycleOptions = WorkerProviderLifecycleInputOptions & {
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
