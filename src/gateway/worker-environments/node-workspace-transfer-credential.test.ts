import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../test/helpers/promise.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { startNodeWorkspaceTransferTestServer } from "./node-workspace-transfer.test-support.js";
import * as support from "./service.test-support.js";

describe("node workspace credential revocation", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it.each([false, true])(
    "fences the real credential deletion before tunnel stop (upload pending: %s)",
    async (pendingUpload) => {
      const ready = support.seedReadyNodeDesktop("transfer-owner");
      const record = support.testState.store.transition({
        environmentId: ready.environmentId,
        from: ready.state,
        to: "attached",
        patch: support.attachedPatch(ready.environmentId, "session-transfer"),
      });
      const localPath = path.join(support.testState.root, "workspace");
      await fs.mkdir(localPath);
      await fs.writeFile(path.join(localPath, "input.txt"), "gateway input");
      const ownerSignal = new AbortController();
      const service = createNodeWorkspaceTransferService({
        getOwner: (environmentId) => support.testState.store.getTransferOwner(environmentId),
        now: () => support.testState.nowMs,
        temporaryRoot: path.join(support.testState.root, "transfer-tmp"),
      });
      const server = await startNodeWorkspaceTransferTestServer(service);
      const release = createDeferred();
      let uploadFailure: Promise<void> | undefined;
      let restoreOpen: (() => void) | undefined;
      try {
        const prepared = await service.prepareSync({
          environmentId: record.environmentId,
          ownerEpoch: record.ownerEpoch,
          sessionId: "session-transfer",
          generation: 1,
          localPath,
          isAuthorized: () => true,
          signal: ownerSignal.signal,
        });
        const route = {
          kind: "manifest",
          direction: "download",
          environmentId: record.environmentId,
          manifestRef: prepared.snapshot.manifestRef,
        } as const;
        const authorization = service.authorize({ route, token: prepared.token });
        if (!authorization) {
          throw new Error("expected admitted download");
        }
        let stagingRoot: string | undefined;
        if (pendingUpload) {
          const runtime = new NodeWorkerWorkspaceRuntime({
            root: path.join(support.testState.root, "node-workspaces"),
          });
          const input = {
            gatewayNamespace: "gateway-test",
            environmentId: record.environmentId,
            sessionId: "session-transfer",
            generation: 1,
            argv: ["openclaw-internal-workspace-transfer"],
          };
          const downloaded = await runtime.exec(
            {
              ...input,
              transfer: {
                direction: "download",
                token: prepared.token,
                manifestRef: prepared.snapshot.manifestRef,
              },
            },
            undefined,
            { url: server.gatewayUrl },
          );
          await fs.writeFile(path.join(downloaded.workspaceDir, "result.txt"), "node result");
          const opened = createDeferred();
          const originalOpen = fs.open.bind(fs);
          const open = vi.spyOn(fs, "open").mockImplementation(async (...args) => {
            const handle = await originalOpen(...args);
            if (
              typeof args[0] === "string" &&
              args[0].includes(`${path.sep}upload-`) &&
              path.basename(args[0]) === "result.txt" &&
              args[1] === "wx"
            ) {
              stagingRoot = path.dirname(args[0]);
              opened.resolve();
              await release.promise;
            }
            return handle;
          });
          restoreOpen = () => open.mockRestore();
          const token = service.prepareUpload(record.environmentId, prepared.snapshot.manifestRef);
          uploadFailure = expect(
            runtime.exec(
              {
                ...input,
                transfer: {
                  direction: "upload",
                  token,
                  baseManifestRef: prepared.snapshot.manifestRef,
                },
              },
              undefined,
              { url: server.gatewayUrl },
            ),
          ).rejects.toThrow("workspace-transfer-failed");
          await opened.promise;
        }

        // Teardown deletes this row before awaiting physical tunnel stop. Keep every
        // other owner fact live so the test isolates that immediate revocation fence.
        support.testState.store.revokeEnvironmentCredential(record.environmentId);
        expect(support.testState.store.get(record.environmentId)).toMatchObject({
          state: "attached",
          ownerEpoch: record.ownerEpoch,
          attachedSessionIds: ["session-transfer"],
          destroyRequestedAtMs: null,
        });
        expect(ownerSignal.signal.aborted).toBe(false);
        expect(service.isAuthorizationCurrent(authorization)).toBe(false);
        expect(service.snapshot(authorization)).toBeUndefined();
        const response = await fetch(
          `${server.gatewayUrl.replace(/^ws/u, "http")}/__openclaw__/worker-transfer/v1/environments/${record.environmentId}/snapshots/${prepared.snapshot.manifestRef.slice(7)}/manifest`,
          {
            headers: { authorization: `Bearer ${prepared.token}` },
          },
        );
        expect(response.status).toBe(404);
        await expect(response.json()).resolves.toEqual({ error: "not_found" });
        expect(() =>
          service.prepareUpload(record.environmentId, prepared.snapshot.manifestRef),
        ).toThrow("context is unavailable");
        expect(() => service.publishSnapshot(record.environmentId, prepared.snapshot)).toThrow(
          "context is unavailable",
        );
        await expect(
          service.prepareAttachments({
            environmentId: record.environmentId,
            localPath,
            isAuthorized: () => true,
            signal: ownerSignal.signal,
          }),
        ).rejects.toThrow("authority closed");
        release.resolve();
        if (uploadFailure) {
          await uploadFailure;
          expect(stagingRoot).toBeDefined();
          await expect(fs.stat(stagingRoot!)).rejects.toMatchObject({ code: "ENOENT" });
          expect(() =>
            service.takeUpload(record.environmentId, prepared.snapshot.manifestRef),
          ).toThrow("did not complete");
        }
      } finally {
        release.resolve();
        try {
          await uploadFailure;
        } finally {
          restoreOpen?.();
          await service.closeAll();
          await server.close();
        }
      }
    },
  );
});
