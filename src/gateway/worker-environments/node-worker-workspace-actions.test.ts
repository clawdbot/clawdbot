import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { environment } from "./node-worker-tunnel.test-support.js";
import { createNodeWorkerWorkspaceActions } from "./node-worker-workspace-actions.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function workspaceFixture(beforeDownload?: () => Promise<void>) {
  const root = tempDirs.make("node-workspace-authority-");
  const localPath = path.join(root, "workspace");
  await fs.mkdir(localPath);
  await fs.writeFile(path.join(localPath, "input.txt"), "workspace input\n");
  const record = environment();
  const transfer = createNodeWorkspaceTransferService({
    getOwner: () => ({
      environment: record,
      credential: { ownerEpoch: record.ownerEpoch, sessionId: "session-1" },
    }),
    temporaryRoot: path.join(root, "transfer"),
  });
  const owner = new AbortController();
  const actions = createNodeWorkerWorkspaceActions({
    environmentId: record.environmentId,
    ownerEpoch: record.ownerEpoch,
    sessionId: "session-1",
    ownerSignal: owner.signal,
    isOwnerCurrent: () => !owner.signal.aborted,
    workspaceTransfer: transfer,
    runWorkspaceCommand: async (command) => {
      command.assertCurrent?.();
      if (!command.transfer || command.transfer.direction !== "download") {
        throw new Error("Expected a workspace download");
      }
      await beforeDownload?.();
      const authorization = transfer.authorize({
        token: command.transfer.token,
        route: {
          kind: "manifest",
          direction: "download",
          environmentId: record.environmentId,
          manifestRef: command.transfer.manifestRef,
        },
      });
      if (!authorization || !transfer.snapshot(authorization)) {
        throw new Error("Workspace download authority closed");
      }
      return {
        workspaceDir: "/node/workspace",
        stdout: command.transfer.manifestRef,
        stderr: "",
        code: 0,
        signal: null,
        killed: false,
        termination: "exit",
      };
    },
  });
  return {
    actions,
    transfer,
    request: {
      localPath,
      sessionId: "session-1",
      generation: 1,
      projectKey: "a".repeat(64),
    },
    close: async () => {
      owner.abort();
      await transfer.closeAll();
    },
  };
}

describe("node workspace operation authority", () => {
  it.each(["turn", "owner", "signal"] as const)(
    "rejects a queued sync with closed %s authority without replacing its predecessor",
    async (boundary) => {
      const fixture = await workspaceFixture();
      const preparing = createDeferred();
      const releasePreparation = createDeferred();
      const originalRealpath = fs.realpath.bind(fs);
      let blocked = false;
      const realpath = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
        if (!blocked && args[0] === fixture.request.localPath) {
          blocked = true;
          preparing.resolve();
          await releasePreparation.promise;
        }
        return await originalRealpath(...args);
      });
      let authorized = true;
      const signal = new AbortController();
      const request = {
        ...fixture.request,
        environmentId: "environment-1",
        ownerEpoch: 2,
        isAuthorized: () => true,
      };
      try {
        const first = fixture.transfer.prepareSync(request);
        await preparing.promise;
        const second = fixture.transfer.prepareSync({
          ...request,
          signal: signal.signal,
          isAuthorized: () => boundary !== "owner" || authorized,
          authorize: () => {
            if (boundary === "turn" && !authorized) {
              throw new Error("Initiating dispatch turn closed");
            }
          },
        });
        const rejected = expect(second).rejects.toThrow();
        authorized = false;
        if (boundary === "signal") {
          signal.abort();
        }
        releasePreparation.resolve();
        const prepared = await first;
        await rejected;
        expect(
          fixture.transfer.authorize({
            token: prepared.token,
            route: {
              kind: "manifest",
              direction: "download",
              environmentId: "environment-1",
              manifestRef: prepared.snapshot.manifestRef,
            },
          }),
        ).toBeDefined();
      } finally {
        releasePreparation.resolve();
        realpath.mockRestore();
        await fixture.close();
      }
    },
  );

  it.each(["reconciliation", "attachments"] as const)(
    "preserves independent %s after the initiating dispatch turn closes",
    async (operation) => {
      const fixture = await workspaceFixture();
      let authorized = true;
      try {
        const synced = await fixture.actions.syncWorkspace({
          ...fixture.request,
          authorize: () => {
            if (!authorized) {
              throw new Error("Initiating dispatch turn closed");
            }
          },
        });
        authorized = false;
        if (operation === "reconciliation") {
          const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
          expect(token).toBeTruthy();
          fixture.transfer.revoke("environment-1", token);
        } else {
          assert.isDefined(fixture.actions.stageAttachments);
          await expect(
            fixture.actions.stageAttachments({
              localPath: fixture.request.localPath,
              isAuthorized: () => true,
              signal: new AbortController().signal,
            }),
          ).resolves.toBeUndefined();
        }
      } finally {
        await fixture.close();
      }
    },
  );

  it("rejects a download after its initiating turn closes but permits a fresh sync", async () => {
    const downloading = createDeferred();
    const releaseDownload = createDeferred();
    const fixture = await workspaceFixture(async () => {
      downloading.resolve();
      await releaseDownload.promise;
    });
    let authorized = true;
    try {
      const syncing = fixture.actions.syncWorkspace({
        ...fixture.request,
        authorize: () => {
          if (!authorized) {
            throw new Error("Initiating dispatch turn closed");
          }
        },
      });
      const rejected = expect(syncing).rejects.toThrow(/authority closed|dispatch turn closed/u);
      await downloading.promise;
      authorized = false;
      releaseDownload.resolve();
      await rejected;

      const synced = await fixture.actions.syncWorkspace({
        ...fixture.request,
        authorize: () => {},
      });
      const token = fixture.transfer.prepareUpload("environment-1", synced.manifestRef);
      expect(token).toBeTruthy();
      fixture.transfer.revoke("environment-1", token);
    } finally {
      releaseDownload.resolve();
      await fixture.close();
    }
  });
});
