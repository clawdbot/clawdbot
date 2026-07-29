// Tests node capability-surface approvals stored on paired device records.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createDeferred } from "../test-utils/deferred.js";
import {
  approveDevicePairing,
  getPairedDevice,
  requestDevicePairing,
  resolveNodePairingGeneration,
  withPairedDeviceRecords,
} from "./device-pairing.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  finalizeNodePairingCleanupClaim,
  listNodePairing,
  recordPairedNodeConnection,
  releaseNodePairingCleanupClaim,
  renamePairedNode,
  requestNodePairing,
  reusePendingNodePairingForReconnect,
  updatePairedNodeBins,
} from "./node-pairing.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-" });

async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  return await run(await tempDirs.make("case"));
}

async function seedNodeDevice(baseDir: string, nodeId: string): Promise<void> {
  const request = await requestDevicePairing(
    { deviceId: nodeId, publicKey: `pk-${nodeId}`, role: "node", roles: ["node"], scopes: [] },
    baseDir,
  );
  await approveDevicePairing(request.request.requestId, { callerScopes: [] }, baseDir);
}

async function setupPairedNode(baseDir: string): Promise<void> {
  await seedNodeDevice(baseDir, "node-1");
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      platform: "darwin",
      commands: ["system.run"],
    },
    baseDir,
  );
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing", "operator.admin"] },
    baseDir,
  );
  const paired = await findPairedNode("node-1", baseDir);
  expect(paired?.nodeId).toBe("node-1");
}

async function findPairedNode(nodeId: string, baseDir: string) {
  const pairing = await listNodePairing(baseDir);
  return pairing.paired.find((node) => node.nodeId === nodeId) ?? null;
}

function requireRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected a non-array record");
  }
  return value as Record<string, unknown>;
}

function findRecordByField<T extends Record<string, unknown>>(
  records: T[],
  field: string,
  value: unknown,
): T {
  const record = records.find((entry) => entry[field] === value);
  if (!record) {
    throw new Error(`Expected record with ${field}=${String(value)}`);
  }
  return record;
}

describe("node surface approvals", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test("requires a paired device before accepting surface requests", async () => {
    await withNodePairingDir(async (baseDir) => {
      await expect(
        requestNodePairing({ nodeId: "node-unpaired", platform: "darwin" }, baseDir),
      ).rejects.toThrow(/paired device/);
    });
  });

  test("reuses pending requests for metadata refreshes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await seedNodeDevice(baseDir, "node-1");
      const first = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );
      const second = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
        },
        baseDir,
      );

      expect(first.created).toBe(true);
      expect(second.created).toBe(false);
      expect(second.request.requestId).toBe(first.request.requestId);
      expect("revision" in first.request).toBe(false);
      expect("revision" in second.request).toBe(false);

      await seedNodeDevice(baseDir, "node-2");
      const commandFirst = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
          commands: ["canvas.snapshot"],
        },
        baseDir,
      );

      const commandSecond = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
          displayName: "Updated Node",
          commands: ["canvas.snapshot"],
        },
        baseDir,
      );

      expect(commandSecond.created).toBe(false);
      expect(commandSecond.superseded).toBeUndefined();
      expect(commandSecond.request.requestId).toBe(commandFirst.request.requestId);
      expect(commandSecond.request.displayName).toBe("Updated Node");
      expect(commandSecond.request.commands).toEqual(["canvas.snapshot"]);

      await seedNodeDevice(baseDir, "node-3");
      const reorderedFirst = await requestNodePairing(
        {
          nodeId: "node-3",
          platform: "darwin",
          caps: ["camera", "screen"],
          commands: ["canvas.snapshot", "system.run"],
        },
        baseDir,
      );
      const reorderedSecond = await requestNodePairing(
        {
          nodeId: "node-3",
          platform: "darwin",
          caps: ["screen", "camera"],
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );

      expect(reorderedSecond.created).toBe(false);
      expect(reorderedSecond.superseded).toBeUndefined();
      expect(reorderedSecond.request.requestId).toBe(reorderedFirst.request.requestId);

      await seedNodeDevice(baseDir, "node-4");
      await requestNodePairing(
        {
          nodeId: "node-4",
          platform: "darwin",
          commands: ["canvas.present"],
        },
        baseDir,
      );

      const pairing = await listNodePairing(baseDir);
      const pendingNode = findRecordByField(pairing.pending, "nodeId", "node-4");
      expect(pendingNode.commands).toEqual(["canvas.present"]);
      expect(pendingNode.requiredApproveScopes).toEqual(["operator.pairing", "operator.write"]);
      expect("revision" in pendingNode).toBe(false);
      expect(pairing.paired).toEqual([]);
    });
  });

  test("supersedes pending requests when the approval surface changes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await seedNodeDevice(baseDir, "node-1");
      const first = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera"],
          commands: ["canvas.snapshot"],
          permissions: { camera: true },
        },
        baseDir,
      );
      const second = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["canvas.snapshot", "system.run"],
        },
        baseDir,
      );

      expect(second.created).toBe(true);
      expect(second.superseded).toEqual([{ requestId: first.request.requestId, nodeId: "node-1" }]);
      expect(second.request.requestId).not.toBe(first.request.requestId);

      const list = await listNodePairing(baseDir);
      expect(list.pending).toHaveLength(1);
      expect(list.pending[0]?.requestId).toBe(second.request.requestId);
      expect(list.pending[0]?.commands).toEqual(["canvas.snapshot", "system.run"]);

      await expect(
        approveNodePairing(
          first.request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          baseDir,
        ),
      ).resolves.toBeNull();

      const approved = await approveNodePairing(
        second.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin"] },
        baseDir,
      );
      const approvedRecord = requireRecord(approved);
      const approvedNode = requireRecord(approvedRecord.node);
      expect(approvedRecord.requestId).toBe(second.request.requestId);
      expect(approvedNode.commands).toEqual(["canvas.snapshot", "system.run"]);

      await seedNodeDevice(baseDir, "node-2");
      const capsFirst = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
          caps: ["camera"],
        },
        baseDir,
      );
      const capsSecond = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
          caps: ["camera", "screen"],
        },
        baseDir,
      );
      expect(capsSecond.created).toBe(true);
      expect(capsSecond.superseded).toEqual([
        { requestId: capsFirst.request.requestId, nodeId: "node-2" },
      ]);
      expect(capsSecond.request.requestId).not.toBe(capsFirst.request.requestId);

      await seedNodeDevice(baseDir, "node-3");
      const permissionsFirst = await requestNodePairing(
        {
          nodeId: "node-3",
          platform: "darwin",
          permissions: { camera: true },
        },
        baseDir,
      );
      const permissionsSecond = await requestNodePairing(
        {
          nodeId: "node-3",
          platform: "darwin",
          permissions: { camera: true, screen: true },
        },
        baseDir,
      );

      expect(permissionsSecond.created).toBe(true);
      expect(permissionsSecond.superseded).toEqual([
        { requestId: permissionsFirst.request.requestId, nodeId: "node-3" },
      ]);
      expect(permissionsSecond.request.requestId).not.toBe(permissionsFirst.request.requestId);
    });
  });

  test("rejects every pending request for one node without removing its approval", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const snapshot = await beginNodePairingConnect("node-1", baseDir);
      expect(snapshot.cleanupClaim).toBeDefined();

      await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([
        { requestId: pending.request.requestId, nodeId: "node-1" },
      ]);
      await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);

      const pairing = await listNodePairing(baseDir);
      expect(pairing.pending).toEqual([]);
      expect(pairing.paired).toHaveLength(1);
      expect(pairing.paired[0]?.nodeId).toBe("node-1");
      await expect(findPairedNode("node-1", baseDir)).resolves.toMatchObject({
        commands: ["system.run"],
      });
    });
  });

  test("preserves a pending request refreshed after the connect snapshot", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const snapshot = await beginNodePairingConnect("node-1", baseDir);
      expect(snapshot.cleanupClaim).toBeDefined();
      const refreshed = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      expect(refreshed.request.requestId).toBe(pending.request.requestId);

      await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
      expect((await listNodePairing(baseDir)).pending).toHaveLength(1);
    });
  });

  test("reuses an unchanged reconnect request without leaving stale cleanup ownership", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const snapshot = await beginNodePairingConnect("node-1", baseDir);
      expect(snapshot.cleanupClaim).toBeDefined();

      await expect(
        reusePendingNodePairingForReconnect(
          {
            nodeId: "node-1",
            platform: "darwin",
            commands: ["system.run", "canvas.snapshot"],
          },
          snapshot.cleanupClaim,
          baseDir,
        ),
      ).resolves.toMatchObject({
        request: { requestId: pending.request.requestId },
        created: false,
      });
      await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
      await expect(
        approveNodePairing(
          pending.request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          baseDir,
        ),
      ).resolves.toMatchObject({ requestId: pending.request.requestId });
    });
  });

  test("does not reuse a reconnect request when pending metadata changed", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          displayName: "Old Name",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const snapshot = await beginNodePairingConnect("node-1", baseDir);

      await expect(
        reusePendingNodePairingForReconnect(
          {
            nodeId: "node-1",
            platform: "darwin",
            displayName: "New Name",
            commands: ["system.run", "canvas.snapshot"],
          },
          snapshot.cleanupClaim,
          baseDir,
        ),
      ).resolves.toBeNull();
      if (snapshot.cleanupClaim) {
        await releaseNodePairingCleanupClaim(snapshot.cleanupClaim);
      }
    });
  });

  test("preserves newer cleanup ownership after an older reconnect reuses pending state", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const matchingReconnect = await beginNodePairingConnect("node-1", baseDir);
      const changedReconnect = await beginNodePairingConnect("node-1", baseDir);
      expect(matchingReconnect.cleanupClaim).toBeDefined();
      expect(changedReconnect.cleanupClaim).toBeDefined();

      await reusePendingNodePairingForReconnect(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        matchingReconnect.cleanupClaim,
        baseDir,
      );

      await expect(
        finalizeNodePairingCleanupClaim(changedReconnect.cleanupClaim!),
      ).resolves.toEqual([{ requestId: pending.request.requestId, nodeId: "node-1" }]);
      expect((await listNodePairing(baseDir)).pending).toEqual([]);
    });
  });

  test("preserves a replacement pending request created after the connect snapshot", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const snapshot = await beginNodePairingConnect("node-1", baseDir);
      expect(snapshot.cleanupClaim).toBeDefined();
      const replacement = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.present"],
        },
        baseDir,
      );
      expect(replacement.request.requestId).not.toBe(pending.request.requestId);

      await expect(finalizeNodePairingCleanupClaim(snapshot.cleanupClaim!)).resolves.toEqual([]);
      const remaining = (await listNodePairing(baseDir)).pending;
      expect(remaining).toHaveLength(1);
      expect(remaining[0]?.requestId).toBe(replacement.request.requestId);
    });
  });

  test("blocks approval until a reconnect cleanup claim is released", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      const firstSnapshot = await beginNodePairingConnect("node-1", baseDir);
      const secondSnapshot = await beginNodePairingConnect("node-1", baseDir);
      expect(firstSnapshot.cleanupClaim).toBeDefined();
      expect(secondSnapshot.cleanupClaim?.generation).toBeGreaterThan(
        firstSnapshot.cleanupClaim!.generation,
      );

      await expect(
        approveNodePairing(
          pending.request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          baseDir,
        ),
      ).resolves.toBeNull();

      await releaseNodePairingCleanupClaim(firstSnapshot.cleanupClaim!);
      await expect(
        approveNodePairing(
          pending.request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          baseDir,
        ),
      ).resolves.toBeNull();

      await releaseNodePairingCleanupClaim(secondSnapshot.cleanupClaim!);
      await expect(
        approveNodePairing(
          pending.request.requestId,
          { callerScopes: ["operator.pairing", "operator.admin"] },
          baseDir,
        ),
      ).resolves.toMatchObject({ requestId: pending.request.requestId });
    });
  });

  test("requires the right scopes to approve node requests", async () => {
    await withNodePairingDir(async (baseDir) => {
      await seedNodeDevice(baseDir, "node-1");
      const systemRunRequest = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run"],
        },
        baseDir,
      );

      await expect(
        approveNodePairing(
          systemRunRequest.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.admin",
      });
      await expect(findPairedNode("node-1", baseDir)).resolves.toBeNull();

      await seedNodeDevice(baseDir, "node-2");
      const commandlessRequest = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(
        approveNodePairing(commandlessRequest.request.requestId, { callerScopes: [] }, baseDir),
      ).resolves.toEqual({
        status: "forbidden",
        missingScope: "operator.pairing",
      });
      const approved = await approveNodePairing(
        commandlessRequest.request.requestId,
        { callerScopes: ["operator.pairing"] },
        baseDir,
      );
      const approvedRecord = requireRecord(approved);
      const approvedNode = requireRecord(approvedRecord.node);
      expect(approvedRecord.requestId).toBe(commandlessRequest.request.requestId);
      expect(approvedNode.nodeId).toBe("node-2");
      expect(approvedNode.commands).toBeUndefined();
    });
  });

  test("updates remote skill bins and reports missing nodes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const generation = resolveNodePairingGeneration(await getPairedDevice("node-1", baseDir));
      if (!generation) {
        throw new Error("expected node pairing generation");
      }

      await expect(recordPairedNodeConnection("node-1", 1_234, baseDir)).resolves.toEqual({
        recorded: true,
        firstConnection: true,
      });
      await expect(updatePairedNodeBins("node-1", ["ffmpeg"], generation, baseDir)).resolves.toBe(
        true,
      );
      await expect(updatePairedNodeBins("missing", ["ffmpeg"], generation, baseDir)).resolves.toBe(
        false,
      );

      const pairedNode = await findPairedNode("node-1", baseDir);
      expect(pairedNode?.lastConnectedAtMs).toBe(1_234);
      expect(pairedNode?.bins).toEqual(["ffmpeg"]);
    });
  });

  test("rejects retired-generation bins after node-surface reapproval", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const previousGeneration = resolveNodePairingGeneration(
        await getPairedDevice("node-1", baseDir),
      );
      if (!previousGeneration) {
        throw new Error("expected previous node pairing generation");
      }
      await expect(
        updatePairedNodeBins("node-1", ["retired-bin"], previousGeneration, baseDir),
      ).resolves.toBe(true);

      const pending = await requestNodePairing(
        { nodeId: "node-1", platform: "darwin", commands: ["system.run", "system.which"] },
        baseDir,
      );
      await approveNodePairing(
        pending.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin"] },
        baseDir,
      );

      const currentGeneration = resolveNodePairingGeneration(
        await getPairedDevice("node-1", baseDir),
      );
      if (!currentGeneration) {
        throw new Error("expected current node pairing generation");
      }
      expect(currentGeneration.key).not.toBe(previousGeneration.key);
      expect((await findPairedNode("node-1", baseDir))?.bins).toBeUndefined();
      await expect(
        updatePairedNodeBins("node-1", ["stale-write"], previousGeneration, baseDir),
      ).resolves.toBe(false);
      await expect(
        updatePairedNodeBins("node-1", ["current-bin"], currentGeneration, baseDir),
      ).resolves.toBe(true);
      expect((await findPairedNode("node-1", baseDir))?.bins).toEqual(["current-bin"]);
    });
  });

  test("atomically grants one first-connection claim across concurrent handshakes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);

      const claims = await Promise.all([
        recordPairedNodeConnection("node-1", 1_000, baseDir),
        recordPairedNodeConnection("node-1", 2_000, baseDir),
      ]);

      expect(claims.filter((claim) => claim.recorded && claim.firstConnection)).toHaveLength(1);
      expect(claims.every((claim) => claim.recorded)).toBe(true);
      expect((await findPairedNode("node-1", baseDir))?.lastConnectedAtMs).toBe(2_000);
      await expect(recordPairedNodeConnection("node-1", 1_500, baseDir)).resolves.toEqual({
        recorded: true,
        firstConnection: false,
      });
      expect((await findPairedNode("node-1", baseDir))?.lastConnectedAtMs).toBe(2_000);
      await expect(recordPairedNodeConnection("node-1", 3_000, baseDir)).resolves.toEqual({
        recorded: true,
        firstConnection: false,
      });
      await expect(recordPairedNodeConnection("missing", 4_000, baseDir)).resolves.toEqual({
        recorded: false,
      });
      expect((await findPairedNode("node-1", baseDir))?.lastConnectedAtMs).toBe(3_000);
    });
  });

  test("serializes connection metadata with locked node-surface mutations", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);

      const snapshotLoaded = createDeferred();
      const releaseMutation = createDeferred();
      const lockedMutation = withPairedDeviceRecords(baseDir, async (pairedByDeviceId) => {
        const device = pairedByDeviceId["node-1"];
        if (!device?.nodeSurface) {
          throw new Error("expected paired node surface");
        }
        device.nodeSurface = { ...device.nodeSurface, bins: ["ffmpeg"] };
        snapshotLoaded.resolve();
        await releaseMutation.promise;
        return { value: true, persist: true };
      });
      await snapshotLoaded.promise;

      let connectionSettled = false;
      const connection = recordPairedNodeConnection("node-1", 1_234, baseDir).then((result) => {
        connectionSettled = true;
        return result;
      });
      await Promise.resolve();
      expect(connectionSettled).toBe(false);

      releaseMutation.resolve();
      await expect(lockedMutation).resolves.toBe(true);
      await expect(connection).resolves.toEqual({ recorded: true, firstConnection: true });
      expect(await findPairedNode("node-1", baseDir)).toMatchObject({
        bins: ["ffmpeg"],
        lastConnectedAtMs: 1_234,
      });
    });
  });

  test("rejects connection metadata from a retired pairing generation", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const previousGeneration = resolveNodePairingGeneration(
        await getPairedDevice("node-1", baseDir),
      );
      if (!previousGeneration) {
        throw new Error("expected initial node pairing generation");
      }

      const pending = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );
      await approveNodePairing(
        pending.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin", "operator.write"] },
        baseDir,
      );
      const currentGeneration = resolveNodePairingGeneration(
        await getPairedDevice("node-1", baseDir),
      );
      if (!currentGeneration) {
        throw new Error("expected replacement node pairing generation");
      }
      expect(currentGeneration.key).not.toBe(previousGeneration.key);

      await expect(
        recordPairedNodeConnection("node-1", 1_000, baseDir, previousGeneration),
      ).resolves.toEqual({ recorded: false });
      expect((await findPairedNode("node-1", baseDir))?.lastConnectedAtMs).toBeUndefined();

      await expect(
        recordPairedNodeConnection("node-1", 2_000, baseDir, currentGeneration),
      ).resolves.toEqual({ recorded: true, firstConnection: true });
      expect((await findPairedNode("node-1", baseDir))?.lastConnectedAtMs).toBe(2_000);
    });
  });

  test("keeps the approved node surface across a device pairing re-approval", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pendingSurface = await requestNodePairing(
        {
          nodeId: "node-1",
          platform: "darwin",
          commands: ["system.run", "canvas.snapshot"],
        },
        baseDir,
      );

      // A device repair (same id, fresh keypair) rebuilds the paired record;
      // approved and pending node surfaces must survive that rebuild.
      const repair = await requestDevicePairing(
        {
          deviceId: "node-1",
          publicKey: "pk-node-1-rotated",
          role: "node",
          roles: ["node"],
          scopes: [],
        },
        baseDir,
      );
      await approveDevicePairing(repair.request.requestId, { callerScopes: [] }, baseDir);

      const paired = await findPairedNode("node-1", baseDir);
      expect(paired?.commands).toEqual(["system.run"]);
      const pending = (await listNodePairing(baseDir)).pending;
      expect(pending).toHaveLength(1);
      expect(pending[0]?.requestId).toBe(pendingSurface.request.requestId);
    });
  });

  test("renames the operator-facing node name without touching approval state", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);

      const renamed = await renamePairedNode("node-1", "Living Room iPad", baseDir);
      expect(renamed?.displayName).toBe("Living Room iPad");
      await expect(renamePairedNode("missing", "Nope", baseDir)).resolves.toBeNull();

      const pairedNode = await findPairedNode("node-1", baseDir);
      expect(pairedNode?.displayName).toBe("Living Room iPad");
      expect(pairedNode?.commands).toEqual(["system.run"]);
    });
  });
});
