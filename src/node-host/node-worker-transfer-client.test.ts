import { createHash, X509Certificate } from "node:crypto";
import type { EventEmitter } from "node:events";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import http, { createServer as createHttpServer, type RequestOptions } from "node:http";
import https, { createServer as createHttpsServer } from "node:https";
import { connect as connectNet, type Socket } from "node:net";
import path from "node:path";
import type { Duplex } from "node:stream";
import type { TLSSocket } from "node:tls";
import { installGlobalProxy } from "@openclaw/proxyline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { TEST_TLS_CERT_PEM, TEST_TLS_KEY_PEM } from "../../test/helpers/tls-fixture.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
} from "../gateway/worker-environments/workspace-manifest.js";
import { readActualWorkspaceManifest } from "../gateway/worker-environments/workspace-reconcile.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

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

describe("node worker transfer client", () => {
  it.runIf(process.platform === "win32")(
    "preserves foreign executable modes through Windows workspace downloads and uploads",
    async () => {
      const root = tempDirs.make("node-worker-transfer-windows-executable-");
      const workspaceDir = path.join(root, "workspace");
      const original = Buffer.from("#!/bin/sh\necho before\n");
      const sha256 = createHash("sha256").update(original).digest("hex");
      const rawManifest = serializeWorkerWorkspaceManifest({
        version: 1,
        baseCommit: null,
        entries: [
          { path: "script.sh", type: "file", mode: 0o755, size: original.byteLength, sha256 },
        ],
      });
      const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;
      let uploadedRaw: string | undefined;
      const server = createHttpServer((req, res) => {
        void (async () => {
          if (req.url?.endsWith("/manifest")) {
            res.writeHead(200).end(rawManifest);
            return;
          }
          if (req.url?.endsWith(`/blobs/${sha256}`)) {
            res.writeHead(200).end(original);
            return;
          }
          if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
            const chunks: Buffer[] = [];
            for await (const chunk of req) {
              chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
            }
            const body = Buffer.concat(chunks);
            const baseBytes = body.readUInt32BE(0);
            const currentOffset = 4 + baseBytes;
            const currentBytes = body.readUInt32BE(currentOffset);
            uploadedRaw = body
              .subarray(currentOffset + 4, currentOffset + 4 + currentBytes)
              .toString("utf8");
            const currentRef = `sha256:${createHash("sha256").update(uploadedRaw).digest("hex")}`;
            res.writeHead(200).end(JSON.stringify({ manifestRef: currentRef }));
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
            environmentId: "environment-windows-executable",
            workspaceDir,
            manifestHome: root,
            transfer: { direction: "download", token: "download-token", manifestRef },
          }),
        ).resolves.toBe(manifestRef);
        await expect(
          fs.readFile(
            path.join(
              root,
              ".openclaw-worker",
              "manifests",
              `${manifestRef.slice("sha256:".length)}.json`,
            ),
            "utf8",
          ),
        ).resolves.toBe(rawManifest);

        await fs.writeFile(path.join(workspaceDir, "script.sh"), "#!/bin/sh\necho changed\n");
        await fs.writeFile(path.join(workspaceDir, "new.txt"), "new\n");
        const currentRef = await runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-windows-executable",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "upload", token: "upload-token", baseManifestRef: manifestRef },
        });
        expect(currentRef).toMatch(/^sha256:[a-f0-9]{64}$/u);
        expect(JSON.parse(uploadedRaw!)).toMatchObject({
          entries: [
            expect.objectContaining({ path: "new.txt", mode: 0o644 }),
            expect.objectContaining({ path: "script.sh", mode: 0o755 }),
          ],
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

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
      directories: ["nested"],
      entries: [
        {
          path: "nested/result.txt",
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
      await expect(
        fs.readFile(path.join(workspaceDir, "nested", "result.txt"), "utf8"),
      ).resolves.toBe("pinned transfer\n");
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
    const proxyTunnels = new Set<{ client: Duplex; upstream: Duplex }>();
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
      const tunnel = { client: clientSocket, upstream };
      proxyTunnels.add(tunnel);
      // A CONNECT tunnel owns both socket halves. Once either half closes or
      // errors, retire the pair so teardown cannot reset an unowned peer.
      const closeTunnel = () => {
        proxyTunnels.delete(tunnel);
        clientSocket.destroy();
        upstream.destroy();
      };
      clientSocket.once("close", closeTunnel);
      clientSocket.once("error", closeTunnel);
      upstream.once("close", closeTunnel);
      upstream.once("error", closeTunnel);
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
      const tunnelClosures = [...proxyTunnels].flatMap((tunnel) =>
        [tunnel.client, tunnel.upstream].map(
          (socket) =>
            new Promise<void>((resolve) => {
              if (socket.destroyed) {
                resolve();
                return;
              }
              socket.once("close", resolve);
            }),
        ),
      );
      proxyHandle.stop();
      for (const tunnel of proxyTunnels) {
        tunnel.client.destroy();
        tunnel.upstream.destroy();
      }
      await Promise.all(tunnelClosures);
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

  it.each([
    {
      reason: "file_digest",
      expected:
        /^workspace-transfer-invalid: gateway rejected workspace transfer payload \(file_digest\)$/u,
    },
    {
      reason: "private gateway detail",
      expected: /^workspace-transfer-failed: gateway returned 400$/u,
    },
  ])(
    "preserves only safe gateway upload rejection reasons ($reason)",
    async ({ reason, expected }) => {
      const root = tempDirs.make("node-worker-transfer-reason-");
      const manifestRef = `sha256:${"a".repeat(64)}`;
      const server = createHttpServer((_req, res) => {
        const body = Buffer.from(JSON.stringify({ error: "workspace_transfer_invalid", reason }));
        res.writeHead(400, {
          "content-type": "application/json",
          "content-length": String(body.byteLength),
        });
        res.end(body);
      });
      const gatewayUrl = await listen(server);
      try {
        await expect(
          runNodeWorkerWorkspaceTransfer({
            gatewayUrl,
            environmentId: "environment-reason",
            workspaceDir: path.join(root, "workspace"),
            manifestHome: root,
            transfer: { direction: "download", token: "download-token", manifestRef },
          }),
        ).rejects.toThrow(expected);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => {
          server.close(() => resolve());
        });
      }
    },
  );

  it("uploads the captured snapshot when the live workspace changes before transmission", async () => {
    const root = tempDirs.make("node-worker-transfer-snapshot-");
    const workspaceDir = path.join(root, "workspace");
    const workspaceFile = path.join(workspaceDir, "result.txt");
    const baseBody = Buffer.from("base\n");
    const baseSha256 = createHash("sha256").update(baseBody).digest("hex");
    const baseRaw = serializeWorkerWorkspaceManifest({
      version: 1,
      baseCommit: null,
      entries: [
        {
          path: "result.txt",
          type: "file",
          mode: 0o644,
          size: baseBody.byteLength,
          sha256: baseSha256,
        },
      ],
    });
    const baseRef = `sha256:${createHash("sha256").update(baseRaw).digest("hex")}`;
    const server = createHttpServer((req, res) => {
      void (async () => {
        if (req.url?.endsWith("/manifest")) {
          res.writeHead(200, { "content-length": String(Buffer.byteLength(baseRaw)) });
          res.end(baseRaw);
          return;
        }
        if (req.url?.endsWith(`/blobs/${baseSha256}`)) {
          res.writeHead(200, { "content-length": String(baseBody.byteLength) });
          res.end(baseBody);
          return;
        }
        if (req.method === "POST" && req.url?.includes("/reconciliations/")) {
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const body = Buffer.concat(chunks);
          const baseBytes = body.readUInt32BE(0);
          const currentHeader = 4 + baseBytes;
          const currentBytes = body.readUInt32BE(currentHeader);
          const currentRaw = body
            .subarray(currentHeader + 4, currentHeader + 4 + currentBytes)
            .toString("utf8");
          const currentRef = `sha256:${createHash("sha256").update(currentRaw).digest("hex")}`;
          const current = parseWorkerWorkspaceManifest(currentRaw, currentRef);
          const entry = current.entries.find(
            (candidate) => candidate.path === "result.txt" && candidate.type === "file",
          );
          const fileHeader = currentHeader + 4 + currentBytes;
          const declaredSize = body.readBigUInt64BE(fileHeader);
          const uploaded = body.subarray(fileHeader + 8);
          const valid =
            entry?.type === "file" &&
            declaredSize === BigInt(entry.size) &&
            uploaded.byteLength === entry.size &&
            createHash("sha256").update(uploaded).digest("hex") === entry.sha256;
          if (!valid) {
            res.writeHead(400, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "workspace_transfer_invalid", reason: "file_digest" }));
            return;
          }
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ manifestRef: currentRef }));
          return;
        }
        res.writeHead(404).end();
      })().catch((error: unknown) => {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    const gatewayUrl = await listen(server);
    const request = http.request.bind(http);
    let mutated = false;
    const requestSpy = vi.spyOn(http, "request").mockImplementation(((
      url: string | URL,
      options: RequestOptions,
    ) => {
      if (options.method === "POST") {
        fsSync.writeFileSync(workspaceFile, "mutated!\n");
        mutated = true;
      }
      return request(url, options);
    }) as typeof http.request);
    try {
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-snapshot",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "download", token: "download-token", manifestRef: baseRef },
        }),
      ).resolves.toBe(baseRef);
      await fs.writeFile(workspaceFile, "captured\n");
      const currentRef = (
        await readActualWorkspaceManifest({ root: workspaceDir, baseCommit: null })
      ).manifestRef;
      await expect(
        runNodeWorkerWorkspaceTransfer({
          gatewayUrl,
          environmentId: "environment-snapshot",
          workspaceDir,
          manifestHome: root,
          transfer: { direction: "upload", token: "upload-token", baseManifestRef: baseRef },
        }),
      ).resolves.toBe(currentRef);
      expect(mutated).toBe(true);
      await expect(fs.readFile(workspaceFile, "utf8")).resolves.toBe("mutated!\n");
    } finally {
      requestSpy.mockRestore();
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
});
