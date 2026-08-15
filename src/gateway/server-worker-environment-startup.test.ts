import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
  OPENCLAW_STATE_SCHEMA_VERSION,
} from "../state/openclaw-state-db.js";
import { withEnvAsync } from "../test-utils/env.js";
import { createDesktopSessionRegistry } from "./desktop/session-registry.js";
import {
  createGatewayWorkerEnvironmentRuntime,
  loadGatewayWorkerEnvironmentStartupState,
} from "./server-worker-environment-startup.js";
import { hashWorkerCredential } from "./worker-environments/credential.js";
import {
  DEVICE_WORKER_PROVIDER_ID,
  reconcileDeviceWorker,
} from "./worker-environments/device-provider.js";
import {
  REQUEST,
  seedActivePlacement,
} from "./worker-environments/placement-dispatch-test-fixtures.js";
import { createWorkerSessionPlacementStore } from "./worker-environments/placement-store.js";

const DEVICE_ID = "revoked-device";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(() => {
  closeOpenClawStateDatabaseForTest();
});

describe("gateway worker environment startup", () => {
  it("installs the lazy retention column before projecting failed placements", async () => {
    const stateDir = tempDirs.make("openclaw-worker-retention-startup-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const database = openOpenClawStateDatabase();
      const placements = createWorkerSessionPlacementStore({ database, now: () => 1_000 });
      const active = seedActivePlacement(placements, {
        environmentId: "worker-retention-startup",
        ownerEpoch: 1,
      });
      const draining = placements.startDrain({
        sessionId: active.sessionId,
        environmentId: active.environmentId,
        ownerEpoch: active.activeOwnerEpoch,
        expectedGeneration: active.generation,
      });
      const reconciling = placements.startReconcile({
        sessionId: draining.sessionId,
        environmentId: draining.environmentId,
        ownerEpoch: draining.activeOwnerEpoch,
        expectedGeneration: draining.generation,
      });
      placements.fail({
        sessionId: REQUEST.sessionId,
        expectedGeneration: reconciling.generation,
        recoveryError: "worker recovery interrupted",
      });
      database.db.exec(
        "ALTER TABLE worker_workspace_reconciliations DROP COLUMN forced_abandonment_retained;",
      );
      expect(database.db.prepare("PRAGMA user_version").get()).toEqual({
        user_version: OPENCLAW_STATE_SCHEMA_VERSION,
      });

      const startup = await loadGatewayWorkerEnvironmentStartupState();

      expect(startup.hasNonlocalPlacementRecords).toBe(true);
      expect(
        database.db
          .prepare(
            "SELECT name FROM pragma_table_info('worker_workspace_reconciliations') WHERE name = 'forced_abandonment_retained'",
          )
          .get(),
      ).toEqual({ name: "forced_abandonment_retained" });
    });
  });

  it("cleans transfer scratch before serving and removes it on shutdown", async () => {
    const stateDir = tempDirs.make("openclaw-worker-transfer-startup-");
    const transferRoot = path.join(stateDir, "tmp", "node-workspace-transfer");
    const staleRoot = path.join(transferRoot, "context-stale");
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const startup = await loadGatewayWorkerEnvironmentStartupState();
      const runtime = await createGatewayWorkerEnvironmentRuntime({
        getPluginRegistry: () => ({ workerProviders: new Map() }),
        resolveWorkerGateway: () => undefined,
        desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
        startup,
        log: { child: () => ({ warn: () => {} }) },
      });
      const service = runtime.workerEnvironmentService;
      if (!service) {
        throw new Error("worker environment service was not created");
      }
      try {
        await expect(fs.readdir(transferRoot)).resolves.toEqual([]);
      } finally {
        await service.stop();
      }
      await expect(fs.stat(transferRoot)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });

  it("binds device revocation to the persisted profile settings", async () => {
    const stateDir = tempDirs.make("openclaw-worker-startup-");
    try {
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
        const startup = await loadGatewayWorkerEnvironmentStartupState();
        startup.store.createIntent({
          environmentId: "device-environment",
          providerId: DEVICE_WORKER_PROVIDER_ID,
          profileId: `device:${DEVICE_ID}`,
          profileSnapshot: { install: "bundle", settings: { device: DEVICE_ID } },
          provisionOperationId: "provision:device-environment",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "requested",
          to: "provisioning",
        });
        startup.store.transition({
          environmentId: "device-environment",
          from: "provisioning",
          to: "ready",
          patch: {
            leaseId: "device-lease",
            sshEndpoint: null,
            sharedHost: true,
            bootstrapReceipt: {
              bundleHash: "a".repeat(64),
              openclawVersion: "2026.8.14",
              protocolFeatures: ["worker-heartbeat-v1"],
              installKind: "bundle",
            },
            credential: {
              credentialHash: hashWorkerCredential("device-credential"),
              sessionId: null,
              rpcSetVersion: 1,
              expiresAtMs: Date.now() + 60_000,
            },
          },
        });

        const runtime = await createGatewayWorkerEnvironmentRuntime({
          getPluginRegistry: () => ({ workerProviders: new Map() }),
          resolveWorkerGateway: () => undefined,
          desktopSessionRegistry: createDesktopSessionRegistry({ lingerMs: 1 }),
          startup,
          log: { child: () => ({ warn: () => {} }) },
        });
        const service = runtime.workerEnvironmentService;
        if (!service) {
          throw new Error("worker environment service was not created");
        }
        try {
          await expect(reconcileDeviceWorker(service, DEVICE_ID)).resolves.toEqual([
            "device-environment",
          ]);
          expect(startup.store.getCredential("device-environment")).toBeUndefined();
          expect(startup.store.get("device-environment")?.state).toBe("orphaned");
        } finally {
          await service.stop();
        }
      });
    } finally {
      closeOpenClawStateDatabaseForTest();
    }
  });
});
