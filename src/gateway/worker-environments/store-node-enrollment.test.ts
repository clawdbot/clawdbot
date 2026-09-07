import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consumeDeviceBootstrapTokenWithSetupCompletion,
  ensureDevicePairSetupBootstrapToken,
  verifyDeviceBootstrapToken,
} from "../../infra/device-bootstrap.js";
import { CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE } from "../../shared/device-bootstrap-profile.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  type OpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerEnvironmentStore, type WorkerEnvironmentStore } from "./store.js";

const BOOTSTRAP_RECEIPT = {
  bundleHash: "a".repeat(64),
  openclawVersion: "2026.7.1",
  protocolFeatures: ["workspace-sync-v1", "model-proxy-v1"],
};

describe("worker environment node enrollment store", () => {
  let root: string;
  let database: OpenClawStateDatabase;
  let store: WorkerEnvironmentStore;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-worker-node-"));
    database = openOpenClawStateDatabase({ env: { OPENCLAW_STATE_DIR: root } });
    store = createWorkerEnvironmentStore({ database, now: () => 1_000 });
    store.createIntent({
      environmentId: "worker-enrollment",
      providerId: "fake-provider",
      profileId: "test-profile",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: "provision:worker-enrollment",
    });
  });

  afterEach(async () => {
    closeOpenClawStateDatabaseForTest();
    await fs.rm(root, { recursive: true, force: true });
  });

  function seedEnrollmentState(state: string, deviceId: string | null): string {
    store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const setupId = expectDefined(
      store.ensureNodeEnrollment("worker-enrollment").nodeSetupId,
      "worker node enrollment setup id",
    );
    database.db
      .prepare(
        "UPDATE worker_environments SET state = ?, node_device_id = ? WHERE node_setup_id = ?",
      )
      .run(state, deviceId, setupId);
    return setupId;
  }

  it("binds setup completion to the exact environment identity across restart", async () => {
    expect(store.hasPendingNodeEnrollmentSetup("", "cloud-device-1")).toBe(false);
    expect(store.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-1")).toBe(false);
    store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const pending = store.ensureNodeEnrollment("worker-enrollment");
    const setupId = expectDefined(pending.nodeSetupId, "worker node enrollment setup id");
    expect(setupId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(pending.nodeDeviceId).toBeNull();
    expect(store.ensureNodeEnrollment("worker-enrollment").nodeSetupId).toBe(setupId);
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-1")).toBe(true);
    expect(store.hasNodeEnrollmentOwner("cloud-device-1")).toBe(false);
    const inventoryVersion = store.inventoryVersion();

    const issued = await ensureDevicePairSetupBootstrapToken({
      baseDir: root,
      setupId,
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    if (issued.status !== "pending") {
      throw new Error("expected pending cloud worker setup");
    }
    await verifyDeviceBootstrapToken({
      baseDir: root,
      token: issued.token,
      deviceId: "cloud-device-1",
      publicKey: "cloud-public-key-1",
      role: "node",
      scopes: [],
    });
    await consumeDeviceBootstrapTokenWithSetupCompletion({
      baseDir: root,
      token: issued.token,
      deviceId: "cloud-device-1",
      completedAtMs: 10,
    });

    expect(store.get("worker-enrollment")).toMatchObject({
      nodeSetupId: setupId,
      nodeDeviceId: "cloud-device-1",
    });
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-1")).toBe(true);
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "different-cloud-device")).toBe(false);
    expect(store.inventoryVersion()).toBe(inventoryVersion);
    expect(store.hasNodeEnrollmentOwner("cloud-device-1")).toBe(true);
    expect(store.hasNodeEnrollmentOwner("different-cloud-device")).toBe(false);
  });

  it("rejects a destroy-requested provisioning setup", async () => {
    store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const setupId = expectDefined(
      store.ensureNodeEnrollment("worker-enrollment").nodeSetupId,
      "worker node enrollment setup id",
    );
    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-canceled")).toBe(true);
    const issued = await ensureDevicePairSetupBootstrapToken({
      baseDir: root,
      setupId,
      profile: CLOUD_WORKER_PAIRING_SETUP_BOOTSTRAP_PROFILE,
    });
    if (issued.status !== "pending") {
      throw new Error("expected pending cloud worker setup");
    }
    await verifyDeviceBootstrapToken({
      baseDir: root,
      token: issued.token,
      deviceId: "cloud-device-canceled",
      publicKey: "cloud-public-key-canceled",
      role: "node",
      scopes: [],
    });

    store.requestDestroy({ environmentId: "worker-enrollment", state: "provisioning" });

    expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-canceled")).toBe(false);
    await expect(
      consumeDeviceBootstrapTokenWithSetupCompletion({
        baseDir: root,
        token: issued.token,
        deviceId: "cloud-device-canceled",
        completedAtMs: 10,
      }),
    ).rejects.toThrow("Cloud worker setup completion owner is no longer pending");
    expect(store.get("worker-enrollment")?.nodeDeviceId).toBeNull();
  });

  it.each(["provisioning", "bootstrapping", "ready", "idle", "attached"])(
    "admits only the exact already-bound setup device in %s",
    (state) => {
      const setupId = seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(true);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(true);
      expect(store.hasPendingNodeEnrollmentSetup(setupId, "different-cloud-device")).toBe(false);
      expect(store.hasPendingNodeEnrollmentSetup("missing-setup", "cloud-device-bound")).toBe(
        false,
      );
    },
  );

  it.each(["provisioning", "bootstrapping", "ready", "idle", "attached"])(
    "allows first setup-device binding in %s only when provisioning",
    (state) => {
      const setupId = seedEnrollmentState(state, null);

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-first")).toBe(
        state === "provisioning",
      );
    },
  );

  it.each(["requested", "draining", "destroying", "destroyed", "failed", "orphaned"])(
    "rejects an already-bound setup device in %s",
    (state) => {
      const setupId = seedEnrollmentState(state, "cloud-device-bound");

      expect(store.hasPendingNodeEnrollmentSetup(setupId, "cloud-device-bound")).toBe(false);
      expect(store.hasNodeEnrollmentOwner("cloud-device-bound")).toBe(
        state === "requested" || state === "draining" || state === "destroying",
      );
    },
  );

  it("persists a credential-bound node receipt without SSH metadata", () => {
    store.transition({
      environmentId: "worker-enrollment",
      from: "requested",
      to: "provisioning",
    });
    const ready = store.transition({
      environmentId: "worker-enrollment",
      from: "provisioning",
      to: "ready",
      patch: {
        leaseId: "device-lease-1",
        nodeDeviceId: "device-1",
        sshEndpoint: null,
        sharedHost: true,
        bootstrapReceipt: { ...BOOTSTRAP_RECEIPT, installKind: "bundle" },
        credential: {
          credentialHash: hashWorkerCredential("worker-credential-fixture"),
          sessionId: null,
          rpcSetVersion: 1,
          expiresAtMs: 11_000,
        },
      },
    });

    expect(ready).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      nodeDeviceId: "device-1",
      sshEndpoint: null,
      bootstrapReceipt: {
        ...BOOTSTRAP_RECEIPT,
        protocolFeatures: ["model-proxy-v1", "workspace-sync-v1"],
        installKind: "bundle",
      },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(store.hasNodeEnrollmentOwner("device-1")).toBe(false);
    expect(
      database.db
        .prepare(
          "SELECT node_device_id, ssh_host, ssh_host_key FROM worker_environments WHERE environment_id = ?",
        )
        .get("worker-enrollment"),
    ).toEqual({ node_device_id: "device-1", ssh_host: null, ssh_host_key: null });
  });
});
