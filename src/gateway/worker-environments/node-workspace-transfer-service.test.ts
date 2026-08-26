import fs from "node:fs/promises";
import type { IncomingMessage, Server } from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../../infra/node-commands.js";
import { invokeNodeWorkerSupervisorCommand } from "../../node-host/node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "../../node-host/node-worker-workspace.js";
import { runCommandWithTimeout } from "../../process/exec.js";
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
  it("keeps a plain workspace transferable after durable result staging initializes Git", async () => {
    const root = tempDirs.make("node-workspace-transfer-unborn-git-");
    const localPath = path.join(root, "workspace");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "input.txt"), "gateway input\n");
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: {
          ownerEpoch: 1,
          expiresAtMs: Date.now() + 60_000,
          sessionId: "session-unborn",
        },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session-unborn"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    const request = {
      environmentId: "environment-unborn",
      ownerEpoch: 1,
      sessionId: "session-unborn",
      localPath,
      isAuthorized: () => true,
    };
    const git = async (...args: string[]) => {
      const result = await runCommandWithTimeout(["git", "-C", localPath, ...args], {
        timeoutMs: 10_000,
      });
      expect(result.code).toBe(0);
      return result.stdout.trim();
    };
    try {
      const plain = await service.prepareSync({ ...request, generation: 1 });
      expect(plain.snapshot.manifest.baseCommit).toBeNull();

      await git("init", "--quiet", "--object-format=sha1");

      const staged = await service.prepareSync({ ...request, generation: 2 });
      expect(staged.snapshot.manifest.baseCommit).toBeNull();
      expect(staged.snapshot.packPath).toBeUndefined();
      expect(staged.snapshot.manifestRef).toBe(plain.snapshot.manifestRef);
      expect(staged.snapshot.manifest.entries).toContainEqual(
        expect.objectContaining({ path: "input.txt", type: "file" }),
      );

      await git("add", "input.txt");
      await git(
        "-c",
        "user.name=Worker Transfer Test",
        "-c",
        "user.email=worker-transfer@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "tracked workspace",
      );
      const committed = await service.prepareSync({ ...request, generation: 3 });
      expect(committed.snapshot.manifest.baseCommit).toBe(await git("rev-parse", "HEAD"));
      expect(committed.snapshot.packPath).toBeDefined();

      await fs.writeFile(path.join(localPath, ".git", "HEAD"), "invalid HEAD\n");
      await expect(service.prepareSync({ ...request, generation: 4 })).rejects.toThrow(
        "Worker workspace sync failed",
      );
    } finally {
      await service.closeAll();
    }
  });

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
      const reconciliationUrl = `${httpOrigin}/__openclaw__/worker-transfer/v1/environments/environment-1/reconciliations/${prepared.snapshot.manifestRef.slice(7)}`;
      const replay = await fetch(reconciliationUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${uploadToken}`, "content-length": "0" },
      });
      expect(replay.status).toBe(404);
      const uploaded = service.takeUpload("environment-1", prepared.snapshot.manifestRef);
      expect(uploaded.current.entries).toContainEqual(
        expect.objectContaining({ path: "result.txt", type: "file" }),
      );
      await expect(
        fs.readFile(path.join(uploaded.stagingRoot, "result.txt"), "utf8"),
      ).resolves.toBe("node result\n");
      const invalidUploadToken = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      const invalidUpload = await fetch(reconciliationUrl, {
        method: "POST",
        headers: { authorization: `Bearer ${invalidUploadToken}`, "content-length": "0" },
      });
      expect(invalidUpload.status).toBe(413);
      await expect(invalidUpload.json()).resolves.toEqual({
        error: "workspace_transfer_limit",
      });
      const replacementUploadToken = service.prepareUpload(
        "environment-1",
        prepared.snapshot.manifestRef,
      );
      service.revoke("environment-1", replacementUploadToken);
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

  it("clears crash scratch eagerly and removes the transfer root on shutdown", async () => {
    const root = tempDirs.make("node-workspace-transfer-lifecycle-");
    const temporaryRoot = path.join(root, "transfer-tmp");
    const staleRoot = path.join(temporaryRoot, "context-stale");
    await fs.mkdir(staleRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "base.pack"), "stale");
    const service = createNodeWorkspaceTransferService({
      getOwner: () => undefined,
      temporaryRoot,
    });

    await service.initialize();

    await expect(fs.readdir(temporaryRoot)).resolves.toEqual([]);
    await service.closeAll();
    await expect(fs.stat(temporaryRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("serializes transfer context replacement for one environment", async () => {
    const root = tempDirs.make("node-workspace-transfer-serialization-");
    const localPath = path.join(root, "workspace");
    const temporaryRoot = path.join(root, "transfer-tmp");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "input.txt"), "input\n");
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: {
          ownerEpoch: 1,
          expiresAtMs: Date.now() + 60_000,
          sessionId: "session-serialize",
        },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session-serialize"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot,
    });

    await Promise.all([
      service.prepareSync({
        environmentId: "environment-serialize",
        ownerEpoch: 1,
        sessionId: "session-serialize",
        generation: 1,
        localPath,
        isAuthorized: () => true,
      }),
      service.prepareSync({
        environmentId: "environment-serialize",
        ownerEpoch: 1,
        sessionId: "session-serialize",
        generation: 2,
        localPath,
        isAuthorized: () => true,
      }),
    ]);

    const contexts = (await fs.readdir(temporaryRoot)).filter((name) =>
      name.startsWith("context-"),
    );
    expect(contexts).toHaveLength(1);
    await service.closeAll();
  });

  it("releases an upload owner after validation fails before staging", async () => {
    const root = tempDirs.make("node-workspace-transfer-upload-release-");
    const localPath = path.join(root, "workspace");
    await fs.mkdir(localPath);
    await fs.writeFile(path.join(localPath, "input.txt"), "input\n");
    const service = createNodeWorkspaceTransferService({
      getOwner: () => ({
        credential: {
          ownerEpoch: 1,
          expiresAtMs: Date.now() + 60_000,
          sessionId: "session-upload-release",
        },
        environment: {
          ownerEpoch: 1,
          attachedSessionIds: ["session-upload-release"],
          destroyRequestedAtMs: null,
          state: "attached",
        },
      }),
      temporaryRoot: path.join(root, "transfer-tmp"),
    });
    const prepared = await service.prepareSync({
      environmentId: "environment-upload-release",
      ownerEpoch: 1,
      sessionId: "session-upload-release",
      generation: 1,
      localPath,
      isAuthorized: () => true,
    });
    const token = service.prepareUpload(
      "environment-upload-release",
      prepared.snapshot.manifestRef,
    );
    const route = {
      kind: "reconcile",
      direction: "upload",
      environmentId: "environment-upload-release",
      baseManifestRef: prepared.snapshot.manifestRef,
    } as const;
    const authorization = service.authorize({ route, token });
    if (!authorization) {
      throw new Error("upload authorization was not created");
    }
    const request = Readable.from([]) as unknown as IncomingMessage;
    request.headers = { "content-length": "0" };

    await expect(
      service.receiveUpload({
        authorization,
        request,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow("byte limit");
    expect(() =>
      service.prepareUpload("environment-upload-release", prepared.snapshot.manifestRef),
    ).not.toThrow();
    await service.closeAll();
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
