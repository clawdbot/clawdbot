import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "../gateway/worker-environments/workspace-inventory-limits.js";
import { serializeWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { runNodeWorkerWorkspaceTransfer } from "./node-worker-transfer-client.js";
import { listen } from "./node-worker-transfer-client.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const rawManifest = serializeWorkerWorkspaceManifest({ version: 1, baseCommit: null, entries: [] });
const manifestRef = `sha256:${createHash("sha256").update(rawManifest).digest("hex")}`;

function oversizedGzipHeader() {
  const compressed = gzipSync(rawManifest);
  // A valid optional filename can exhaust the wire cap without expanding the body.
  compressed[3] = 8;
  return Buffer.concat([
    compressed.subarray(0, 10),
    Buffer.alloc(MAX_WORKSPACE_MANIFEST_BYTES, 65),
    Buffer.from([0]),
    compressed.subarray(10),
  ]);
}

async function transferFixture(send: (res: ServerResponse) => void, signal?: AbortSignal) {
  const root = tempDirs.make("node-worker-transfer-encoding-");
  const workspaceDir = path.join(root, "workspace");
  await fs.mkdir(workspaceDir);
  await fs.writeFile(path.join(workspaceDir, "sentinel.txt"), "existing workspace");
  let acceptEncoding: string | undefined;
  const server = createServer((req, res) => {
    acceptEncoding = req.headers["accept-encoding"];
    send(res);
  });
  const gatewayUrl = await listen(server);
  return {
    workspaceDir,
    acceptEncoding: () => acceptEncoding,
    run: () =>
      runNodeWorkerWorkspaceTransfer({
        gatewayUrl,
        environmentId: "environment",
        workspaceDir,
        manifestHome: root,
        transfer: { direction: "download", token: "test-token", manifestRef },
        signal,
      }),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

describe("workspace manifest HTTP encoding", () => {
  it.each(["gzip", "identity"])(
    "downloads %s manifests and verifies decoded content",
    async (encoding) => {
      const fixture = await transferFixture((res) => {
        res.writeHead(200, encoding === "gzip" ? { "content-encoding": "gzip" } : {});
        res.end(encoding === "gzip" ? gzipSync(rawManifest) : rawManifest);
      });
      try {
        await expect(fixture.run()).resolves.toBe(manifestRef);
        expect(fixture.acceptEncoding()).toBe("gzip");
        expect(await fs.readdir(fixture.workspaceDir)).not.toContain("sentinel.txt");
      } finally {
        await fixture.close();
      }
    },
  );

  it.each([
    {
      name: "corrupt gzip",
      encoding: "gzip",
      body: () => Buffer.from("not gzip"),
      reason: /header/,
    },
    {
      name: "truncated gzip",
      encoding: "gzip",
      body: () => gzipSync(rawManifest).subarray(0, -4),
      reason: /unexpected end/,
    },
    {
      name: "unknown encoding",
      encoding: "br",
      body: () => Buffer.from(rawManifest),
      reason: /encoding/,
    },
    {
      name: "stacked encoding",
      encoding: "gzip, gzip",
      body: () => gzipSync(rawManifest),
      reason: /encoding/,
    },
    {
      name: "decoded digest mismatch",
      encoding: "gzip",
      body: () => gzipSync(`${rawManifest} `),
      reason: /digest/,
    },
    {
      name: "decoded overflow",
      encoding: "gzip",
      body: () => gzipSync(Buffer.alloc(MAX_WORKSPACE_MANIFEST_BYTES + 1)),
      reason: /byte limit/,
    },
    {
      name: "encoded gzip overflow",
      encoding: "gzip",
      body: oversizedGzipHeader,
      reason: /byte limit/,
    },
    {
      name: "identity overflow",
      encoding: "identity",
      body: () => Buffer.alloc(MAX_WORKSPACE_MANIFEST_BYTES + 1),
      reason: /byte limit/,
    },
  ])("rejects $name before changing the workspace", async ({ encoding, body, reason }) => {
    const payload = body();
    const fixture = await transferFixture((res) =>
      res.writeHead(200, { "content-encoding": encoding }).end(payload),
    );
    try {
      await expect(fixture.run()).rejects.toMatchObject({
        cause: { message: expect.stringMatching(reason) },
      });
      expect(await fs.readFile(path.join(fixture.workspaceDir, "sentinel.txt"), "utf8")).toBe(
        "existing workspace",
      );
      expect(await fs.readdir(path.dirname(fixture.workspaceDir))).toEqual(["workspace"]);
    } finally {
      await fixture.close();
    }
  });

  it("cancels an unfinished gzip response and closes the transport without changing the workspace", async () => {
    const controller = new AbortController();
    const sent = createDeferred();
    const closed = createDeferred();
    const fixture = await transferFixture((res) => {
      res.on("close", () => closed.resolve());
      res.writeHead(200, { "content-encoding": "gzip" });
      res.write(gzipSync(rawManifest).subarray(0, 12), () => sent.resolve());
    }, controller.signal);
    try {
      const result = expect(fixture.run()).rejects.toMatchObject({ cause: { name: "AbortError" } });
      await sent.promise;
      controller.abort();
      await result;
      await closed.promise;
      expect(await fs.readFile(path.join(fixture.workspaceDir, "sentinel.txt"), "utf8")).toBe(
        "existing workspace",
      );
    } finally {
      controller.abort();
      await fixture.close();
    }
  });
});
