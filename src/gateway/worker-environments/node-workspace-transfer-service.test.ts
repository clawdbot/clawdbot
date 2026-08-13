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
import {
  createNodeWorkspaceTransferHttpCallback,
  createNodeWorkspaceTransferService,
} from "./node-workspace-transfer-service.js";

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
      getCredential: () => credential,
      getEnvironment: () => environment,
      now: () => nowMs,
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
      nowMs += 5 * 60_000;
      const expired = await fetch(`${httpOrigin}${manifestPath}`, {
        headers: { authorization: `Bearer ${prepared.token}` },
      });
      nowMs -= 5 * 60_000;
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
      const uploaded = service.takeUpload("environment-1", prepared.snapshot.manifestRef);
      expect(uploaded.current.entries).toContainEqual(
        expect.objectContaining({ path: "result.txt", type: "file" }),
      );
      await expect(
        fs.readFile(path.join(uploaded.stagingRoot, "result.txt"), "utf8"),
      ).resolves.toBe("node result\n");
    } finally {
      await service.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
