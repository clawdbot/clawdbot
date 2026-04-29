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
  expect(paired).not.toBeNull();
  if (!paired) {
    throw new Error("expected node to be paired");
  }
  return paired.token;
}

const tempDirs = createSuiteTempRootTracker({ prefix: "openclaw-node-pairing-" });

async function withNodePairingDir<T>(run: (baseDir: string) => Promise<T>): Promise<T> {
  return await run(await tempDirs.make("case"));
}

describe("node pairing tokens", () => {
  beforeAll(async () => {
    await tempDirs.setup();
  });

  afterAll(async () => {
    await tempDirs.cleanup();
  });

  test("reuses and refreshes pending requests", async () => {
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
          commands: ["canvas.snapshot", "system.run"],
        },
        baseDir,
      );
      const commandThird = await requestNodePairing(
        {
          nodeId: "node-2",
          platform: "darwin",
          displayName: "Updated Node",
          commands: ["canvas.snapshot", "system.run", "system.which"],
        },
        baseDir,
      );

      expect(commandSecond.created).toBe(false);
      expect(commandSecond.request.requestId).toBe(commandFirst.request.requestId);
      expect(commandThird.created).toBe(false);
      expect(commandThird.request.requestId).toBe(commandSecond.request.requestId);
      expect(commandThird.request.displayName).toBe("Updated Node");
      expect(commandThird.request.commands).toEqual([
        "canvas.snapshot",
        "system.run",
        "system.which",
      ]);

      await requestNodePairing(
        {
          nodeId: "node-3",
          platform: "darwin",
          commands: ["canvas.present"],
        },
        baseDir,
      );

      await expect(listNodePairing(baseDir)).resolves.toEqual({
        pending: expect.arrayContaining([
          expect.objectContaining({
            nodeId: "node-3",
            commands: ["canvas.present"],
            requiredApproveScopes: ["operator.pairing", "operator.write"],
          }),
        ]),
        paired: [],
      });
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

      expect(approved).toEqual(
        expect.objectContaining({
          node: expect.objectContaining({ nodeId: "node-array-state" }),
        }),
      );
      expect(Array.isArray(JSON.parse(await fs.readFile(paths.pendingPath, "utf8")))).toBe(false);
      expect(JSON.parse(await fs.readFile(paths.pairedPath, "utf8"))).toEqual(
        expect.objectContaining({
          "node-array-state": expect.objectContaining({ nodeId: "node-array-state" }),
        }),
      );
    });
  });

  test("generates base64url node tokens and rejects mismatches", async () => {
    await withNodePairingDir(async (baseDir) => {
      const token = await setupPairedNode(baseDir);

      expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(Buffer.from(token, "base64url")).toHaveLength(32);
      await expect(verifyNodeToken("node-1", token, baseDir)).resolves.toEqual({
        ok: true,
        node: expect.objectContaining({ nodeId: "node-1" }),
      });
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
      await expect(listNodePairing(baseDir)).resolves.toEqual({
        pending: [
          expect.objectContaining({
            requestId: pending.request.requestId,
            nodeId: "node-2",
          }),
        ],
        paired: [],
      });
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
      await expect(
        approveNodePairing(
          commandlessRequest.request.requestId,
          { callerScopes: ["operator.pairing"] },
          baseDir,
        ),
      ).resolves.toEqual({
        requestId: commandlessRequest.request.requestId,
        node: expect.objectContaining({
          nodeId: "node-2",
          commands: undefined,
        }),
      });
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

      await expect(getPairedNode("node-1", baseDir)).resolves.toEqual(
        expect.objectContaining({
          lastSeenAtMs: 1234,
          lastSeenReason: "silent_push",
        }),
      );
    });
  });
});
