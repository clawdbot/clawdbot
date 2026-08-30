import os from "node:os";
import { setTimeout as sleep } from "node:timers/promises";
import { truncateUtf16Safe } from "@openclaw/normalization-core/utf16-slice";
import { resolveGatewayPublicOrigin } from "../../config/gateway-public-origin.js";
import { ensureDevicePairSetupBootstrapToken } from "../../infra/device-bootstrap.js";
import { removePairedDeviceRole } from "../../infra/device-pairing.js";
import {
  encodePairingSetupCode,
  resolveConfiguredPairingPublicUrl,
  resolvePairingGatewayUrl,
  resolvePairingSetupFromConfig,
} from "../../pairing/setup-code.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import { WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH } from "../gateway-http-route-contracts.js";
import type { DeviceWorkerAvailability } from "./device-provider.js";
import type { NodeBootstrapArtifact } from "./node-bootstrap-artifact.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";
import type { WorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

const NODE_ENROLLMENT_TIMEOUT_MS = 10 * 60_000;
const NODE_ENROLLMENT_POLL_MS = 250;

type WorkerNodeEnrollmentManagerOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => Parameters<typeof resolvePairingSetupFromConfig>[0];
  resolveAvailability: (deviceId: string) => Promise<DeviceWorkerAvailability>;
  getLocalTlsFingerprint?: () => string | undefined;
  prepareArtifact: (
    record: WorkerEnvironmentRecord,
    signal?: AbortSignal,
  ) => Promise<NodeBootstrapArtifact>;
  transfer: WorkerBootstrapArtifactTransferService;
  now?: () => number;
};

export function createWorkerNodeEnrollmentManager(options: WorkerNodeEnrollmentManagerOptions) {
  const now = options.now ?? Date.now;
  const controller = new AbortController();
  const { signal } = controller;
  const active = new Map<string, { close: () => void }>();
  const enrollmentClosers = new WeakMap<WorkerNodeEnrollment, () => void>();
  const commandRunner = async (argv: string[], runOptions: { timeoutMs: number }) =>
    await runCommandWithTimeout(argv, { timeoutMs: runOptions.timeoutMs });

  const prepare = async (record: WorkerEnvironmentRecord, enrollmentSignal?: AbortSignal) => {
    const preparationSignal = enrollmentSignal ?? signal;
    preparationSignal.throwIfAborted();
    const config = options.getConfig();
    const url = await resolvePairingGatewayUrl(config, {
      env: process.env,
      publicUrl: resolveConfiguredPairingPublicUrl(config) ?? resolveGatewayPublicOrigin(config),
      networkInterfaces: os.networkInterfaces,
      runCommandWithTimeout: commandRunner,
    });
    if (!url.url) {
      throw new Error(url.error ?? "Cloud node bootstrap cannot resolve the Gateway address");
    }
    preparationSignal.throwIfAborted();
    const artifact = await options.prepareArtifact(record, enrollmentSignal);
    preparationSignal.throwIfAborted();
    const tlsFingerprint = url.url.startsWith("wss://")
      ? url.source?.startsWith("gateway.bind=")
        ? options.getLocalTlsFingerprint?.()
        : url.source === "gateway.remote.url"
          ? config.gateway?.remote?.tlsFingerprint
          : undefined
      : undefined;
    return { artifact, url: url.url, tlsFingerprint };
  };

  const begin = async (record: WorkerEnvironmentRecord): Promise<WorkerNodeEnrollment> => {
    signal.throwIfAborted();
    const admission = options.store.get(record.environmentId);
    if (
      admission?.state !== "provisioning" ||
      admission.destroyRequestedAtMs !== null ||
      admission.provisionOperationId !== record.provisionOperationId ||
      admission.ownerEpoch !== record.ownerEpoch
    ) {
      throw new Error("Worker node enrollment is no longer provisioning");
    }
    // Reserve the generation before asynchronous preparation, so a stale completion
    // cannot cancel or replace an enrollment admitted after it.
    active.get(record.environmentId)?.close();
    const enrollmentAbort = new AbortController();
    const enrollmentSignal = AbortSignal.any([signal, enrollmentAbort.signal]);
    const binding = {
      close: () => {
        if (active.get(record.environmentId) === binding) {
          active.delete(record.environmentId);
        }
        enrollmentAbort.abort();
      },
    };
    active.set(record.environmentId, binding);
    try {
      const prepared = await prepare(record, enrollmentSignal);
      let current = options.store.ensureNodeEnrollment(record.environmentId);
      if (
        current.state !== "provisioning" ||
        current.destroyRequestedAtMs !== null ||
        current.provisionOperationId !== record.provisionOperationId ||
        current.ownerEpoch !== record.ownerEpoch
      ) {
        throw new Error("Worker node enrollment is no longer provisioning");
      }
      let mode:
        | { mode: "connect"; setupCode: string; setupId: string }
        | { mode: "resume"; deviceId: string };
      let gatewayUrl = prepared.url;
      let tlsFingerprint = prepared.tlsFingerprint;
      if (current.nodeDeviceId) {
        mode = { mode: "resume", deviceId: current.nodeDeviceId };
      } else {
        if (!current.nodeSetupId) {
          throw new Error("Worker node enrollment setup identity was not persisted");
        }
        const issued = await ensureDevicePairSetupBootstrapToken({
          setupId: current.nodeSetupId,
          profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
        });
        enrollmentSignal.throwIfAborted();
        if (issued.status === "completed") {
          current = options.store.ensureNodeEnrollment(record.environmentId);
          if (!current.nodeDeviceId || current.nodeDeviceId !== issued.deviceId) {
            throw new Error("Worker node enrollment completion did not bind its environment");
          }
          mode = { mode: "resume", deviceId: current.nodeDeviceId };
        } else {
          const config = options.getConfig();
          const resolved = await resolvePairingSetupFromConfig(config, {
            env: process.env,
            publicUrl:
              resolveConfiguredPairingPublicUrl(config) ?? resolveGatewayPublicOrigin(config),
            bootstrapProfile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
            issuedBootstrap: issued,
            localTlsFingerprint: options.getLocalTlsFingerprint?.(),
            runCommandWithTimeout: commandRunner,
          });
          enrollmentSignal.throwIfAborted();
          if (!resolved.ok) {
            throw new Error(resolved.error);
          }
          if (resolved.setupId !== current.nodeSetupId) {
            throw new Error("Worker node enrollment setup identity changed during preparation");
          }
          gatewayUrl = resolved.payload.url;
          tlsFingerprint = resolved.payload.tlsFingerprint;
          mode = {
            mode: "connect",
            setupCode: encodePairingSetupCode(resolved.payload),
            setupId: current.nodeSetupId,
          };
        }
      }
      const owner = current;
      const isAuthorized = () => {
        const live = options.store.get(owner.environmentId);
        return (
          active.get(owner.environmentId) === binding &&
          !enrollmentSignal.aborted &&
          live?.state === "provisioning" &&
          live.destroyRequestedAtMs === null &&
          live.provisionOperationId === record.provisionOperationId &&
          live.ownerEpoch === record.ownerEpoch &&
          live.nodeSetupId === owner.nodeSetupId &&
          live.nodeDeviceId === owner.nodeDeviceId
        );
      };
      const artifact = prepared.artifact;
      const capability = options.transfer.prepare({
        artifact,
        isAuthorized,
        signal: enrollmentSignal,
      });
      const url = new URL(gatewayUrl);
      url.protocol = url.protocol === "wss:" ? "https:" : "http:";
      url.pathname = `${WORKER_BOOTSTRAP_ARTIFACT_TRANSFER_PATH}/artifacts/${artifact.tarballSha256}`;
      url.search = "";
      url.hash = "";
      const enrollment: WorkerNodeEnrollment = {
        ...mode,
        openclawVersion: artifact.openclawVersion,
        nodeBootstrap: {
          url: url.toString(),
          token: capability.token,
          sha256: artifact.tarballSha256,
          bytes: artifact.tarballBytes,
          openclawVersion: artifact.openclawVersion,
          enabledPluginIds: artifact.enabledPluginIds,
          ...(tlsFingerprint ? { tlsFingerprint } : {}),
        },
        displayName: truncateUtf16Safe(`Cloud worker ${owner.profileId}`, 64),
        signal: enrollmentSignal,
        waitForDeviceId: async () => {
          const deadline = now() + NODE_ENROLLMENT_TIMEOUT_MS;
          while (now() < deadline) {
            enrollmentSignal.throwIfAborted();
            const live = options.store.ensureNodeEnrollment(owner.environmentId);
            if (
              live.destroyRequestedAtMs !== null ||
              live.state !== "provisioning" ||
              live.provisionOperationId !== owner.provisionOperationId ||
              live.nodeSetupId !== owner.nodeSetupId ||
              live.ownerEpoch !== owner.ownerEpoch ||
              active.get(owner.environmentId) !== binding
            ) {
              throw new Error("Worker node enrollment is no longer current");
            }
            if (live.nodeDeviceId) {
              const availability = await options.resolveAvailability(live.nodeDeviceId);
              enrollmentSignal.throwIfAborted();
              const latest = options.store.get(owner.environmentId);
              if (
                !latest ||
                latest.state !== "provisioning" ||
                latest.destroyRequestedAtMs !== null ||
                latest.provisionOperationId !== owner.provisionOperationId ||
                latest.ownerEpoch !== owner.ownerEpoch ||
                latest.nodeSetupId !== owner.nodeSetupId ||
                latest.nodeDeviceId !== live.nodeDeviceId ||
                active.get(owner.environmentId) !== binding
              ) {
                throw new Error("Worker node enrollment is no longer current");
              }
              if (availability.available) {
                return live.nodeDeviceId;
              }
            }
            await sleep(NODE_ENROLLMENT_POLL_MS, undefined, { signal: enrollmentSignal });
          }
          throw new Error("Worker node did not connect before the enrollment deadline");
        },
      };
      enrollmentClosers.set(enrollment, binding.close);
      return enrollment;
    } catch (error) {
      binding.close();
      throw error;
    }
  };

  const retire = async (record: WorkerEnvironmentRecord): Promise<void> => {
    active.get(record.environmentId)?.close();
    const deviceId = record.nodeDeviceId;
    if (!deviceId) {
      return;
    }
    const sharedOwner = options.store
      .listForReconcile()
      .find(
        (candidate) =>
          candidate.environmentId !== record.environmentId && candidate.nodeDeviceId === deviceId,
      );
    if (sharedOwner) {
      throw new Error(
        `Worker node ${deviceId} is still owned by environment ${sharedOwner.environmentId}`,
      );
    }
    await removePairedDeviceRole({ deviceId, role: "node" });
  };

  return {
    prepare: async (record: WorkerEnvironmentRecord) => {
      await prepare(record);
    },
    begin,
    retire,
    close: (enrollment: WorkerNodeEnrollment) => enrollmentClosers.get(enrollment)?.(),
    stop: () => {
      controller.abort();
      for (const binding of active.values()) {
        binding.close();
      }
      options.transfer.closeAll();
    },
  };
}
