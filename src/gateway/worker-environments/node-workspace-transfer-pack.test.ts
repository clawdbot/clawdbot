import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireGit } from "../../agents/worktrees/git.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";
import { readActualWorkspaceManifest } from "./workspace-reconcile.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

async function createGitTransfer() {
  const root = await fs.realpath(tempDirs.make("node-workspace-lazy-pack-"));
  const localPath = path.join(root, "workspace");
  const temporaryRoot = path.join(root, "transfers");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "input.txt"), "captured base\n");
  await requireGit(localPath, ["init", "--quiet"]);
  await requireGit(localPath, ["config", "user.name", "Workspace Test"]);
  await requireGit(localPath, ["config", "user.email", "workspace@example.invalid"]);
  await requireGit(localPath, ["add", "."]);
  await requireGit(localPath, ["commit", "--quiet", "-m", "captured base"]);
  const service = createNodeWorkspaceTransferService({
    temporaryRoot,
    getOwner: () => ({
      credential: { ownerEpoch: 1, sessionId: "session" },
      environment: {
        ownerEpoch: 1,
        attachedSessionIds: ["session"],
        destroyRequestedAtMs: null,
        state: "attached",
      },
    }),
  });
  const prepared = await service.prepareSync({
    environmentId: "environment",
    ownerEpoch: 1,
    sessionId: "session",
    generation: 1,
    localPath,
    isAuthorized: () => true,
  });
  const server = await startNodeWorkspaceTransferTestServer(service);
  const fetchPack = (token = prepared.token, manifestRef = prepared.snapshot.manifestRef) =>
    fetch(
      `${server.gatewayUrl.replace(/^ws/u, "http")}/__openclaw__/worker-transfer/v1/environments/environment/snapshots/${manifestRef.slice(7)}/pack`,
      { headers: { authorization: `Bearer ${token}` } },
    );
  return {
    root,
    localPath,
    temporaryRoot,
    service,
    prepared,
    fetchPack,
    packs: async () =>
      (await fs.readdir(temporaryRoot, { recursive: true })).filter((name) =>
        name.endsWith(".pack"),
      ),
    close: async () => {
      await service.closeAll();
      await server.close();
    },
  };
}

describe("node workspace Git pack downloads", () => {
  it("defers packing until authorized download and shares the captured base across manifests", async () => {
    const fixture = await createGitTransfer();
    const { localPath, prepared, service } = fixture;
    try {
      // Origin/seed sync consumes this prepared manifest without downloading a pack.
      expect(await fixture.packs()).toEqual([]);
      const unauthorized = await fixture.fetchPack("invalid");
      expect(unauthorized.status).toBe(404);
      await unauthorized.arrayBuffer();
      expect(await fixture.packs()).toEqual([]);

      await requireGit(localPath, ["commit", "--quiet", "--allow-empty", "-m", "new HEAD"]);
      const nextCommit = await requireGit(localPath, ["rev-parse", "HEAD"]);
      const responses = await Promise.all([fixture.fetchPack(), fixture.fetchPack()]);
      expect(responses.map((response) => response.status)).toEqual([200, 200]);
      const packs = await Promise.all(
        responses.map(async (response) => Buffer.from(await response.arrayBuffer())),
      );
      expect(packs[0]).toEqual(packs[1]);
      expect(await fixture.packs()).toHaveLength(1);

      const unpacked = path.join(fixture.root, "unpacked");
      await fs.mkdir(unpacked);
      await requireGit(unpacked, ["init", "--quiet"]);
      const indexed = await runCommandWithTimeout(
        ["git", "-C", unpacked, "index-pack", "--stdin"],
        {
          input: packs[0],
          timeoutMs: 10_000,
        },
      );
      expect(indexed.code).toBe(0);
      expect(
        await requireGit(unpacked, ["cat-file", "-t", prepared.snapshot.manifest.baseCommit!]),
      ).toBe("commit");
      const newer = await runCommandWithTimeout(
        ["git", "-C", unpacked, "cat-file", "-t", nextCommit],
        { timeoutMs: 10_000 },
      );
      expect(newer.code).not.toBe(0);

      await fs.writeFile(path.join(localPath, "result.txt"), "accepted result\n");
      const accepted = await readActualWorkspaceManifest({
        root: localPath,
        baseCommit: prepared.snapshot.manifest.baseCommit,
      });
      const token = service.publishSnapshot("environment", {
        ...accepted,
        root: localPath,
        rawManifest: serializeWorkerWorkspaceManifest(accepted.manifest),
      });
      const response = await fixture.fetchPack(token, accepted.manifestRef);
      expect(response.status).toBe(200);
      expect(Buffer.from(await response.arrayBuffer())).toEqual(packs[0]);
      expect(await fixture.packs()).toHaveLength(1);

      const changedBase = await readActualWorkspaceManifest({
        root: localPath,
        baseCommit: nextCommit,
      });
      const changedBaseToken = service.publishSnapshot("environment", {
        ...changedBase,
        root: localPath,
        rawManifest: serializeWorkerWorkspaceManifest(changedBase.manifest),
      });
      const mismatched = await fixture.fetchPack(changedBaseToken, changedBase.manifestRef);
      expect(mismatched.status).toBe(404);
      await mismatched.arrayBuffer();
      expect(await fixture.packs()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it("retries an authorized download after discarding a failed pack's scratch files", async () => {
    const fixture = await createGitTransfer();
    const originalAppend = fs.appendFile.bind(fs);
    let failOnce = true;
    vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
      if (failOnce && typeof args[0] === "string" && args[0].endsWith(".objects")) {
        failOnce = false;
        expect((await fs.stat(args[0])).size).toBeGreaterThan(0);
        throw new Error("injected Git pack failure after object enumeration");
      }
      return await originalAppend(...args);
    });
    try {
      const failed = await fixture.fetchPack();
      expect(failed.status).toBe(500);
      await failed.arrayBuffer();
      expect(failOnce).toBe(false);
      expect(await fixture.packs()).toEqual([]);

      const retried = await fixture.fetchPack();
      expect(retried.status).toBe(200);
      expect(
        Buffer.from(await retried.arrayBuffer())
          .subarray(0, 4)
          .toString(),
      ).toBe("PACK");
      expect(await fixture.packs()).toHaveLength(1);
    } finally {
      await fixture.close();
    }
  });

  it.each(["revoke", "close"] as const)(
    "fences an in-flight pack after transfer %s",
    async (retirement) => {
      const fixture = await createGitTransfer();
      const started = createDeferred();
      const release = createDeferred();
      const originalAppend = fs.appendFile.bind(fs);
      vi.spyOn(fs, "appendFile").mockImplementation(async (...args) => {
        if (typeof args[0] === "string" && args[0].endsWith(".objects")) {
          started.resolve();
          await release.promise;
        }
        return await originalAppend(...args);
      });
      const response = fixture.fetchPack().then(
        async (result) => ({
          status: result.status,
          bytes: Buffer.from(await result.arrayBuffer()),
        }),
        () => undefined,
      );
      try {
        await Promise.race([started.promise, response]);
        expect(await fixture.packs()).toEqual([]);
        let closed = false;
        const closing =
          retirement === "close"
            ? fixture.service.close("environment").then(() => {
                closed = true;
              })
            : Promise.resolve(fixture.service.revoke("environment", fixture.prepared.token));
        await Promise.resolve();
        expect(closed).toBe(false);
        release.resolve();
        const result = await response;
        expect(result?.status).not.toBe(200);
        if (retirement === "revoke") {
          expect(result?.status).toBe(404);
        }
        await closing;
        if (retirement === "close") {
          expect(await fs.readdir(fixture.temporaryRoot)).toEqual([]);
        }
      } finally {
        release.resolve();
        await response;
        await fixture.close();
      }
    },
  );
});
