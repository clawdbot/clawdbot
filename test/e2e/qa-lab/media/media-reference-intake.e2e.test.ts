import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { saveMediaBuffer } from "../../../../src/media/store.js";
import { loadWebMediaRaw } from "../../../../src/media/web-media.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { createSolidPngBuffer } from "../../../helpers/image-fixtures.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

async function listenOnLoopback(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("media fixture server did not expose a TCP port");
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
  server.closeAllConnections();
  await closed;
}

describe("media reference intake product proof", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      await closeServer(server);
      server = undefined;
    }
  });

  it("loads every supported reference and trusts PNG bytes over text hints", async () => {
    const root = tempDirs.make("openclaw-media-reference-intake-");
    const png = createSolidPngBuffer(2, 2, { r: 32, g: 96, b: 224 });
    const localPath = path.join(root, "misleading.txt");
    await fs.writeFile(localPath, png);

    const requestedPaths: string[] = [];
    server = createServer((request, response) => {
      requestedPaths.push(request.url ?? "");
      response.writeHead(200, {
        "content-disposition": 'attachment; filename="remote.txt"',
        "content-length": String(png.byteLength),
        "content-type": "text/plain",
      });
      response.end(png);
    });
    const port = await listenOnLoopback(server);
    const remoteUrl = `http://127.0.0.1:${port}/misleading.txt`;

    await withEnvAsync({ OPENCLAW_STATE_DIR: path.join(root, "state") }, async () => {
      const stored = await saveMediaBuffer(png, "text/plain", "inbound", 1024 * 1024, "stored.txt");
      expect(stored.contentType).toBe("image/png");
      expect(stored.id).toMatch(/\.txt$/);

      const plainPath = await loadWebMediaRaw(localPath, {
        localRoots: [root],
        maxBytes: 1024 * 1024,
      });
      const fileUrl = await loadWebMediaRaw(pathToFileURL(localPath).toString(), {
        localRoots: [root],
        maxBytes: 1024 * 1024,
      });
      const remote = await loadWebMediaRaw(remoteUrl, {
        maxBytes: 1024 * 1024,
        ssrfPolicy: { allowedHostnames: ["127.0.0.1"] },
      });
      const mediaStore = await loadWebMediaRaw(`media://inbound/${stored.id}`, {
        maxBytes: 1024 * 1024,
      });

      for (const result of [plainPath, fileUrl, remote, mediaStore]) {
        expect(result.buffer).toEqual(png);
        expect(result.contentType).toBe("image/png");
        expect(result.kind).toBe("image");
      }

      expect(plainPath.fileName).toBe("misleading.txt");
      expect(fileUrl.fileName).toBe("misleading.txt");
      expect(remote.fileName).toBe("remote.txt");
      expect(requestedPaths).toEqual(["/misleading.txt"]);
    });
  });
});
