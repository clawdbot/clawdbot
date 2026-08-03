// Covers paired-node reapproval reuse and changed-surface write limits.
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { approveDevicePairing, requestDevicePairing } from "../infra/device-pairing.js";
import {
  approveNodePairing,
  beginNodePairingConnect,
  listNodePairing,
  releaseNodePairingCleanupClaim,
  requestNodePairing,
} from "../infra/node-pairing.js";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import { createNodeReapprovalCoordinator } from "./node-reapproval-coordinator.js";

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-reapproval-" });

async function setupPairedNode(baseDir: string): Promise<void> {
  // Node surfaces attach to paired devices, so device pairing comes first.
  const devicePairing = await requestDevicePairing(
    {
      deviceId: "node-1",
      publicKey: "pk-node-1",
      role: "node",
      roles: ["node"],
      scopes: [],
    },
    baseDir,
  );
  await approveDevicePairing(devicePairing.request.requestId, { callerScopes: [] }, baseDir);
  const request = await requestNodePairing(
    {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera"],
    },
    baseDir,
  );
  await approveNodePairing(
    request.request.requestId,
    { callerScopes: ["operator.pairing"] },
    baseDir,
  );
}

describe("node reapproval coordinator", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test("reuses identical pending state without consuming changed-surface quota", async () => {
    const baseDir = await tempDirs.make("reuse");
    await setupPairedNode(baseDir);
    const pending = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });

    const matchingConnect = await beginNodePairingConnect("node-1", baseDir);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "screen"],
        },
        cleanupClaim: matchingConnect.cleanupClaim,
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    if (matchingConnect.cleanupClaim) {
      await releaseNodePairingCleanupClaim(matchingConnect.cleanupClaim);
    }

    const changedConnect = await beginNodePairingConnect("node-1", baseDir);
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "microphone"],
        },
        cleanupClaim: changedConnect.cleanupClaim,
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
      created: true,
    });
    if (changedConnect.cleanupClaim) {
      await releaseNodePairingCleanupClaim(changedConnect.cleanupClaim);
    }

    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "location"],
        },
        baseDir,
      }),
    ).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "microphone"] }),
    ]);

    coordinator.dispose();
  });

  test("stops accepting work after disposal", async () => {
    const baseDir = await tempDirs.make("dispose");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator();
    coordinator.dispose();

    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          caps: ["camera", "screen"],
        },
        baseDir,
      }),
    ).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([]);
  });

  test("bounds metadata refreshes while preserving the latest accepted values", async () => {
    const baseDir = await tempDirs.make("metadata");
    await setupPairedNode(baseDir);
    await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        displayName: "Old Name",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });

    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          displayName: "New Name",
          caps: ["camera", "screen"],
        },
        baseDir,
      }),
    ).resolves.toMatchObject({
      request: { displayName: "New Name" },
      created: false,
    });
    await expect(
      coordinator.request({
        input: {
          nodeId: "node-1",
          platform: "darwin",
          displayName: "Newest Name",
          caps: ["camera", "screen"],
        },
        baseDir,
      }),
    ).resolves.toBeNull();
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ displayName: "New Name" }),
    ]);

    coordinator.dispose();
  });

  test("coalesces concurrent reconnect work before pairing storage", async () => {
    const baseDir = await tempDirs.make("concurrent");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 1,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });
    const input = {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera", "screen"],
    };

    const first = coordinator.request({ input, baseDir });
    const coalesced = coordinator.request({ input, baseDir });

    await expect(first).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(coalesced).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
      created: false,
    });
    expect((await listNodePairing(baseDir)).pending).toHaveLength(1);

    coordinator.dispose();
  });

  test("queues one distinct concurrent declaration", async () => {
    const baseDir = await tempDirs.make("distinct");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });

    const first = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    });
    const second = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "microphone"],
      },
      baseDir,
    });

    await expect(first).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(second).resolves.toMatchObject({
      request: { caps: ["camera", "microphone"] },
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "microphone"] }),
    ]);

    coordinator.dispose();
  });

  test("keeps only the latest request waiting behind active work", async () => {
    const baseDir = await tempDirs.make("latest");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });

    const active = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    });
    const superseded = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "microphone"],
      },
      baseDir,
    });
    const latest = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "location"],
      },
      baseDir,
    });

    await expect(active).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(superseded).resolves.toBeNull();
    await expect(latest).resolves.toMatchObject({
      request: { caps: ["camera", "location"] },
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "location"] }),
    ]);

    coordinator.dispose();
  });

  test("cancels queued work when the latest declaration matches active work", async () => {
    const baseDir = await tempDirs.make("active-latest");
    await setupPairedNode(baseDir);
    const coordinator = createNodeReapprovalCoordinator({
      maxAttempts: 2,
      windowMs: 60_000,
      lockoutMs: 60_000,
    });
    const activeInput = {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera", "screen"],
    };

    const active = coordinator.request({ input: activeInput, baseDir });
    const stale = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "microphone"],
      },
      baseDir,
    });
    const latest = coordinator.request({ input: activeInput, baseDir });

    await expect(active).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
    });
    await expect(stale).resolves.toBeNull();
    await expect(latest).resolves.toMatchObject({
      request: { caps: ["camera", "screen"] },
      created: false,
    });
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ caps: ["camera", "screen"] }),
    ]);

    coordinator.dispose();
  });

  test("retains the newest cleanup claim across equivalent reconnects", async () => {
    const baseDir = await tempDirs.make("cleanup-generation");
    await setupPairedNode(baseDir);
    const pending = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const first = await beginNodePairingConnect("node-1", baseDir);
    const staleCleanup = await beginNodePairingConnect("node-1", baseDir);
    const latest = await beginNodePairingConnect("node-1", baseDir);
    expect(first.cleanupClaim).toBeDefined();
    expect(staleCleanup.cleanupClaim).toBeDefined();
    expect(latest.cleanupClaim).toBeDefined();
    const coordinator = createNodeReapprovalCoordinator();
    const input = {
      nodeId: "node-1",
      platform: "darwin",
      caps: ["camera", "screen"],
    };

    const firstReuse = coordinator.request({
      input,
      cleanupClaim: first.cleanupClaim,
      baseDir,
    });
    const latestReuse = coordinator.request({
      input,
      cleanupClaim: latest.cleanupClaim,
      baseDir,
    });
    const cleanup = coordinator.finalizeCleanup(staleCleanup.cleanupClaim!);

    await expect(firstReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
    });
    await expect(latestReuse).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(cleanup).resolves.toEqual([]);
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ requestId: pending.request.requestId }),
    ]);

    coordinator.dispose();
  });

  test("serializes stale cleanup behind pending-request reuse", async () => {
    const baseDir = await tempDirs.make("cleanup-order");
    await setupPairedNode(baseDir);
    const pending = await requestNodePairing(
      {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      baseDir,
    );
    const snapshot = await beginNodePairingConnect("node-1", baseDir);
    expect(snapshot.cleanupClaim).toBeDefined();
    const coordinator = createNodeReapprovalCoordinator();

    const reused = coordinator.request({
      input: {
        nodeId: "node-1",
        platform: "darwin",
        caps: ["camera", "screen"],
      },
      cleanupClaim: snapshot.cleanupClaim,
      baseDir,
    });
    const cleanup = coordinator.finalizeCleanup(snapshot.cleanupClaim!);

    await expect(reused).resolves.toMatchObject({
      request: { requestId: pending.request.requestId },
      created: false,
    });
    await expect(cleanup).resolves.toEqual([]);
    expect((await listNodePairing(baseDir)).pending).toEqual([
      expect.objectContaining({ requestId: pending.request.requestId }),
    ]);

    coordinator.dispose();
  });
});
