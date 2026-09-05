import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MediaFetchError, saveRemoteMedia } from "../../../../src/media/fetch.js";
import { withEnvAsync } from "../../../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";

type SeenRequest = {
  headers: IncomingMessage["headers"];
  url: string;
};

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const sourceRequests: SeenRequest[] = [];
const targetRequests: SeenRequest[] = [];

let sourceServer: Server;
let sourceOrigin: string;
let targetServer: Server;
let targetOrigin: string;

async function listenOnLoopback(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", onError);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("loopback media server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

async function closeLoopbackServer(server: Server): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  server.closeAllConnections();
  await closed;
}

function recordRequest(request: IncomingMessage, requests: SeenRequest[]): void {
  requests.push({
    headers: request.headers,
    url: request.url ?? "/",
  });
}

function handleSourceRequest(request: IncomingMessage, response: ServerResponse): void {
  recordRequest(request, sourceRequests);
  switch (request.url) {
    case "/private":
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("private media");
      return;
    case "/redirect":
      response.writeHead(302, { location: `${targetOrigin}/payload` });
      response.end();
      return;
    case "/oversized-file":
      response.writeHead(200, {
        "content-length": "128",
        "content-type": "application/octet-stream",
      });
      response.end("declared oversized file");
      return;
    case "/oversized-stream":
      response.writeHead(200, { "content-type": "application/octet-stream" });
      response.write(Buffer.alloc(12, 0x61));
      response.end(Buffer.alloc(12, 0x62));
      return;
    default:
      response.writeHead(404);
      response.end();
  }
}

function handleTargetRequest(request: IncomingMessage, response: ServerResponse): void {
  recordRequest(request, targetRequests);
  if (request.url !== "/payload") {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("redirected media");
}

async function expectNoPublishedMediaFiles(stateDir: string): Promise<void> {
  const mediaDir = path.join(stateDir, "media");
  const files: string[] = [];

  const visit = async (directory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    });
    for (const entry of entries) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(entryPath);
      } else {
        files.push(path.relative(mediaDir, entryPath));
      }
    }
  };

  await visit(mediaDir);
  expect(files.toSorted()).toStrictEqual([]);
}

describe("media guarded fetch product boundaries", () => {
  beforeAll(async () => {
    targetServer = createServer(handleTargetRequest);
    targetOrigin = await listenOnLoopback(targetServer);
    sourceServer = createServer(handleSourceRequest);
    sourceOrigin = await listenOnLoopback(sourceServer);
  });

  beforeEach(() => {
    sourceRequests.length = 0;
    targetRequests.length = 0;
  });

  afterAll(async () => {
    await Promise.all([closeLoopbackServer(sourceServer), closeLoopbackServer(targetServer)]);
  });

  it("rejects private targets before the network or media store is reached", async () => {
    const stateDir = tempDirs.make("openclaw-media-private-fetch-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const error = await saveRemoteMedia({
        url: `${sourceOrigin}/private`,
        maxBytes: 64,
        subdir: "private-target",
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(MediaFetchError);
      expect(error).toMatchObject({
        code: "fetch_failed",
        cause: { name: "SsrFBlockedError" },
      });
      expect(sourceRequests).toHaveLength(0);
      await expectNoPublishedMediaFiles(stateDir);
    });
  });

  it("revalidates redirect targets and strips sensitive cross-origin headers", async () => {
    const stateDir = tempDirs.make("openclaw-media-safe-redirect-");

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      const blocked = await saveRemoteMedia({
        url: `${sourceOrigin}/redirect`,
        requestInit: {
          headers: {
            Accept: "text/plain",
            Authorization: "Bearer private-token",
            Cookie: "session=private",
            "X-Api-Key": "private-key",
          },
        },
        maxBytes: 64,
        subdir: "blocked-redirect",
        ssrfPolicy: { allowedOrigins: [sourceOrigin] },
      }).catch((caught: unknown) => caught);

      expect(blocked).toBeInstanceOf(MediaFetchError);
      expect(blocked).toMatchObject({
        code: "fetch_failed",
        cause: { name: "SsrFBlockedError" },
      });
      expect(sourceRequests).toHaveLength(1);
      expect(targetRequests).toHaveLength(0);
      await expectNoPublishedMediaFiles(stateDir);

      sourceRequests.length = 0;
      const saved = await saveRemoteMedia({
        url: `${sourceOrigin}/redirect`,
        requestInit: {
          headers: {
            Accept: "text/plain",
            Authorization: "Bearer private-token",
            Cookie: "session=private",
            "X-Api-Key": "private-key",
          },
        },
        maxBytes: 64,
        subdir: "safe-redirect",
        ssrfPolicy: { allowedOrigins: [sourceOrigin, targetOrigin] },
      });

      expect(sourceRequests[0]?.headers.authorization).toBe("Bearer private-token");
      expect(targetRequests).toHaveLength(1);
      expect(targetRequests[0]?.headers.accept).toBe("text/plain");
      expect(targetRequests[0]?.headers.authorization).toBeUndefined();
      expect(targetRequests[0]?.headers.cookie).toBeUndefined();
      expect(targetRequests[0]?.headers["x-api-key"]).toBeUndefined();
      await expect(fs.readFile(saved.path, "utf8")).resolves.toBe("redirected media");
    });
  });

  it("rejects declared and streamed overflows without publishing store artifacts", async () => {
    const stateDir = tempDirs.make("openclaw-media-bounded-fetch-");
    const allowedOrigins = [sourceOrigin];

    await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir }, async () => {
      await expect(
        saveRemoteMedia({
          url: `${sourceOrigin}/oversized-file`,
          maxBytes: 16,
          subdir: "oversized-file",
          ssrfPolicy: { allowedOrigins },
        }),
      ).rejects.toMatchObject({
        name: "MediaFetchError",
        code: "max_bytes",
      });
      await expectNoPublishedMediaFiles(stateDir);

      await expect(
        saveRemoteMedia({
          url: `${sourceOrigin}/oversized-stream`,
          maxBytes: 16,
          subdir: "oversized-stream",
          ssrfPolicy: { allowedOrigins },
        }),
      ).rejects.toMatchObject({
        name: "MediaFetchError",
        code: "max_bytes",
      });
      await expectNoPublishedMediaFiles(stateDir);
    });
  });
});
