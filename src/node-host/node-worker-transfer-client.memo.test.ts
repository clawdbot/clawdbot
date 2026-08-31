import { createHash } from "node:crypto";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const workspaceDebug = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "node-host/worker-workspace"
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
  it("reuses the placement hash memo across download and upload captures", async () => {
    workspaceDebug.mockClear();
    const root = tempDirs.make("node-worker-transfer-memo-");
    const workspaceDir = path.join(root, "workspace");
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
    const hashMemo = new Map<string, string>();
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-memo",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "download-token", manifestRef },
          hashMemo,
        }),
      ).resolves.toBe(manifestRef);
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-memo",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "upload", token: "upload-token", baseManifestRef: manifestRef },
          hashMemo,
        }),
      ).resolves.toBe(manifestRef);
      const captures = workspaceDebug.mock.calls
        .filter(([message]) => message === "node worker manifest capture completed")
        .map(([, data]) => data as { contentHashCount: number; memoHitCount: number });
      expect(captures).toHaveLength(2);
      // Download verifies fresh staging files by hashing; the unchanged upload
      // capture must reuse the memo seeded through the workspace rename.
      expect(captures[0]!.contentHashCount).toBe(1);
      expect(captures[1]!.contentHashCount).toBe(0);
      expect(captures[1]!.memoHitCount).toBe(1);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
