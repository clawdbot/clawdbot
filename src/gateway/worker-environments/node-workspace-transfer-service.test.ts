import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import type { ResolvedGatewayAuth } from "../auth.js";
import { createGatewayHttpServer } from "../server-http.js";
import { createNodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http.js";
import { createNodeWorkspaceTransferService } from "./node-workspace-transfer-service.js";
import { serializeWorkerWorkspaceManifest } from "./workspace-manifest.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const resolvedAuth: ResolvedGatewayAuth = { mode: "none", allowTailscale: false };

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("workspace transfer test server did not bind");
  }
  return `ws://127.0.0.1:${address.port}`;
}

describe("node workspace transfer service", () => {
  it("streams a plain workspace to the node and accepts only its changed result blobs", async () => {
    const root = tempDirs.make("node-workspace-transfer-service-");
    const localPath = path.join(root, "gateway-workspace");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "input.txt"), "gateway input\n");
    await fs.mkdir(path.join(localPath, "nested"));
    await fs.writeFile(path.join(localPath, "nested", "input.txt"), "nested input\n");
    const environment = {
      ownerEpoch: 3,
      attachedSessionIds: ["session-1"],
      destroyRequestedAtMs: null,
      state: "attached",
    };
    let nowMs = Date.now();
    const credential = {
      credentialHash: "a".repeat(43),
      ownerEpoch: 3,
      expiresAtMs: nowMs + 10 * 60_000,
      sessionId: "session-1",
    };
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({ credential, environment }),
      now: () => nowMs,
      temporaryRoot: path.join(root, "gateway-transfer-tmp"),
    });
    const server = createGatewayHttpServer({
      clients: new Set(),
      controlUiEnabled: false,
      controlUiBasePath: "",
      openAiChatCompletionsEnabled: false,
      openResponsesEnabled: false,
      handleHooksRequest: async () => false,
      resolvedAuth,
      getRuntimeConfig: () => ({}),
      handleNodeWorkspaceTransferRequest: createNodeWorkspaceTransferHttpCallback(service),
    });
    const gatewayUrl = await listen(server);
    const runtime = new NodeWorkerWorkspaceRuntime({ root: path.join(root, "node-workspaces") });
    try {
      const prepared = await service.prepareSync({
        environmentId: "environment-1",
        ownerEpoch: 3,
        sessionId: "session-1",
        generation: 2,
        localPath,
        isAuthorized: () => true,
      });
      const httpOrigin = gatewayUrl.replace(/^ws/u, "http");
      const manifestPath = `/__openclaw__/worker-transfer/v1/environments/environment-1/snapshots/${prepared.snapshot.manifestRef.slice(7)}/manifest`;
      const crossEnvironment = await fetch(
        `${httpOrigin}${manifestPath.replace("environment-1", "environment-2")}`,
        { headers: { authorization: `Bearer ${prepared.token}` } },
      );
      const uploadTokenForGet = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      const wrongDirection = await fetch(`${httpOrigin}${manifestPath}`, {
        headers: { authorization: `Bearer ${uploadTokenForGet}` },
      });
      service.revoke("environment-1", uploadTokenForGet);
      nowMs += 10 * 60_000;
      const expired = await fetch(`${httpOrigin}${manifestPath}`, {
        headers: { authorization: `Bearer ${prepared.token}` },
      });
      nowMs -= 10 * 60_000;
      for (const response of [crossEnvironment, wrongDirection, expired]) {
        expect(response.status).toBe(404);
        expect(response.headers.get("cache-control")).toBe("no-store");
        await expect(response.json()).resolves.toEqual({ error: "not_found" });
      }
      const downloadInput = {
        gatewayNamespace: "gateway-test",
        environmentId: "environment-1",
        sessionId: "session-1",
        generation: 2,
        argv: ["openclaw-internal-workspace-transfer"],
        transfer: {
          direction: "download",
          token: prepared.token,
          manifestRef: prepared.snapshot.manifestRef,
        },
      } as const;
      const invoked = await invokeNodeWorkerSupervisorCommand({
        command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
        paramsJSON: JSON.stringify(downloadInput),
        workspace: runtime,
        gatewayUrl,
      });
      if (!invoked.handled || !invoked.ok || !invoked.payload) {
        throw new Error(
          `workspace transfer invoke failed: ${invoked.handled && !invoked.ok ? invoked.message : "missing result"}`,
        );
      }
      const downloaded = invoked.payload as { workspaceDir: string };
      await expect(
        fs.readFile(path.join(downloaded.workspaceDir, "input.txt"), "utf8"),
      ).resolves.toBe("gateway input\n");
      await expect(
        fs.readFile(path.join(downloaded.workspaceDir, "nested", "input.txt"), "utf8"),
      ).resolves.toBe("nested input\n");
      await fs.writeFile(path.join(downloaded.workspaceDir, "result.txt"), "node result\n");
      const uploadToken = service.prepareUpload("environment-1", prepared.snapshot.manifestRef);
      expect(() => service.prepareUpload("environment-1", prepared.snapshot.manifestRef)).toThrow(
        "already active",
      );
      await runtime.exec(
        {
          gatewayNamespace: "gateway-test",
          environmentId: "environment-1",
          sessionId: "session-1",
          generation: 2,
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "upload",
            token: uploadToken,
            baseManifestRef: prepared.snapshot.manifestRef,
          },
        },
        undefined,
        { url: gatewayUrl },
      );
      const replay = await fetch(
        `${httpOrigin}/__openclaw__/worker-transfer/v1/environments/environment-1/reconciliations/${prepared.snapshot.manifestRef.slice(7)}`,
        {
          method: "POST",
          headers: { authorization: `Bearer ${uploadToken}`, "content-length": "0" },
        },
      );
      expect(replay.status).toBe(404);
      const uploaded = service.takeUpload("environment-1", prepared.snapshot.manifestRef);
      expect(uploaded.current.entries).toContainEqual(
        expect.objectContaining({ path: "result.txt", type: "file" }),
      );
      await expect(
        fs.readFile(path.join(uploaded.stagingRoot, "result.txt"), "utf8"),
      ).resolves.toBe("node result\n");
      const acceptedToken = service.publishSnapshot("environment-1", {
        manifest: uploaded.current,
        manifestRef: uploaded.currentManifestRef,
        rawManifest: serializeWorkerWorkspaceManifest(uploaded.current),
        root: localPath,
      });
      expect(service.getSnapshot("environment-1", prepared.snapshot.manifestRef)).toBeDefined();
      service.revoke("environment-1", prepared.token);
      expect(service.getSnapshot("environment-1", prepared.snapshot.manifestRef)).toBeUndefined();
      expect(service.getSnapshot("environment-1", uploaded.currentManifestRef)).toBeDefined();
      service.revoke("environment-1", acceptedToken);
    } finally {
      await service.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("closes every admitted request when its exact transfer context retires", async () => {
    const root = tempDirs.make("node-workspace-transfer-close-");
    const localPath = path.join(root, "workspace");
    await fs.mkdir(localPath);
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: {
          ownerEpoch: 1,
          expiresAtMs: Date.now() + 60_000,
          sessionId: "session-close",
        },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session-close"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    const prepared = await service.prepareSync({
      environmentId: "environment-close",
      ownerEpoch: 1,
      sessionId: "session-close",
      generation: 7,
      localPath,
      isAuthorized: () => true,
    });
    const authorization = service.authorize({
      token: prepared.token,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: "environment-close",
        manifestRef: prepared.snapshot.manifestRef,
      },
    });
    expect(authorization).toBeDefined();
    const signal = service.authorizationSignal(authorization!);

    await service.close("environment-close");

    expect(signal.aborted).toBe(true);
    expect(service.isAuthorizationCurrent(authorization!)).toBe(false);
  });

  it("rejects a retained tunnel callback after durable transfer ownership changes", async () => {
    const root = tempDirs.make("node-workspace-transfer-owner-");
    const localPath = path.join(root, "workspace");
    await fs.mkdir(localPath);
    const environment = {
      ownerEpoch: 1,
      attachedSessionIds: ["session-owner"],
      destroyRequestedAtMs: null,
      state: "attached",
    };
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: {
          ownerEpoch: 1,
          expiresAtMs: Date.now() + 60_000,
          sessionId: "session-owner",
        },
        environment,
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    const prepared = await service.prepareSync({
      environmentId: "environment-owner",
      ownerEpoch: 1,
      sessionId: "session-owner",
      generation: 1,
      localPath,
      isAuthorized: () => true,
    });
    const authorization = service.authorize({
      token: prepared.token,
      route: {
        kind: "manifest",
        direction: "download",
        environmentId: "environment-owner",
        manifestRef: prepared.snapshot.manifestRef,
      },
    });
    expect(authorization).toBeDefined();

    environment.ownerEpoch += 1;

    expect(service.isAuthorizationCurrent(authorization!)).toBe(false);
    await service.closeAll();
  });
});
