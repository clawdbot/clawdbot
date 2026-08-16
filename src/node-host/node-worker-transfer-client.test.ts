import { createHash, X509Certificate } from "node:crypto";
import type { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, {
  createServer as createHttpServer,
  type RequestOptions,
  type Server as HttpServer,
} from "node:http";
import https, { createServer as createHttpsServer, type Server as HttpsServer } from "node:https";
import { connect as connectNet, type Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { installGlobalProxy } from "@openclaw/proxyline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { runCommandBuffered, runExec } from "../process/exec.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";

const transferDebug = vi.hoisted(() => vi.fn());
vi.mock("../logging/subsystem.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../logging/subsystem.js")>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => {
      const logger = actual.createSubsystemLogger(subsystem);
      return subsystem === "node-host/worker-workspace"
        ? { ...logger, debug: transferDebug }
        : logger;
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type DrainProbe = {
  emitter: EventEmitter;
  drains: number;
  maxErrorListeners: number;
};

function observeDrainListeners(emitter: EventEmitter): DrainProbe {
  const probe = { emitter, drains: 0, maxErrorListeners: 0 };
  emitter.on("newListener", (event) => {
    if (event === "error") {
      probe.maxErrorListeners = Math.max(
        probe.maxErrorListeners,
        emitter.listenerCount("error") + 1,
      );
    }
  });
  emitter.on("drain", () => {
    probe.drains += 1;
  });
  return probe;
}

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

  it("reuses the validated TLS pin for a pooled socket", async () => {
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
    const gatewayPort = Number(new URL(gatewayUrl).port);
    let hidPeerCertificate = false;
    const pinnedAgent = https.globalAgent;
    const hidePeerCertificate = (socket: Socket) => {
      if (socket.remotePort !== gatewayPort || hidPeerCertificate) {
        return;
      }
      hidPeerCertificate = true;
      (socket as TLSSocket).getPeerCertificate = (() => ({})) as TLSSocket["getPeerCertificate"];
    };
    pinnedAgent.on("free", hidePeerCertificate);
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
      expect(hidPeerCertificate).toBe(true);

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
    } finally {
      pinnedAgent.off("free", hidePeerCertificate);
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("performs a full pinned handshake on a replacement socket", async () => {
    const root = tempDirs.make("node-worker-transfer-tls-resumed-");
    const workspaceDir = path.join(root, "workspace");
    const body = Buffer.from("resumed pinned transfer\n");
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
    const sessionReuse: boolean[] = [];
    const server = createHttpsServer(
      {
        cert: TEST_TLS_CERT_PEM,
        key: TEST_TLS_KEY_PEM,
        maxVersion: "TLSv1.2",
      },
      (req, res) => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, {
            connection: "close",
            "content-length": String(Buffer.byteLength(rawManifest)),
          });
          res.end(rawManifest);
          return;
        }
        if (req.url?.endsWith(`/blobs/${sha256}`)) {
          res.writeHead(200, {
            connection: "close",
            "content-length": String(body.byteLength),
          });
          res.end(body);
          return;
        }
        res.writeHead(404, { connection: "close" }).end();
      },
    );
    server.on("secureConnection", (socket) => {
      sessionReuse.push(socket.isSessionReused());
    });
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: fingerprint,
          environmentId: "environment-tls-resumed",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "test-token", manifestRef },
        }),
      ).resolves.toBe(manifestRef);
      expect(sessionReuse).toEqual([false, false]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("preserves managed proxy routing for pinned transfers", async () => {
    const root = tempDirs.make("node-worker-transfer-tls-proxy-");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    const target = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (_req, res) => {
        res.writeHead(200, { "content-length": String(Buffer.byteLength(rawManifest)) });
        res.end(rawManifest);
      },
    );
    const gatewayUrl = (await listen(target)).replace(/^ws/u, "wss");
    const proxySockets = new Set<Duplex>();
    let connectCount = 0;
    const proxy = createHttpServer();
    proxy.on("connect", (req, clientSocket, head) => {
      connectCount += 1;
      const destination = new URL(`http://${req.url}`);
      const upstream = connectNet(Number(destination.port), destination.hostname, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.byteLength > 0) {
          upstream.write(head);
        }
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      proxySockets.add(clientSocket);
      proxySockets.add(upstream);
      clientSocket.once("close", () => proxySockets.delete(clientSocket));
      upstream.once("close", () => proxySockets.delete(upstream));
    });
    const proxyUrl = (await listen(proxy)).replace(/^ws/u, "http");
    const proxyHandle = installGlobalProxy({ mode: "managed", proxyUrl });
    const fingerprint = new X509Certificate(TEST_TLS_CERT_PEM).fingerprint256;
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: fingerprint,
          environmentId: "environment-tls-proxy",
          workspaceDir: path.join(root, "workspace"),
          manifestHome: root,
          transfer: { direction: "download", token: "proxy-token", manifestRef },
        }),
      ).resolves.toBe(manifestRef);
      expect(connectCount).toBe(1);
    } finally {
      proxyHandle.stop();
      for (const socket of proxySockets) {
        socket.destroy();
      }
      proxy.closeAllConnections();
      target.closeAllConnections();
      await Promise.all([
        new Promise<void>((resolve) => {
          proxy.close(() => resolve());
        }),
        new Promise<void>((resolve) => {
          target.close(() => resolve());
        }),
      ]);
    }
  });

  it("rejects a wrong TLS pin on a new socket", async () => {
    const root = tempDirs.make("node-worker-transfer-wrong-pin-");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    let requestCount = 0;
    const server = createHttpsServer(
      { cert: TEST_TLS_CERT_PEM, key: TEST_TLS_KEY_PEM },
      (_req, res) => {
        requestCount += 1;
        res.writeHead(200).end(rawManifest);
      },
    );
    const gatewayUrl = (await listen(server)).replace(/^ws/u, "wss");
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          gatewayTlsFingerprint: "00".repeat(32),
          environmentId: "environment-wrong-pin",
          workspaceDir: path.join(root, "workspace"),
          manifestHome: root,
          transfer: { direction: "download", token: "wrong-pin-token", manifestRef },
        }),
      ).rejects.toThrow("gateway TLS fingerprint mismatch");
      expect(requestCount).toBe(0);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("cleans up error listeners across repeated download and upload backpressure", async () => {
    const root = tempDirs.make("node-worker-transfer-backpressure-");
    const workspaceDir = path.join(root, "workspace");
    const body = Buffer.alloc(2 * 1024 * 1024, "a");
    const sha256 = createHash("sha256").update(body).digest("hex");
    const rawManifest = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "large.bin",
          type: "file",
          mode: 0o644,
          size: body.byteLength,
          sha256,
        },
      ],
    });
    const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
    let uploadManifestRef: string | undefined;
    const server = createHttpServer((req, res) => {
      void (async () => {
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
          await new Promise<void>((resolve) => {
            setTimeout(resolve, 50);
          });
          for await (const chunk of req) {
            void chunk;
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
    });
    const outputProbes: DrainProbe[] = [];
    const requestProbes: DrainProbe[] = [];
    const createWriteStream = fsSync.createWriteStream.bind(fsSync);
    const writeStreamSpy = vi.spyOn(fsSync, "createWriteStream").mockImplementation((...args) => {
      const stream = createWriteStream(...args);
      outputProbes.push(observeDrainListeners(stream));
      return stream;
    });
    const request = http.request.bind(http);
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: URL,
      options: RequestOptions,
    ) => {
      const clientRequest = request(url, options);
      requestProbes.push(observeDrainListeners(clientRequest));
      return clientRequest;
    }) as typeof http.request);
    const gatewayUrl = await listen(server);
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-backpressure",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "download-token", manifestRef },
        }),
      ).resolves.toBe(manifestRef);

      await fs.writeFile(path.join(workspaceDir, "large.bin"), Buffer.alloc(body.byteLength, "b"));
      uploadManifestRef = (
        await readActualWorkspaceManifest({ root: workspaceDir, baseCommit: null })
      ).manifestRef;
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-backpressure",
          workspaceDir,
          manifestHome: root,
          transfer: {
            direction: "upload",
            token: "upload-token",
            baseManifestRef: manifestRef,
          },
        }),
      ).resolves.toBe(uploadManifestRef);

      const outputProbe = outputProbes.find((probe) => probe.drains > 10);
      const requestProbe = requestProbes.find((probe) => probe.drains > 10);
      expect(outputProbe?.drains).toBeGreaterThan(10);
      expect(outputProbe?.maxErrorListeners).toBeLessThanOrEqual(1);
      expect(outputProbe?.emitter.listenerCount("error")).toBe(0);
      expect(requestProbe?.drains).toBeGreaterThan(10);
      expect(requestProbe?.maxErrorListeners).toBeLessThanOrEqual(2);
      expect(requestProbe?.emitter.listenerCount("error")).toBe(0);
    } finally {
      writeStreamSpy.mockRestore();
      requestSpy.mockRestore();
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it("materializes a Git workspace with argv-only commands", async () => {
    transferDebug.mockClear();
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
      expect(transferDebug).toHaveBeenCalledWith(
        "node worker workspace transfer completed",
        expect.objectContaining({
          environmentId: "environment-git",
          direction: "download",
          outcome: "succeeded",
          durationMs: expect.any(Number),
          packDownloadMs: expect.any(Number),
          blobApplyMs: expect.any(Number),
        }),
      );
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });
});
