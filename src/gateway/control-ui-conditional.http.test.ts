import fs from "node:fs/promises";
import { createServer, request, type IncomingMessage, type Server } from "node:http";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTempDirTracker } from "../../test/helpers/temp-dir.js";
import { handleControlUiHttpRequest } from "./control-ui.js";

const assetBody = Buffer.from('console.log("conditional fixture");\n');
const modifiedAt = new Date("2024-01-01T00:00:00.000Z");
const lastModified = modifiedAt.toUTCString();
const laterModifiedSince = new Date("2024-01-02T00:00:00.000Z").toUTCString();
const earlierModifiedSince = new Date("2023-12-31T00:00:00.000Z").toUTCString();
const conditionalCases: {
  name: string;
  headers: Record<string, string>;
  status: 200 | 304;
}[] = [
  { name: "unconditional request", headers: {}, status: 200 },
  {
    name: "equal If-Modified-Since",
    headers: { "If-Modified-Since": lastModified },
    status: 304,
  },
  {
    name: "later If-Modified-Since",
    headers: { "If-Modified-Since": laterModifiedSince },
    status: 304,
  },
  {
    name: "older If-Modified-Since",
    headers: { "If-Modified-Since": earlierModifiedSince },
    status: 200,
  },
  { name: "stale If-None-Match alone", headers: { "If-None-Match": '"stale"' }, status: 200 },
  {
    name: "stale If-None-Match overrides equal If-Modified-Since",
    headers: { "If-None-Match": '"stale"', "If-Modified-Since": lastModified },
    status: 200,
  },
  {
    name: "weak stale If-None-Match overrides later If-Modified-Since",
    headers: { "If-None-Match": 'W/"stale"', "If-Modified-Since": laterModifiedSince },
    status: 200,
  },
  {
    name: "empty If-None-Match overrides later If-Modified-Since",
    headers: { "If-None-Match": "", "If-Modified-Since": laterModifiedSince },
    status: 200,
  },
  { name: "wildcard If-None-Match alone", headers: { "If-None-Match": "*" }, status: 304 },
  {
    name: "wildcard If-None-Match overrides equal If-Modified-Since",
    headers: { "If-None-Match": "*", "If-Modified-Since": lastModified },
    status: 304,
  },
  {
    name: "wildcard If-None-Match overrides older If-Modified-Since",
    headers: { "If-None-Match": "*", "If-Modified-Since": earlierModifiedSince },
    status: 304,
  },
  {
    name: "matching date releases the negotiated representation",
    headers: { "Accept-Encoding": "gzip", "If-Modified-Since": lastModified },
    status: 304,
  },
];

function requestAsset(
  url: string,
  method: "GET" | "HEAD",
  headers: Record<string, string>,
): Promise<{ response: IncomingMessage; body: Buffer }> {
  // Node HTTP preserves an explicitly empty If-None-Match on the wire.
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers, agent: false }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () => resolve({ response, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

describe.each([
  { kind: "bundled", basePath: "", cacheControl: "public, max-age=31536000, immutable" },
  { kind: "resolved", basePath: "/dashboard", cacheControl: "no-cache" },
] as const)("$kind static asset conditional HTTP requests", ({ kind, basePath, cacheControl }) => {
  const tempDirs = createTempDirTracker();
  let server: Server | undefined;
  let assetUrl: string;

  beforeAll(async () => {
    const root = tempDirs.make("openclaw-ui-conditional-");
    const assetPath = path.join(root, "assets", "app-fixture.js");
    await fs.mkdir(path.dirname(assetPath));
    await fs.writeFile(assetPath, assetBody);
    await fs.writeFile(`${assetPath}.gz`, gzipSync(assetBody));
    await fs.utimes(assetPath, modifiedAt, modifiedAt);
    server = createServer((req, res) => {
      void handleControlUiHttpRequest(req, res, {
        basePath,
        config: {},
        root: { kind, path: root, realPath: root },
      }).catch((error: unknown) => {
        res.statusCode = 500;
        res.end(error instanceof Error ? error.message : String(error));
      });
    });
    const listeningServer = server;
    await new Promise<void>((resolve, reject) => {
      listeningServer.once("error", reject);
      listeningServer.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected a TCP listener for the static asset fixture");
    }
    assetUrl = `http://127.0.0.1:${address.port}${basePath}/assets/app-fixture.js`;
  });

  afterAll(async () => {
    try {
      const listeningServer = server;
      if (listeningServer?.listening) {
        await new Promise<void>((resolve, reject) => {
          listeningServer.close((error) => (error ? reject(error) : resolve()));
        });
      }
    } finally {
      tempDirs.cleanup();
    }
  });

  describe.each(["GET", "HEAD"] as const)("%s", (method) => {
    it.each(conditionalCases)("$name", async ({ headers, status }) => {
      const { response, body } = await requestAsset(assetUrl, method, headers);

      expect(response.statusCode).toBe(status);
      expect(response.headers["last-modified"]).toBe(lastModified);
      expect(response.headers["cache-control"]).toBe(cacheControl);
      expect(response.headers.vary).toBe("Accept-Encoding");
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["content-length"]).toBe(
        status === 304 ? undefined : String(assetBody.length),
      );
      expect(body).toEqual(status === 200 && method === "GET" ? assetBody : Buffer.alloc(0));
    });

    it.each<Record<string, string>>([
      { "If-Modified-Since": laterModifiedSince },
      { "If-None-Match": "*" },
      { "If-None-Match": "*", "If-Modified-Since": laterModifiedSince },
      { "If-None-Match": '"stale"', "If-Modified-Since": laterModifiedSince },
    ])("rejects unacceptable encodings before evaluating %j", async (condition) => {
      const { response, body } = await requestAsset(assetUrl, method, {
        ...condition,
        "Accept-Encoding": "identity;q=0, *;q=0",
      });

      expect(response.statusCode).toBe(406);
      expect(response.headers["cache-control"]).toBe("no-store");
      expect(response.headers.vary).toBe("Accept-Encoding");
      expect(response.headers["last-modified"]).toBeUndefined();
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["content-length"]).toBe(String(Buffer.byteLength("Not Acceptable")));
      expect(body.toString()).toBe(method === "GET" ? "Not Acceptable" : "");
    });
  });
});
