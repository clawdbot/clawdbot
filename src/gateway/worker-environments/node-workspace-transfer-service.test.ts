import fs from "node:fs/promises";
import type { Server } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

afterEach(() => {
  vi.restoreAllMocks();
});

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

function injectUploadWriteFaults() {
  const originalOpen = fs.open.bind(fs);
  let beforeRetry: (() => Promise<void>) | undefined;
  let nextWriteError: Error | undefined;
  let stagingRoot: string | undefined;
  let observedShortWrite = false;
  vi.spyOn(fs, "open").mockImplementation(async (...args) => {
    const handle = await originalOpen(...args);
    if (
      typeof args[0] !== "string" ||
      !args[0].includes(`${path.sep}upload-`) ||
      path.basename(args[0]) !== "result.txt" ||
      args[1] !== "wx"
    ) {
      return handle;
    }

    stagingRoot = path.dirname(args[0]);
    let injectShortWrite = true;
    const injectedHandle = Object.create(handle) as typeof handle;
    injectedHandle.close = handle.close.bind(handle);
    injectedHandle.write = (async (
      buffer: Buffer,
      offset = 0,
      length = buffer.byteLength - offset,
      position?: number | null,
    ) => {
      if (nextWriteError) {
        const error = nextWriteError;
        nextWriteError = undefined;
        throw error;
      }
      if (injectShortWrite) {
        injectShortWrite = false;
        const writeLength = Math.max(1, Math.floor(length / 2));
        observedShortWrite ||= writeLength < length;
        return await handle.write(buffer, offset, writeLength, position);
      }
      const retryHook = beforeRetry;
      beforeRetry = undefined;
      await retryHook?.();
      return await handle.write(buffer, offset, length, position);
    }) as typeof handle.write;
    return injectedHandle;
  });

  return {
    blockNextRetry() {
      let markStarted!: () => void;
      let release!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      beforeRetry = async () => {
        markStarted();
        await released;
      };
      return { started, release };
    },
    failNextWrite(error: Error) {
      nextWriteError = error;
    },
    lastStagingRoot: () => stagingRoot,
    shortWriteObserved: () => observedShortWrite,
  };
}

function retryOrUploadStatus(retryStarted: Promise<void>, upload: Promise<unknown>) {
  return Promise.race([
    retryStarted.then(() => "retrying" as const),
    upload.then(
      () => "completed" as const,
      () => "failed" as const,
    ),
  ]);
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
      const writeFaults = injectUploadWriteFaults();
      const persistenceRetry = writeFaults.blockNextRetry();
      const uploadResult = (token: string) =>
        runtime.exec(
          {
            gatewayNamespace: "gateway-test",
            environmentId: "environment-1",
            sessionId: "session-1",
            generation: 2,
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: {
              direction: "upload",
              token,
              baseManifestRef: prepared.snapshot.manifestRef,
            },
          },
          undefined,
          { url: gatewayUrl },
        );
      const uploadToken = service.prepareUpload("environment-1", prepared.snapshot.manifestRef);
      expect(() => service.prepareUpload("environment-1", prepared.snapshot.manifestRef)).toThrow(
        "already active",
      );
      const upload = uploadResult(uploadToken);
      try {
        await expect(retryOrUploadStatus(persistenceRetry.started, upload)).resolves.toBe(
          "retrying",
        );
        expect(writeFaults.shortWriteObserved()).toBe(true);
        expect(() => service.takeUpload("environment-1", prepared.snapshot.manifestRef)).toThrow(
          "did not complete",
        );
      } finally {
        persistenceRetry.release();
      }
      await upload;
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
      writeFaults.failNextWrite(new Error("injected terminal upload write failure"));
      const failedUploadToken = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      await expect(uploadResult(failedUploadToken)).rejects.toThrow("workspace-transfer-failed");
      expect(writeFaults.lastStagingRoot()).toBeDefined();
      await expect(fs.stat(writeFaults.lastStagingRoot()!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      const resetUploadToken = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      service.revoke("environment-1", resetUploadToken);
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

      const authorityRetry = writeFaults.blockNextRetry();
      const retiredUploadToken = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      const retiredUpload = uploadResult(retiredUploadToken);
      try {
        await expect(retryOrUploadStatus(authorityRetry.started, retiredUpload)).resolves.toBe(
          "retrying",
        );
        environment.ownerEpoch += 1;
      } finally {
        authorityRetry.release();
      }
      await expect(retiredUpload).rejects.toThrow("workspace-transfer-failed");
      expect(writeFaults.lastStagingRoot()).toBeDefined();
      await expect(fs.stat(writeFaults.lastStagingRoot()!)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(() => service.takeUpload("environment-1", prepared.snapshot.manifestRef)).toThrow(
        "did not complete",
      );
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
