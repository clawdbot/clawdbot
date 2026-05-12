import fs from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createSuiteTempRootTracker } from "../test-helpers/temp-dir.js";
import {
  approveNodePairing,
  getPairedNode,
  listNodePairing,
  removePairedNode,
  requestNodePairing,
  updatePairedNodeMetadata,
  verifyNodeToken,
} from "./node-pairing.js";
import { resolvePairingPaths } from "./pairing-files.js";

async function setupPairedNode(baseDir: string): Promise<string> {
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
  const paired = await getPairedNode("node-1", baseDir);
  expect(typeof paired?.token).toBe("string");
  expect(paired?.token.length).toBeGreaterThan(0);
  return paired!.token;
}

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-" });

async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  return await run(await tempDirs.make("case"));
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

describe("node pairing tokens", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test("reuses pending requests for metadata refreshes", async () => {
    await withNodePairingDir(async (baseDir) => {
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
      expect(pairing.paired).toEqual([]);
    });
  });

  test("supersedes pending requests when the approval surface changes", async () => {
    await withNodePairingDir(async (baseDir) => {
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
      expect(list.pending[0]?.caps).toEqual(["camera"]);
      expect(list.pending[0]?.commands).toEqual(["canvas.snapshot", "system.run"]);
      expect(list.pending[0]?.permissions).toEqual({ camera: true });

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
      expect(approvedNode.caps).toEqual(["camera"]);
      expect(approvedNode.commands).toEqual(["canvas.snapshot", "system.run"]);
      expect(approvedNode.permissions).toEqual({ camera: true });

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

  test("recovers when pairing state files were written as arrays", async () => {
    await withNodePairingDir(async (baseDir) => {
      const paths = resolvePairingPaths(baseDir, "nodes");
      await fs.mkdir(paths.dir, { recursive: true });
      await fs.writeFile(paths.pendingPath, "[]", "utf8");
      await fs.writeFile(paths.pairedPath, "[]", "utf8");

      const pending = await requestNodePairing(
        {
          nodeId: "node-array-state",
          platform: "darwin",
          commands: ["system.run"],
        },
        baseDir,
      );
      const approved = await approveNodePairing(
        pending.request.requestId,
        { callerScopes: ["operator.pairing", "operator.admin"] },
        baseDir,
      );

      const approvedRecord = requireRecord(approved);
      const approvedNode = requireRecord(approvedRecord.node);
      expect(approvedNode.nodeId).toBe("node-array-state");
      expect(Array.isArray(JSON.parse(await fs.readFile(paths.pendingPath, "utf8")))).toBe(false);
      const pairedState = requireRecord(JSON.parse(await fs.readFile(paths.pairedPath, "utf8")));
      const pairedNode = requireRecord(pairedState["node-array-state"]);
      expect(pairedNode.nodeId).toBe("node-array-state");
    });
  });

  test("generates base64url node tokens and rejects mismatches", async () => {
    await withNodePairingDir(async (baseDir) => {
      const token = await setupPairedNode(baseDir);

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      const verified = await verifyNodeToken("node-1", token, baseDir);
      expect(verified.ok).toBe(true);
      expect(verified.node?.nodeId).toBe("node-1");
      await expect(verifyNodeToken("node-1", "x".repeat(token.length), baseDir)).resolves.toEqual({
        ok: false,
      });

      const multibyteToken = "é".repeat(token.length);
      expect(Buffer.from(multibyteToken).length).not.toBe(Buffer.from(token).length);

      await expect(verifyNodeToken("node-1", multibyteToken, baseDir)).resolves.toEqual({
        ok: false,
      });
    });
  });

  test("removes paired nodes without disturbing pending requests", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);
      const pending = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
        },
        baseDir,
      );

      await expect(removePairedNode("node-1", baseDir)).resolves.toEqual({ nodeId: "node-1" });
      await expect(removePairedNode("node-1", baseDir)).resolves.toBeNull();
      await expect(getPairedNode("node-1", baseDir)).resolves.toBeNull();
      const pairing = await listNodePairing(baseDir);
      expect(pairing.pending).toHaveLength(1);
      expect(pairing.pending[0]?.requestId).toBe(pending.request.requestId);
      expect(pairing.pending[0]?.nodeId).toBe("node-2");
      expect(pairing.paired).toEqual([]);
    });
  });

  test("requires the right scopes to approve node requests", async () => {
    await withNodePairingDir(async (baseDir) => {
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
      await expect(getPairedNode("node-1", baseDir)).resolves.toBeNull();

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

  test("refuses to overwrite corrupt paired node state when requesting pairing", async () => {
    await withNodePairingDir(async (baseDir) => {
      const { dir, pairedPath } = resolvePairingPaths(baseDir, "nodes");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(pairedPath, "{not-json}", "utf8");

      await expect(
        requestNodePairing(
          {
            nodeId: "node-1",
            platform: "darwin",
          },
          baseDir,
        ),
      ).rejects.toThrow(/paired\.json/);
      await expect(fs.readFile(pairedPath, "utf8")).resolves.toBe("{not-json}");
    });
  });

  test("updates paired node last-seen metadata and reports missing nodes", async () => {
    await withNodePairingDir(async (baseDir) => {
      await setupPairedNode(baseDir);

      await expect(
        updatePairedNodeMetadata(
          "node-1",
          {
            lastSeenAtMs: 1234,
            lastSeenReason: "silent_push",
          },
          baseDir,
        ),
      ).resolves.toBe(true);
      await expect(updatePairedNodeMetadata("missing", { lastSeenAtMs: 1 }, baseDir)).resolves.toBe(
        false,
      );

      const pairedNode = await getPairedNode("node-1", baseDir);
      expect(pairedNode?.lastSeenAtMs).toBe(1234);
      expect(pairedNode?.lastSeenReason).toBe("silent_push");
    });
  });
});
