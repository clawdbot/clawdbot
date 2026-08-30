import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAuthRateLimiter, type AuthRateLimiter } from "../auth-rate-limit.js";
import type { TransferArtifact } from "./artifact-transfer-service.js";
import {
  createWorkerBootstrapArtifactTransferHttpCallback,
  handleWorkerBootstrapArtifactTransferHttpRequest,
} from "./worker-bootstrap-artifact-transfer-http.js";
import { createWorkerBootstrapArtifactTransferService } from "./worker-bootstrap-artifact-transfer-service.js";

describe("worker bootstrap artifact transfer", () => {
  let root: string;
  let origin: string;
  let server: http.Server;
  let authorized: boolean;
  let now: number;
  let service: ReturnType<typeof createWorkerBootstrapArtifactTransferService>;
  let rateLimiter: AuthRateLimiter | undefined;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), "openclaw-bootstrap-wire-"));
    authorized = true;
    now = 1_000;
    service = createWorkerBootstrapArtifactTransferService({ now: () => now });
    const callback = createWorkerBootstrapArtifactTransferHttpCallback(service);
    server = http.createServer((req, res) => {
      void handleWorkerBootstrapArtifactTransferHttpRequest({
        req,
        res,
        clientIp: "127.0.0.1",
        callback,
        rateLimiter,
      })
        .then((handled) => {
          if (!handled) {
            res.writeHead(418).end();
          }
        })
        .catch((error: unknown) => res.destroy(error as Error));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("test server did not bind a TCP port");
    }
    origin = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    service.closeAll();
    server.closeAllConnections();
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rateLimiter?.dispose();
    rateLimiter = undefined;
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function prepare(contents: string | Buffer = "source-runtime", signal?: AbortSignal) {
    const artifact: TransferArtifact = {
      tarballPath: path.join(root, "runtime.tgz"),
      tarballSha256: createHash("sha256").update(contents).digest("hex"),
      tarballBytes: Buffer.byteLength(contents),
    };
    await fs.writeFile(artifact.tarballPath, contents);
    const receipt = service.prepare({ artifact, signal, isAuthorized: () => authorized });
    return {
      artifact,
      receipt,
      url: `${origin}/__openclaw__/worker-bootstrap/artifacts/${artifact.tarballSha256}`,
      headers: { authorization: `Bearer ${receipt.token}` },
    };
  }

  it("delivers exactly one artifact, only on its digest route with a header bearer", async () => {
    const { artifact, url, headers } = await prepare();
    for (const rejectedUrl of [
      url.replace(artifact.tarballSha256, "a".repeat(64)),
      `${url}?token=not-a-header`,
      `${origin}/__openclaw__/worker-bootstrap/other`,
    ]) {
      const response = await fetch(rejectedUrl, { headers });
      expect(response.status).toBe(404);
      expect(response.headers.get("cache-control")).toBe("no-store");
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    }
    expect((await fetch(url)).status).toBe(404);
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    expect(response.headers.get("x-openclaw-content-sha256")).toBe(artifact.tarballSha256);
    expect(response.headers.get("content-length")).toBe(String(artifact.tarballBytes));
    await expect(response.text()).resolves.toBe("source-runtime");
    expect((await fetch(url, { headers })).status).toBe(404);
    expect((await fetch(`${origin}/__openclaw__/worker-bootstrap-other`)).status).toBe(418);
  });

  it.each(["owner", "expiry", "signal", "shutdown"] as const)(
    "rejects retained bearers after %s closure",
    async (closure) => {
      const owner = new AbortController();
      const { url, headers, receipt } = await prepare("source-runtime", owner.signal);
      if (closure === "owner") {
        authorized = false;
      }
      if (closure === "expiry") {
        now = receipt.expiresAtMs;
      }
      if (closure === "signal") {
        owner.abort();
      }
      if (closure === "shutdown") {
        service.closeAll();
      }
      const response = await fetch(url, { headers });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
      authorized = true;
      now = 1_000;
      expect((await fetch(url, { headers })).status).toBe(404);
    },
  );

  it("rechecks the owner after opening the descriptor, before emitting bytes", async () => {
    const { url, headers } = await prepare();
    const open = fs.open;
    vi.spyOn(fs, "open").mockImplementationOnce(async (...args) => {
      const handle = await open(...args);
      authorized = false;
      return handle;
    });
    const response = await fetch(url, { headers });
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "not_found" });
  });

  it("streams the verified descriptor even when the archive path is replaced", async () => {
    const { artifact, url, headers } = await prepare();
    const open = service.openFile.bind(service);
    vi.spyOn(service, "openFile").mockImplementationOnce(async (...args) => {
      const file = await open(...args);
      await fs.rename(artifact.tarballPath, path.join(root, "original.tgz"));
      await fs.writeFile(artifact.tarballPath, "different-data");
      return file;
    });
    const response = await fetch(url, { headers });
    expect(response.status).toBe(200);
    await expect(response.text()).resolves.toBe("source-runtime");
  });

  it.each(["missing", "symlink", "size"] as const)(
    "returns an opaque failure for a %s archive",
    async (change) => {
      const { artifact, url, headers } = await prepare();
      if (change === "size") {
        await fs.writeFile(artifact.tarballPath, "changed");
      } else {
        await fs.rename(artifact.tarballPath, path.join(root, "original.tgz"));
        if (change === "symlink") {
          await fs.symlink(path.join(root, "original.tgz"), artifact.tarballPath);
        }
      }
      const response = await fetch(url, { headers });
      expect(response.status).toBe(404);
      await expect(response.json()).resolves.toEqual({ error: "not_found" });
    },
  );

  it.each(["owner", "expiry", "signal", "revoke", "shutdown"] as const)(
    "terminates an active stream on %s and disallows a concurrent download",
    async (closure) => {
      const owner = new AbortController();
      const { receipt, url, headers } = await prepare(Buffer.alloc(8 * 1024 * 1024), owner.signal);
      const response = await fetch(url, { headers });
      expect(response.status).toBe(200);
      expect((await fetch(url, { headers })).status).toBe(404);
      if (closure === "owner") {
        authorized = false;
      }
      if (closure === "expiry") {
        now = receipt.expiresAtMs;
      }
      if (closure === "signal") {
        owner.abort();
      }
      if (closure === "revoke") {
        service.revoke(receipt.token);
      }
      if (closure === "shutdown") {
        service.closeAll();
      }
      await expect(response.arrayBuffer()).rejects.toThrow();
    },
  );

  it("shares the transfer authentication rate limit without exposing artifact presence", async () => {
    const { url } = await prepare();
    rateLimiter = createAuthRateLimiter({ maxAttempts: 1, exemptLoopback: false });
    expect((await fetch(url)).status).toBe(404);
    const limited = await fetch(url);
    expect(limited.status).toBe(429);
    expect(limited.headers.get("cache-control")).toBe("no-store");
    expect(limited.headers.get("retry-after")).toBeTruthy();
    await expect(limited.json()).resolves.toEqual({ error: "rate_limited" });
  });
});
