import {
  type WorkerAdmissionHandshake,
  WORKER_RPC_SET_VERSION,
} from "../../../packages/gateway-protocol/src/schema/worker-admission.js";
import { verifyWorkerAdmissionHandshake, type ExpectedWorkerBuild } from "./admission.js";
import type { WorkerInstallationArtifact } from "./bundle.js";
import {
  createWorkerCredentialMaterial,
  WORKER_CREDENTIAL_TTL_MS,
  type MintedWorkerCredential,
  type WorkerCredentialBinding,
  type WorkerCredentialDeliveryClaim,
} from "./credential.js";
import type { WorkerLiveEventReceiver } from "./live-events.js";
import type { WorkerSessionPlacementGate } from "./placement-worker-gate.js";
import type { WorkerEnvironmentState } from "./state.js";
import {
  type WorkerEnvironmentRecord,
  type WorkerEnvironmentStore,
  type WorkerEnvironmentTransitionPatch,
  WorkerSessionAlreadyAttachedError,
} from "./store.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerCredentialBrokerOptions = {
  store: WorkerEnvironmentStore;
  prepareInstallation: (
    install: WorkerInstallationArtifact["install"],
  ) => Promise<WorkerInstallationArtifact>;
  tunnelManager?: Pick<WorkerTunnelManager, "stop">;
  workerCredentialTtlMs?: number;
  generateWorkerCredential?: (bytes: number) => string;
  liveEvents?: Pick<WorkerLiveEventReceiver, "bindSession" | "rotateCredential">;
  placementStore?: WorkerSessionPlacementGate;
  now: () => number;
  isStopping: () => boolean;
  cancelInferenceEnvironment: (environmentId: string) => void;
  inState: (record: WorkerEnvironmentRecord, ...states: WorkerEnvironmentState[]) => boolean;
  move: (
    record: WorkerEnvironmentRecord,
    to: WorkerEnvironmentState,
    patch?: Parameters<WorkerEnvironmentStore["transition"]>[0]["patch"],
  ) => WorkerEnvironmentRecord;
  serviceError: (code: "environment_not_found" | "invalid_state", message: string) => Error;
  withLock: <T>(environmentId: string, task: () => Promise<T>) => Promise<T>;
};

export function createWorkerCredentialBroker(options: WorkerCredentialBrokerOptions) {
  const { store } = options;
  const tunnels = options.tunnelManager;
  const now = options.now;
  const inference = { cancelEnvironment: options.cancelInferenceEnvironment };
  const inState = options.inState;
  const move = options.move;
  const serviceError = options.serviceError;
  const withLock = options.withLock;
  const pendingCredentials = new Map<string, MintedWorkerCredential>();

  const credentialExpiry = () => {
    const ttlMs = options.workerCredentialTtlMs ?? WORKER_CREDENTIAL_TTL_MS;
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1) {
      throw serviceError("invalid_state", "Worker credential lifetime is invalid");
    }
    const expiresAtMs = now() + ttlMs;
    if (!Number.isSafeInteger(expiresAtMs)) {
      throw serviceError("invalid_state", "Worker credential expiry is out of range");
    }
    return expiresAtMs;
  };

  const credentialMaterial = () => createWorkerCredentialMaterial(options.generateWorkerCredential);

  const grantFrom = (params: {
    credential: string;
    record: ReturnType<WorkerEnvironmentStore["getCredential"]>;
  }): MintedWorkerCredential => {
    const record = params.record;
    if (!record) {
      throw serviceError("invalid_state", "Worker credential persistence failed");
    }
    return {
      credential: params.credential,
      deliveryId: record.credentialHash,
      environmentId: record.environmentId,
      bundleHash: record.bundleHash,
      sessionId: record.sessionId,
      rpcSetVersion: record.rpcSetVersion,
      ownerEpoch: record.ownerEpoch,
      expiresAtMs: record.expiresAtMs,
    };
  };

  const mintCredentialLocked = (
    request: WorkerCredentialBinding,
  ): { credentialHash: string; grant: MintedWorkerCredential } => {
    const previous = store.getCredential(request.environmentId);
    if (previous) {
      inference.cancelEnvironment(request.environmentId);
    }
    const material = credentialMaterial();
    const credential = {
      environmentId: request.environmentId,
      expectedOwnerEpoch: request.ownerEpoch,
      credentialHash: material.credentialHash,
      sessionId: request.sessionId,
      rpcSetVersion: WORKER_RPC_SET_VERSION,
      expiresAtMs: credentialExpiry(),
    };
    const record = store.renewCredential(credential);
    return {
      credentialHash: material.credentialHash,
      grant: grantFrom({ credential: material.credential, record }),
    };
  };

  const stageCredential = (grant: MintedWorkerCredential): MintedWorkerCredential => {
    pendingCredentials.set(grant.environmentId, grant);
    return grant;
  };

  const commitReady = (
    record: WorkerEnvironmentRecord,
    receipt: WorkerAdmissionHandshake & { installKind: "bundle" },
    patch: WorkerEnvironmentTransitionPatch = {},
  ) => {
    const material = credentialMaterial();
    // Receipt, owner epoch, and credential hash commit together. A failed write leaves the
    // durable lease retryable without ever admitting a partial identity.
    const ready = move(record, "ready", {
      ...patch,
      bootstrapReceipt: receipt,
      credential: {
        credentialHash: material.credentialHash,
        sessionId: null,
        rpcSetVersion: WORKER_RPC_SET_VERSION,
        expiresAtMs: credentialExpiry(),
      },
    });
    stageCredential(
      grantFrom({
        credential: material.credential,
        record: store.getCredential(record.environmentId),
      }),
    );
    return ready;
  };

  const ensurePendingCredential = (record: WorkerEnvironmentRecord, sessionId: string | null) => {
    const credential = store.getCredential(record.environmentId);
    const pending = pendingCredentials.get(record.environmentId);
    const credentialHasDurableTurn =
      credential?.deliveredAtMs !== null &&
      credential?.ownerEpoch === record.ownerEpoch &&
      credential.sessionId === sessionId &&
      sessionId !== null &&
      options.placementStore?.hasWorkerTurn({
        sessionId,
        environmentId: record.environmentId,
        ownerEpoch: record.ownerEpoch,
      }) === true;
    const credentialIsCurrent =
      credential?.ownerEpoch === record.ownerEpoch &&
      credential.sessionId === sessionId &&
      (credential.expiresAtMs > now() || credentialHasDurableTurn);
    const pendingIsCurrent =
      credentialIsCurrent &&
      pending?.deliveryId === credential.credentialHash &&
      pending.ownerEpoch === record.ownerEpoch &&
      pending.sessionId === sessionId;
    if (credentialIsCurrent && credential.deliveredAtMs !== null) {
      pendingCredentials.delete(record.environmentId);
      return;
    }
    if (pendingIsCurrent) {
      return;
    }
    pendingCredentials.delete(record.environmentId);
    const minted = mintCredentialLocked({
      environmentId: record.environmentId,
      ownerEpoch: record.ownerEpoch,
      sessionId,
    });
    stageCredential(minted.grant);
    if (sessionId && credential?.ownerEpoch === record.ownerEpoch) {
      options.liveEvents?.rotateCredential({
        credentialHash: minted.credentialHash,
        environmentId: record.environmentId,
        previousCredentialHash: credential.credentialHash,
        runEpoch: record.ownerEpoch,
        sessionId,
      });
    }
  };

  const attachSession = async (
    request: WorkerCredentialBinding & { sessionId: string },
  ): Promise<MintedWorkerCredential> => {
    let stopping = options.isStopping();
    if (stopping) {
      throw serviceError("invalid_state", "Worker environment service is stopping");
    }
    return withLock(request.environmentId, async () => {
      stopping = options.isStopping();
      if (stopping) {
        throw serviceError("invalid_state", "Worker environment service is stopping");
      }
      const current = store.get(request.environmentId);
      if (!current) {
        throw serviceError(
          "environment_not_found",
          `Unknown worker environment: ${request.environmentId}`,
        );
      }
      if (current.state !== "ready" && current.state !== "idle") {
        throw serviceError("invalid_state", `Cannot attach worker in state: ${current.state}`);
      }
      let currentBuild: ExpectedWorkerBuild;
      try {
        currentBuild = await options.prepareInstallation("bundle");
      } catch {
        throw serviceError("invalid_state", "Current worker build identity is unavailable");
      }
      if (
        !current.bootstrapReceipt ||
        !verifyWorkerAdmissionHandshake(current.bootstrapReceipt, currentBuild)
      ) {
        throw serviceError(
          "invalid_state",
          "Worker must bootstrap the current build before attach",
        );
      }
      const material = credentialMaterial();
      let attached: WorkerEnvironmentRecord;
      try {
        attached = store.transition({
          environmentId: request.environmentId,
          from: current.state,
          to: "attached",
          expectedOwnerEpoch: request.ownerEpoch,
          patch: {
            attachedSessionIds: [request.sessionId],
            credential: {
              credentialHash: material.credentialHash,
              sessionId: request.sessionId,
              rpcSetVersion: WORKER_RPC_SET_VERSION,
              expiresAtMs: credentialExpiry(),
            },
          },
        });
      } catch (error) {
        if (error instanceof WorkerSessionAlreadyAttachedError) {
          throw serviceError("invalid_state", error.message);
        }
        throw error;
      }
      if (options.liveEvents) {
        let liveSessionBound: boolean;
        try {
          liveSessionBound = options.liveEvents.bindSession({
            environmentId: attached.environmentId,
            runEpoch: attached.ownerEpoch,
            sessionId: request.sessionId,
          });
        } catch {
          liveSessionBound = false;
        }
        if (!liveSessionBound) {
          move(attached, "idle");
          // Preserve the bounded attachment error after rollback fences the old worker.
          await tunnels?.stop(request.environmentId, current.ownerEpoch).catch(() => undefined);
          throw serviceError("invalid_state", "Attached session target is unavailable");
        }
      }
      pendingCredentials.delete(request.environmentId);
      await tunnels?.stop(request.environmentId, current.ownerEpoch);
      return stageCredential(
        grantFrom({
          credential: material.credential,
          record: store.getCredential(request.environmentId),
        }),
      );
    });
  };

  const readPendingCredential = (binding: WorkerCredentialBinding) => {
    const stopping = options.isStopping();
    if (stopping) {
      return undefined;
    }
    const grant = pendingCredentials.get(binding.environmentId);
    if (
      !grant ||
      grant.ownerEpoch !== binding.ownerEpoch ||
      grant.sessionId !== binding.sessionId
    ) {
      return undefined;
    }
    const environment = store.get(binding.environmentId);
    const credential = store.getCredential(binding.environmentId);
    const credentialHash = grant.deliveryId;
    const checkedAtMs = now();
    if (
      !environment ||
      !inState(environment, "ready", "idle", "attached") ||
      environment.destroyRequestedAtMs !== null ||
      environment.ownerEpoch !== binding.ownerEpoch ||
      !credential ||
      credential.credentialHash !== credentialHash ||
      credential.ownerEpoch !== binding.ownerEpoch ||
      credential.sessionId !== binding.sessionId ||
      credential.deliveredAtMs !== null ||
      credential.expiresAtMs <= checkedAtMs
    ) {
      return undefined;
    }
    return { checkedAtMs, credentialHash, grant };
  };

  const acquireTurnCredential = (binding: WorkerCredentialBinding & { sessionId: string }) =>
    withLock(binding.environmentId, async () => {
      const pending = readPendingCredential(binding)?.grant;
      if (pending) {
        return pending;
      }
      const environment = store.get(binding.environmentId);
      if (
        !environment ||
        environment.state !== "attached" ||
        environment.ownerEpoch !== binding.ownerEpoch ||
        environment.attachedSessionIds.length !== 1 ||
        environment.attachedSessionIds[0] !== binding.sessionId
      ) {
        throw serviceError("invalid_state", "Worker session credential owner is not attached");
      }
      const previous = store.getCredential(binding.environmentId);
      const minted = mintCredentialLocked(binding);
      const grant = stageCredential(minted.grant);
      if (previous?.sessionId === binding.sessionId) {
        options.liveEvents?.rotateCredential({
          credentialHash: minted.credentialHash,
          environmentId: binding.environmentId,
          newProcessTurn: true,
          previousCredentialHash: previous.credentialHash,
          runEpoch: binding.ownerEpoch,
          sessionId: binding.sessionId,
        });
      }
      return grant;
    });

  const acknowledgeCredentialDelivery = (claim: WorkerCredentialDeliveryClaim): boolean => {
    const pending = readPendingCredential(claim);
    if (!pending || pending.grant.deliveryId !== claim.deliveryId) {
      return false;
    }
    store.markCredentialDelivered({
      ...claim,
      credentialHash: pending.credentialHash,
      deliveredAtMs: pending.checkedAtMs,
    });
    pendingCredentials.delete(claim.environmentId);
    return true;
  };

  return {
    acknowledgeCredentialDelivery,
    acquireTurnCredential,
    attachSession,
    clear: () => pendingCredentials.clear(),
    clearEnvironment: (environmentId: string) => pendingCredentials.delete(environmentId),
    commitReady,
    credentialExpiry,
    credentialMaterial,
    ensurePendingCredential,
    grantFrom,
    readPendingCredential,
    stageCredential,
    takeMintedCredential: (binding: WorkerCredentialBinding) =>
      readPendingCredential(binding)?.grant,
  };
}

export type WorkerCredentialBroker = ReturnType<typeof createWorkerCredentialBroker>;
