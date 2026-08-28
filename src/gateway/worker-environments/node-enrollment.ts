import { setTimeout as sleep } from "node:timers/promises";
import { resolveGatewayPublicOrigin } from "../../config/gateway-public-origin.js";
import { ensureDevicePairSetupBootstrapToken } from "../../infra/device-bootstrap.js";
import { removePairedDeviceRole } from "../../infra/device-pairing.js";
import {
  encodePairingSetupCode,
  resolveConfiguredPairingPublicUrl,
  resolvePairingSetupFromConfig,
} from "../../pairing/setup-code.js";
import type { WorkerNodeEnrollment } from "../../plugins/types.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import { VERSION } from "../../version.js";
import type { DeviceWorkerAvailability } from "./device-provider.js";
import type { WorkerEnvironmentRecord, WorkerEnvironmentStore } from "./store.js";

const NODE_ENROLLMENT_TIMEOUT_MS = 10 * 60_000;
const NODE_ENROLLMENT_POLL_MS = 250;

type WorkerNodeEnrollmentManagerOptions = {
  store: WorkerEnvironmentStore;
  getConfig: () => Parameters<typeof resolvePairingSetupFromConfig>[0];
  resolveAvailability: (deviceId: string) => Promise<DeviceWorkerAvailability>;
  now?: () => number;
};

function enrollmentDisplayName(record: WorkerEnvironmentRecord): string {
  return `Cloud worker ${record.profileId}`.slice(0, 64);
}

function resolveEnrollmentPackageSpecs(): string[] {
  return [`openclaw@${VERSION}`];
}

export function createWorkerNodeEnrollmentManager(options: WorkerNodeEnrollmentManagerOptions) {
  const now = options.now ?? Date.now;
  const packageSpecs = resolveEnrollmentPackageSpecs();
  const controller = new AbortController();
  const { signal } = controller;

  const waitForDeviceId = async (environmentId: string): Promise<string> => {
    const deadline = now() + NODE_ENROLLMENT_TIMEOUT_MS;
    while (now() < deadline) {
      signal.throwIfAborted();
      const record = options.store.ensureNodeEnrollment(environmentId);
      if (record.destroyRequestedAtMs !== null) {
        throw new Error("Worker node enrollment was canceled by environment teardown");
      }
      if (record.nodeDeviceId) {
        const availability = await options.resolveAvailability(record.nodeDeviceId);
        signal.throwIfAborted();
        if (availability.available) {
          return record.nodeDeviceId;
        }
      }
      await sleep(NODE_ENROLLMENT_POLL_MS, undefined, { signal });
    }
    throw new Error("Worker node did not connect before the enrollment deadline");
  };

  const begin = async (record: WorkerEnvironmentRecord): Promise<WorkerNodeEnrollment> => {
    signal.throwIfAborted();
    let current = options.store.ensureNodeEnrollment(record.environmentId);
    const displayName = enrollmentDisplayName(current);
    const wait = async () => await waitForDeviceId(current.environmentId);
    if (current.nodeDeviceId) {
      return {
        mode: "resume",
        deviceId: current.nodeDeviceId,
        openclawVersion: VERSION,
        packageSpecs,
        displayName,
        signal,
        waitForDeviceId: wait,
      };
    }
    if (!current.nodeSetupId) {
      throw new Error("Worker node enrollment setup identity was not persisted");
    }
    const issued = await ensureDevicePairSetupBootstrapToken({
      setupId: current.nodeSetupId,
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    signal.throwIfAborted();
    if (issued.status === "completed") {
      current = options.store.ensureNodeEnrollment(current.environmentId);
      if (!current.nodeDeviceId || current.nodeDeviceId !== issued.deviceId) {
        throw new Error("Worker node enrollment completion did not bind its environment");
      }
      return {
        mode: "resume",
        deviceId: current.nodeDeviceId,
        openclawVersion: VERSION,
        packageSpecs,
        displayName,
        signal,
        waitForDeviceId: wait,
      };
    }
    const config = options.getConfig();
    const resolved = await resolvePairingSetupFromConfig(config, {
      env: process.env,
      publicUrl: resolveConfiguredPairingPublicUrl(config) ?? resolveGatewayPublicOrigin(config),
      bootstrapProfile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
      issuedBootstrap: issued,
      runCommandWithTimeout: async (argv, runOptions) =>
        await runCommandWithTimeout(argv, { timeoutMs: runOptions.timeoutMs }),
    });
    signal.throwIfAborted();
    if (!resolved.ok) {
      throw new Error(resolved.error);
    }
    if (resolved.setupId !== current.nodeSetupId) {
      throw new Error("Worker node enrollment setup identity changed during preparation");
    }
    return {
      mode: "connect",
      setupCode: encodePairingSetupCode(resolved.payload),
      setupId: current.nodeSetupId,
      openclawVersion: VERSION,
      packageSpecs,
      displayName,
      signal,
      waitForDeviceId: wait,
    };
  };

  const retire = async (record: WorkerEnvironmentRecord): Promise<void> => {
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

  return { begin, retire, stop: () => controller.abort() };
}
