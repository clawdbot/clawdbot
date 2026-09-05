// Capability approvals follow the paired-device lifecycle, not the device-auth request TTL.
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import {
  closeOpenClawStateDatabaseByPath,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { approveDevicePairing } from "./device-pairing-approval.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  listNodePairing,
  recordPairedNodeConnection,
  recordPairedNodeDisconnection,
  rejectNodePairing,
  requestNodePairing,
} from "./device-pairing-node.js";
import { seedNodeDevice, setupPairedNode } from "./device-pairing-node.test-support.js";
import {
  getPairedDevice,
  listDevicePairingReadOnly,
  removePairedDeviceRole,
  requestDevicePairing,
  updatePairedDeviceMetadata,
} from "./device-pairing.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-lifecycle-" });
async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  return await run(await tempDirs.make("case"));
}

describe("node surface approval lifetime", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });
  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test.each(["initial", "reapproval"])(
    "keeps %s capability approval pending across aged reads, writes, and database reopen",
    async (kind) => {
      await withNodePairingDir(async (baseDir) => {
        if (kind === "initial") {
          await seedNodeDevice(baseDir, "node-1");
        } else {
          await setupPairedNode(baseDir);
        }
        const requestedAtMs = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
        try {
          const { request } = await requestNodePairing(
            {
              nodeId: "node-1",
              platform: "android",
              caps: ["voiceWake"],
              commands: ["system.run"],
            },
            baseDir,
          );
          const database = openOpenClawStateDatabase({
            env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
          });
          now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
          const expectedPending = { requestId: request.requestId, caps: ["voiceWake"] };

          expect
            .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          expect
            .soft((await listDevicePairingReadOnly(baseDir)).paired[0]?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          expect.soft((await listNodePairing(baseDir)).pending).toEqual([request]);
          await updatePairedDeviceMetadata("node-1", { displayName: "Still connected" }, baseDir);
          expect(closeOpenClawStateDatabaseByPath(database.path)).toBe(true);
          expect
            .soft((await getPairedDevice("node-1", baseDir))?.pendingNodeSurface)
            .toMatchObject(expectedPending);
          await expect
            .soft(
              approveNodePairing(
                request.requestId,
                { callerScopes: ["operator.pairing"] },
                baseDir,
              ),
            )
            .resolves.toEqual({ status: "forbidden", missingScope: "operator.admin" });
          await expect
            .soft(
              approveNodePairing(
                request.requestId,
                { callerScopes: ["operator.pairing", "operator.admin"] },
                baseDir,
              ),
            )
            .resolves.toMatchObject({
              requestId: request.requestId,
              node: { caps: ["voiceWake"] },
            });
          expect((await listNodePairing(baseDir)).pending).toEqual([]);
        } finally {
          now.mockRestore();
        }
      });
    },
  );

  test.each(["rejection", "successful reconnect", "node-role removal"])(
    "resolves aged capability reapproval through %s",
    async (resolution) => {
      await withNodePairingDir(async (baseDir) => {
        await setupPairedNode(baseDir);
        if (resolution === "node-role removal") {
          const operator = await requestDevicePairing(
            { deviceId: "node-1", publicKey: "test-key-node-1", role: "operator", scopes: [] },
            baseDir,
          );
          await approveDevicePairing(operator.request.requestId, { callerScopes: [] }, baseDir);
        }
        const requestedAtMs = Date.now();
        const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
        try {
          const { request } = await requestNodePairing(
            { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
            baseDir,
          );
          now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
          expect((await listNodePairing(baseDir)).pending).toEqual([request]);
          if (resolution === "rejection") {
            await expect(rejectNodePairing(request.requestId, baseDir)).resolves.toEqual({
              requestId: request.requestId,
              nodeId: "node-1",
            });
          } else if (resolution === "successful reconnect") {
            const { cleanupClaim } = await beginNodePairingConnect("node-1", baseDir);
            await expect(
              finalizeNodePairingCleanupClaim(expectDefined(cleanupClaim, "cleanup claim")),
            ).resolves.toEqual([{ requestId: request.requestId, nodeId: "node-1" }]);
          } else {
            await expect(
              removePairedDeviceRole({ deviceId: "node-1", role: "node", baseDir }),
            ).resolves.toEqual({ deviceId: "node-1", role: "node", removedDevice: false });
          }
          const database = openOpenClawStateDatabase({
            env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
          });
          expect(closeOpenClawStateDatabaseByPath(database.path)).toBe(true);
          const device = await getPairedDevice("node-1", baseDir);
          expect(device?.pendingNodeSurface).toBeUndefined();
          if (resolution === "node-role removal") {
            expect(device?.roles).toEqual(["operator"]);
            expect(device?.nodeSurface).toBeUndefined();
          } else {
            expect(device?.nodeSurface?.commands).toEqual(["system.run"]);
          }
          await expect(
            approveNodePairing(
              request.requestId,
              { callerScopes: ["operator.pairing", "operator.admin"] },
              baseDir,
            ),
          ).resolves.toBeNull();
        } finally {
          now.mockRestore();
        }
      });
    },
  );

  test("keeps an aged capability reapproval through a recorded disconnect", async () => {
    await withNodePairingDir(async (baseDir) => {
      const generation = await setupPairedNode(baseDir);
      await expect(
        recordPairedNodeConnection("node-1", 1_000, baseDir, generation),
      ).resolves.toEqual({ recorded: true, firstConnection: true });
      const requestedAtMs = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
      try {
        const { request } = await requestNodePairing(
          { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
          baseDir,
        );
        now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);

        await expect(
          recordPairedNodeDisconnection({
            nodeId: "node-1",
            connectedAtMs: 1_000,
            disconnectedAtMs: 2_000,
            expectedPairingGeneration: generation,
            baseDir,
          }),
        ).resolves.toEqual({ recorded: true });

        const database = openOpenClawStateDatabase({
          env: { ...process.env, OPENCLAW_STATE_DIR: baseDir },
        });
        expect(closeOpenClawStateDatabaseByPath(database.path)).toBe(true);
        expect((await listNodePairing(baseDir)).pending).toEqual([request]);
      } finally {
        now.mockRestore();
      }
    });
  });

  test("supersedes an aged capability request with a changed surface", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const requestedAtMs = Date.now();
      const now = vi.spyOn(Date, "now").mockReturnValue(requestedAtMs);
      try {
        const first = await requestNodePairing(
          { nodeId: "node-1", caps: ["voiceWake"], commands: ["system.run"] },
          baseDir,
        );
        now.mockReturnValue(requestedAtMs + 24 * 60 * 60 * 1000);
        const second = await requestNodePairing(
          {
            nodeId: "node-1",
            caps: ["voiceWake"],
            commands: ["system.run", "system.which"],
          },
          baseDir,
        );

        expect(second.superseded).toEqual([
          { requestId: first.request.requestId, nodeId: "node-1" },
        ]);
        expect((await listNodePairing(baseDir)).pending).toEqual([second.request]);
        await expect(
          approveNodePairing(
            first.request.requestId,
            { callerScopes: ["operator.pairing", "operator.admin"] },
            baseDir,
          ),
        ).resolves.toBeNull();
      } finally {
        now.mockRestore();
      }
    });
  });
});
