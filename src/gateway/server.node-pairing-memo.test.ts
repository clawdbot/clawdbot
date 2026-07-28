import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { listDevicePairing } from "../infra/device-pairing.js";
import { requestNodePairing } from "../infra/node-pairing.js";
import { configureSqliteConnectionPragmas } from "../infra/sqlite-wal.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { openTrackedWs } from "./device-authz.test-helpers.js";
import {
  createNodePairingTestState,
  describeWithGatewayServer,
} from "./server.node-pairing.test-support.js";
import { connectOk, installGatewayTestHooks, rpcReq } from "./test-helpers.js";

installGatewayTestHooks({ scope: "suite" });

const {
  cleanup: cleanupNodePairingTestState,
  makeStateDir: makeNodePairingStateDir,
  seedNodeDevice,
  setup: setupNodePairingTestState,
} = createNodePairingTestState("openclaw-node-pair-memo-");

describe("gateway node pairing memoization", () => {
  beforeAll(async () => {
    await setupNodePairingTestState();
  });

  afterAll(async () => {
    closeOpenClawStateDatabaseForTest();
    await cleanupNodePairingTestState();
  });

  describeWithGatewayServer("node.list pairing snapshots", (getStarted) => {
    test("scans pairing tables once across two node.list dispatches", async () => {
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/memo-scan-count.sqlite`,
        });
        await seedNodeDevice("node-list-memo-scan-count");
        const database = openOpenClawStateDatabase();
        const originalPrepare = database.db.prepare.bind(database.db);
        const tableSelects = { paired: 0, pending: 0 };
        const prepareSpy = vi.spyOn(database.db, "prepare").mockImplementation((sql) => {
          if (sql.includes('from "device_pairing_pending"')) {
            tableSelects.pending += 1;
          }
          if (sql.includes('from "device_pairing_paired"')) {
            tableSelects.paired += 1;
          }
          return originalPrepare(sql);
        });
        try {
          expect((await rpcReq(ws, "node.list", {})).ok).toBe(true);
          expect((await rpcReq(ws, "node.list", {})).ok).toBe(true);
          expect(tableSelects).toEqual({ paired: 1, pending: 1 });
        } finally {
          prepareSpy.mockRestore();
        }
      } finally {
        ws.close();
      }
    });

    test("reflects a pairing mutation on the next node.list dispatch", async () => {
      const nodeId = "node-list-memo-mutation";
      await seedNodeDevice(nodeId);
      const ws = await openTrackedWs(getStarted().port);
      try {
        await connectOk(ws, {
          token: "secret",
          scopes: ["operator.read", "operator.pairing"],
          deviceIdentityPath: `${await makeNodePairingStateDir()}/memo-mutation.sqlite`,
        });
        const before = await rpcReq<{
          nodes?: Array<{ nodeId: string; pendingRequestId?: string }>;
        }>(ws, "node.list", {});
        expect(before.payload?.nodes?.find((node) => node.nodeId === nodeId)).not.toHaveProperty(
          "pendingRequestId",
        );

        const pending = await requestNodePairing({
          nodeId,
          platform: "macos",
          commands: ["system.run"],
        });
        const after = await rpcReq<{
          nodes?: Array<{ nodeId: string; pendingRequestId?: string }>;
        }>(ws, "node.list", {});
        expect(after.payload?.nodes).toContainEqual(
          expect.objectContaining({
            nodeId,
            pendingRequestId: pending.request.requestId,
          }),
        );
      } finally {
        ws.close();
      }
    });
  });

  test("reloads cached pairing tables after another connection commits", async () => {
    const nodeId = "node-pairing-memo-external-writer";
    const baseDir = await makeNodePairingStateDir();
    await seedNodeDevice(nodeId, baseDir);
    expect(
      (await listDevicePairing(baseDir)).paired.find((device) => device.deviceId === nodeId)
        ?.displayName,
    ).toBeUndefined();

    const database = openOpenClawStateDatabase({
      env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
    });
    const external = new DatabaseSync(database.path);
    const maintenance = configureSqliteConnectionPragmas(external, {
      checkpointIntervalMs: 0,
      databaseLabel: "device-pairing-memo-external-writer",
      databasePath: database.path,
      foreignKeys: true,
      synchronous: "NORMAL",
    });
    try {
      external
        .prepare("UPDATE device_pairing_paired SET display_name = ? WHERE device_id = ?")
        .run("external name", nodeId);

      expect(
        (await listDevicePairing(baseDir)).paired.find((device) => device.deviceId === nodeId)
          ?.displayName,
      ).toBe("external name");
    } finally {
      maintenance.close();
      external.close();
    }
  });
});
