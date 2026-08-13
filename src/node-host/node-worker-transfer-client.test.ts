import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("node worker transfer client", () => {
  it("keeps the prior workspace intact when a pack transfer is cut short", async () => {
    const root = tempDirs.make("node-worker-transfer-cut-");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(workspaceDir);
    await fs.writeFile(path.join(workspaceDir, "sentinel.txt"), "keep me\n");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: "a".repeat(40),
      entries: [],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const server = createServer((req, res) => {
      if (req.url?.endsWith("/manifest")) {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
        res.end(rawManifest);
        return;
      }
      if (req.url?.endsWith("/pack")) {
        res.writeHead(200, { "content-length": "1024" });
        res.write("truncated");
        res.destroy();
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test transfer server did not bind");
    }
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl: `ws://127.0.0.1:${address.port}`,
          environmentId: "environment-cut",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "test-token", manifestRef },
        }),
      ).rejects.toThrow("workspace-transfer-failed");
      await expect(fs.readFile(path.join(workspaceDir, "sentinel.txt"), "utf8")).resolves.toBe(
        "keep me\n",
      );
      expect(
        (await fs.readdir(root)).filter((entry) => entry.startsWith(".workspace-transfer-")),
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
