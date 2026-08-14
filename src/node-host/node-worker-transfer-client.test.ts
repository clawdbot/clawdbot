import { createHash, X509Certificate } from "node:crypto";
import fs from "node:fs/promises";
import { createServer as createHttpServer, type Server as HttpServer } from "node:http";
import { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { runCommandBuffered, runExec } from "../process/exec.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function listen(server: HttpServer | HttpsServer): Promise<string> {
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

async function git(root: string, args: string[]): Promise<string> {
  const result = await runExec("git", ["-C", root, ...args], {
    baseEnv: {
      ...process.env,
      GIT_AUTHOR_NAME: "OpenClaw Test",
      GIT_AUTHOR_EMAIL: "test@openclaw.invalid",
      GIT_COMMITTER_NAME: "OpenClaw Test",
      GIT_COMMITTER_EMAIL: "test@openclaw.invalid",
    },
    logOutput: false,
  });
  return result.stdout.trim();
}

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
    const server = createHttpServer((req, res) => {
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
        (await fs.readdir(root)).filter((entry) =>
          entry.startsWith(".workspace.workspace-transfer-"),
        ),
      ).toEqual([]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("restores one interrupted workspace backup before the next transfer", async () => {
    const root = tempDirs.make("node-worker-transfer-recover-");
    const workspaceDir = path.join(root, "workspace");
    const backup = `${workspaceDir}.previous-crash`;
    const staleStaging = path.join(root, ".workspace.workspace-transfer-crash");
    await fs.mkdir(backup);
    await fs.writeFile(path.join(backup, "sentinel.txt"), "restored\n");
    await fs.mkdir(staleStaging);
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: "a".repeat(40),
      entries: [],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const server = createHttpServer((req, res) => {
      if (req.url?.endsWith("/manifest")) {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
        res.end(rawManifest);
        return;
      }
      res.writeHead(500).end();
    });
    const gatewayUrl = await listen(server);
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-recover",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "test-token", manifestRef },
        }),
      ).rejects.toThrow("workspace-transfer-failed");
      await expect(fs.readFile(path.join(workspaceDir, "sentinel.txt"), "utf8")).resolves.toBe(
        "restored\n",
      );
      await expect(fs.access(staleStaging)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("revalidates the TLS pin on pooled manifest and blob requests", async () => {
    const root = tempDirs.make("node-worker-transfer-tls-");
    const workspaceDir = path.join(root, "workspace");
    const body = Buffer.from("pinned transfer\n");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "result.txt",
          type: "file",
          mode: 0o644,
          size: body.byteLength,
          sha256,
        },
      ],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    let requestCount = 0;
    let connectionCount = 0;
    let uploadManifestRef: string | undefined;
    const server = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (req, res) => {
        void (async () => {
          requestCount += 1;
          if (req.url?.endsWith("/manifest")) {
            res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
            res.end(rawManifest);
            return;
          }
          if (req.url?.endsWith(`/blobs/${sha256}`)) {
            res.writeHead(200, { "content-length": String(body.byteLength) });
            res.end(body);
            return;
          }
          if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
            for await (const chunk of req) {
              void chunk; // Consume the complete upload before acknowledging it.
            }
            const response = Buffer.from(JSON.stringify({ manifestRef: uploadManifestRef }));
            res.writeHead(200, {
              "content-type": "application/json",
              "content-length": String(response.byteLength),
            });
            res.end(response);
            return;
          }
          res.writeHead(404).end();
        })().catch((error: unknown) => {
          res.destroy(error instanceof Error ? error : new Error(String(error)));
        });
      },
    );
    server.on("secureConnection", () => {
      connectionCount += 1;
    });
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: fingerprint,
          environmentId: "environment-tls",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "test-token", manifestRef },
        }),
      ).resolves.toBe(manifestRef);
      expect(requestCount).toBe(2);
      expect(connectionCount).toBe(1);

      await fs.writeFile(path.join(workspaceDir, "changed.txt"), "changed on node\n");
      uploadManifestRef = (
        await readActualWorkspaceManifest({ root: workspaceDir, baseCommit: null })
      ).manifestRef;
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: fingerprint,
          environmentId: "environment-tls",
          workspaceDir,
          manifestHome: root,
          transfer: {
            direction: "upload",
            token: "upload-token",
            baseManifestRef: manifestRef,
          },
        }),
      ).resolves.toBe(uploadManifestRef);
      expect(requestCount).toBe(3);
      expect(connectionCount).toBe(1);

      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: "00".repeat(32),
          environmentId: "environment-wrong-pin",
          workspaceDir: path.join(root, "wrong-pin-workspace"),
          manifestHome: root,
          transfer: { direction: "download", token: "wrong-pin-token", manifestRef },
        }),
      ).rejects.toThrow("workspace-transfer-failed");
      expect(requestCount).toBe(3);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("materializes a Git workspace with argv-only commands", async () => {
    const root = tempDirs.make("node-worker-transfer-git-");
    const source = path.join(root, "source");
    const workspaceDir = path.join(root, "workspace");
    await fs.mkdir(source);
    await git(source, ["init", "--quiet", "--object-format=sha1"]);
    await fs.writeFile(path.join(source, "tracked.txt"), "tracked from gateway\n");
    await git(source, ["add", "tracked.txt"]);
    await git(source, ["commit", "--quiet", "-m", "base"]);
    const commit = await git(source, ["rev-parse", "HEAD"]);
    const snapshot = await readActualWorkspaceManifest({ root: source, baseCommit: commit });
    const rawManifest = serializeWorkerWorkspaceManifest(snapshot.manifest);
    const packed = await runCommandBuffered(
      ["git", "-C", source, "pack-objects", "--stdout", "--revs"],
      { input: `${commit}\n`, maxOutputBytes: 4 * 1024 * 1024 },
    );
    expect(packed.termination, packed.stderr.toString("utf8")).toBe("exit");
    expect(packed.code).toBe(0);
    const filesByHash = new Map(
      snapshot.manifest.entries.flatMap((entry) =>
        entry.type === "file" ? [[entry.sha256, path.join(source, entry.path)] as const] : [],
      ),
    );
    const server = createHttpServer((req, res) => {
      void (async () => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
          res.end(rawManifest);
          return;
        }
        if (req.url?.endsWith("/pack")) {
          res.writeHead(200, { "content-length": String(packed.stdout.byteLength) });
          res.end(packed.stdout);
          return;
        }
        const sha256 = req.url?.match(/\/blobs\/([a-f0-9]{64})$/u)?.[1];
        const file = sha256 ? filesByHash.get(sha256) : undefined;
        if (file) {
          const body = await fs.readFile(file);
          res.writeHead(200, { "content-length": String(body.byteLength) });
          res.end(body);
          return;
        }
        res.writeHead(404).end();
      })().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const gatewayUrl = await listen(server);
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-git",
          workspaceDir,
          manifestHome: root,
          transfer: {
            direction: "download",
            token: "test-token",
            manifestRef: snapshot.manifestRef,
          },
        }),
      ).resolves.toBe(snapshot.manifestRef);
      await expect(fs.readFile(path.join(workspaceDir, "tracked.txt"), "utf8")).resolves.toBe(
        "tracked from gateway\n",
      );
      await expect(git(workspaceDir, ["rev-parse", "HEAD"])).resolves.toBe(commit);
      await expect(git(workspaceDir, ["status", "--porcelain=v1"])).resolves.toBe("");
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
