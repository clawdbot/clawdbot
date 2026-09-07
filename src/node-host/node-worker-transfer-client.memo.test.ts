import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { createNodeWorkerWorkspaceActions } from "../gateway/worker-environments/node-worker-workspace-actions.js";
import type { NodeWorkspaceTransferService } from "../gateway/worker-environments/node-workspace-transfer-service.js";
import { verifyReconciledWorkspaceFinal } from "../gateway/worker-environments/workspace-finalize.js";
import { parseRemoteWorkspaceManifestCapture } from "../gateway/worker-environments/workspace-hash-memo.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { NODE_WORKER_WORKSPACE_EXEC_COMMAND } from "../infra/node-commands.js";
import {
  parseNodeWorkerWorkspaceExecResult,
  type NodeWorkerWorkspaceExecInput,
} from "../worker/node-workspace-protocol.js";
import { invokeNodeWorkerSupervisorCommand } from "./node-worker-supervisor-commands.js";
import { NodeWorkerWorkspaceRuntime } from "./node-worker-workspace.js";

const workspaceDebug = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "node-host/worker-workspace" || subsystem === "gateway/worker-workspace"
        ? { ...logger, debug: workspaceDebug }
        : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function listen(server: HttpServer): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test transfer server did not bind");
  }
  return `ws://127.0.0.1:${address.port}`;
}

describe("node worker transfer client hash memo", () => {
  it("reuses the node generation hash memo across transfers and final reconciliation fences", async () => {
    workspaceDebug.mockClear();
    const root = tempDirs.make("node-worker-transfer-memo-");
    const identity = {
      gatewayNamespace: "gateway-memo",
      environmentId: "environment-memo",
      sessionId: "session-memo",
      generation: 1,
    };
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "state"),
      env: { ...process.env, HOME: root },
    });
    const { workspaceDir } = await runtime.exec({ ...identity, argv: ["node", "-e", ""] });
    const body = Buffer.from("memoized content\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [{ path: "artifact.txt", type: "file", mode: 0o644, size: body.byteLength, sha256 }],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const server = createHttpServer((req, res) => {
      void (async () => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200).end(rawManifest);
          return;
        }
        if (req.url?.endsWith(`/blobs/${sha256}`)) {
          res.writeHead(200).end(body);
          return;
        }
        if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
          for await (const chunk of req) {
            void chunk;
          }
          res.writeHead(200).end(JSON.stringify({ manifestRef }));
          return;
        }
        res.writeHead(404).end();
      })().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const gatewayUrl = await listen(server);
    const execute = async (
      request: Pick<
        NodeWorkerWorkspaceExecInput,
        "input" | "timeoutMs" | "transfer" | "capture"
      > & { argv: readonly string[] },
    ) => {
      const result = await invokeNodeWorkerSupervisorCommand({
        command: NODE_WORKER_WORKSPACE_EXEC_COMMAND,
        workspace: runtime,
        gatewayUrl,
        paramsJSON: JSON.stringify({
          ...identity,
          argv: request.argv,
          input: request.input,
          timeoutMs: request.timeoutMs,
          transfer: request.transfer,
          capture: request.capture,
        }),
      });
      const payload =
        result.handled && result.ok ? parseNodeWorkerWorkspaceExecResult(result.payload) : null;
      if (!payload) {
        throw new Error("Real node workspace command failed");
      }
      return payload;
    };
    try {
      expect(
        (
          await execute({
            argv: ["openclaw-internal-workspace-transfer"],
            transfer: { direction: "download", token: "download-token", manifestRef },
          })
        ).stdout.trim(),
      ).toBe(manifestRef);
      const localPath = tempDirs.make("node-reconcile-local-");
      await fsp.copyFile(
        path.join(workspaceDir, "artifact.txt"),
        path.join(localPath, "artifact.txt"),
      );
      const manifest = JSON.parse(rawManifest);
      const actions = createNodeWorkerWorkspaceActions({
        environmentId: identity.environmentId,
        ownerEpoch: identity.generation,
        sessionId: identity.sessionId,
        ownerSignal: new AbortController().signal,
        isOwnerCurrent: () => true,
        restoredWorkspace: {
          source: { kind: "local", path: localPath },
          remoteWorkspaceDir: workspaceDir,
          manifestRef,
        },
        runWorkspaceCommand: execute,
        runResumeWorkspaceCommand: execute,
        workspaceTransfer: {
          prepareUpload: () => "upload-token",
          revoke: () => {},
          takeUpload: () => ({
            base: manifest,
            baseManifestRef: manifestRef,
            baseRaw: rawManifest,
            current: manifest,
            currentManifestRef: manifestRef,
            currentRaw: rawManifest,
            stagingRoot: tempDirs.make("node-reconcile-staging-"),
          }),
        } as unknown as NodeWorkspaceTransferService,
      });
      const journal = { load: () => undefined, begin: () => {}, commit: () => {}, abort: () => {} };
      const quiescence = { assertActive: async () => {}, resume: async () => {} };
      for (let pass = 0; pass < 2; pass++) {
        const result = await actions.reconcileWorkspace({
          source: { kind: "local", path: localPath, journal },
          remoteWorkspaceDir: workspaceDir,
          baseManifestRef: manifestRef,
        });
        await verifyReconciledWorkspaceFinal(result, quiescence);
      }
      const captures = workspaceDebug.mock.calls
        .filter(([message]) => message === "node worker manifest capture completed")
        .map(([, data]) => data as { contentHashCount: number; memoHitCount: number });
      expect(captures).toHaveLength(9);
      const reconciliations = workspaceDebug.mock.calls
        .filter(([message]) => message === "worker workspace reconcile completed")
        .map(([, data]) => data);
      expect(reconciliations).toHaveLength(2);
      for (const metrics of reconciliations) {
        expect(metrics).toMatchObject({
          remoteManifestCalls: 3,
          remoteContentHashCount: 0,
          remoteMemoHitCount: 3,
        });
        expect(metrics.remoteManifestWallDurationMs).toBeGreaterThan(0);
      }
      // Download verifies fresh staging files by hashing; the unchanged upload
      // capture must reuse the memo seeded through the workspace rename.
      expect(captures[0]!.contentHashCount).toBe(1);
      for (const capture of captures.slice(1)) {
        expect(capture.contentHashCount).toBe(0);
        expect(capture.memoHitCount).toBe(1);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("keeps upload and verification candidates aligned while fencing changed and recreated ignored paths", async () => {
    const root = tempDirs.make("node-manifest-fence-");
    const runtime = new NodeWorkerWorkspaceRuntime({
      root: path.join(root, "state"),
      env: { ...process.env, HOME: root },
    });
    const identity = {
      gatewayNamespace: "gateway",
      environmentId: "environment",
      sessionId: "session",
      generation: 1,
    };
    const run = async (...argv: string[]) => {
      const result = await runtime.exec({ ...identity, argv });
      expect(result.code).toBe(0);
      return result;
    };
    const { workspaceDir } = await run("git", "init", "--quiet");
    await fsp.writeFile(path.join(workspaceDir, ".gitignore"), "");
    await fsp.writeFile(path.join(workspaceDir, "tracked.txt"), "original");
    await run("git", "add", ".");
    await run(
      "git",
      "-c",
      "user.name=Memo Test",
      "-c",
      "user.email=memo@example.test",
      "commit",
      "--quiet",
      "-m",
      "base",
    );
    await fsp.writeFile(path.join(workspaceDir, "orphan.txt"), "prior result");
    const base = await readActualWorkspaceManifest({
      root: workspaceDir,
      baseCommit: (await run("git", "rev-parse", "HEAD")).stdout.trim(),
    });
    const baseManifestRef = base.manifestRef;
    const manifests = path.join(path.dirname(workspaceDir), ".openclaw-worker", "manifests");
    await fsp.mkdir(manifests, { recursive: true });
    await fsp.writeFile(
      path.join(manifests, `${baseManifestRef.slice(7)}.json`),
      serializeWorkerWorkspaceManifest(base.manifest),
    );
    const capture = async (referenceManifestRef = baseManifestRef) => {
      const result = await runtime.exec({
        ...identity,
        argv: ["openclaw-internal-workspace-manifest"],
        capture: { baseManifestRef, referenceManifestRef },
      });
      return parseRemoteWorkspaceManifestCapture(result.stdout);
    };
    expect((await capture()).manifestRef).toBe(baseManifestRef);
    expect((await capture()).metrics.contentHashCount).toBe(0);
    const server = createHttpServer((req, res) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of req) {
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const currentOffset = 4 + body.readUInt32BE(0);
        const manifestBytes = body.subarray(
          currentOffset + 4,
          currentOffset + 4 + body.readUInt32BE(currentOffset),
        );
        const manifestRef = `sha256:${createHash("sha256").update(manifestBytes).digest("hex")}`;
        res.writeHead(200).end(JSON.stringify({ manifestRef }));
      })().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const gatewayUrl = await listen(server);
    try {
      await fsp.writeFile(path.join(workspaceDir, ".gitignore"), "orphan.txt\n");
      const uploaded = await runtime.exec(
        {
          ...identity,
          argv: ["openclaw-internal-workspace-transfer"],
          transfer: {
            direction: "upload",
            token: "upload-token",
            baseManifestRef,
            referenceManifestRef: baseManifestRef,
          },
        },
        undefined,
        { url: gatewayUrl },
      );
      const uploadedRef = uploaded.stdout.trim();
      expect((await capture(uploadedRef)).manifestRef).toBe(uploadedRef);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    const before = await fsp.stat(path.join(workspaceDir, "tracked.txt"));
    await fsp.writeFile(path.join(workspaceDir, "tracked.txt"), "modified");
    await fsp.utimes(path.join(workspaceDir, "tracked.txt"), before.atime, before.mtime);
    const modified = await capture();
    expect(modified.manifestRef).not.toBe(baseManifestRef);
    expect(modified.metrics.contentHashCount).toBe(1);
    await fsp.rm(path.join(workspaceDir, "orphan.txt"));
    await fsp.writeFile(path.join(workspaceDir, ".gitignore"), "orphan.txt\n");
    const deleted = await capture(modified.manifestRef);
    await fsp.writeFile(path.join(workspaceDir, "orphan.txt"), "late ignored writer");
    const recreated = await capture(deleted.manifestRef);
    expect(recreated.manifestRef).not.toBe(deleted.manifestRef);
    expect(recreated.metrics.contentHashCount).toBe(1);
  });
});
