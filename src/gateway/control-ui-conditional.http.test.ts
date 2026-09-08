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
const beforeLeapSecondAsset = {
  filename: "leap-before.js",
  modifiedAt: new Date("2016-12-31T23:59:59.000Z"),
  body: Buffer.from('console.log("before leap second");\n'),
};
const afterLeapSecondAsset = {
  filename: "leap-after.js",
  modifiedAt: new Date("2017-01-01T00:00:00.000Z"),
  body: Buffer.from('console.log("after leap second");\n'),
};
const leapSecondDates = [
  { name: "IMF-fixdate", value: "Sat, 31 Dec 2016 23:59:60 GMT" },
  { name: "RFC 850", value: "Saturday, 31-Dec-16 23:59:60 GMT" },
  { name: "asctime", value: "Sat Dec 31 23:59:60 2016" },
];
const conditionalCases: {
  name: string;
  headers: Record<string, string | string[]>;
  status: 200 | 304;
}[] = [
  {
    name: "HTTP-date RFC850 matching instant",
    headers: { "If-Modified-Since": "Monday, 01-Jan-24 00:00:00 GMT" },
    status: 304,
  },
  {
    name: "HTTP-date asctime older UTC instant",
    headers: { "If-Modified-Since": "Sun Dec 31 20:00:00 2023" },
    status: 200,
  },
  {
    name: "HTTP-date asctime matching UTC instant",
    headers: { "If-Modified-Since": "Mon Jan  1 00:00:00 2024" },
    status: 304,
  },
  {
    name: "HTTP-date rejects ISO timestamp",
    headers: { "If-Modified-Since": "2024-01-02T00:00:00.000Z" },
    status: 200,
  },
  {
    name: "HTTP-date rejects duplicate fields with later date first",
    headers: { "If-Modified-Since": [laterModifiedSince, earlierModifiedSince] },
    status: 200,
  },
  {
    name: "HTTP-date rejects duplicate fields with earlier date first",
    headers: { "If-Modified-Since": [earlierModifiedSince, laterModifiedSince] },
    status: 200,
  },
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
    name: "quoted comma/star is not a wildcard and supersedes the date",
    headers: { "If-None-Match": '"client,*,tag"', "If-Modified-Since": lastModified },
    status: 200,
  },
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
  headers: Record<string, string | string[]>,
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
  { kind: "bundled", basePath: "/dashboard", cacheControl: "public, max-age=31536000, immutable" },
  { kind: "resolved", basePath: "/dashboard", cacheControl: "no-cache" },
] as const)("$kind $basePath conditional HTTP", ({ kind, basePath, cacheControl }) => {
  const tempDirs = createTempDirTracker();
  let server: Server | undefined;
  let assetUrl: string;
  let baseUrl: string;

  beforeAll(async () => {
    const root = tempDirs.make("openclaw-ui-conditional-");
    const assetPath = path.join(root, "assets", "app-fixture.js");
    await fs.mkdir(path.dirname(assetPath));
    await fs.writeFile(assetPath, assetBody);
    await fs.writeFile(`${assetPath}.gz`, gzipSync(assetBody));
    await fs.utimes(assetPath, modifiedAt, modifiedAt);
    for (const asset of [beforeLeapSecondAsset, afterLeapSecondAsset]) {
      const target = path.join(root, "assets", asset.filename);
      await fs.writeFile(target, asset.body);
      await fs.utimes(target, asset.modifiedAt, asset.modifiedAt);
    }
    for (const publicAsset of [
      "themes/absolutely.css",
      "fonts/test.css",
      "fonts/test.woff2",
      "provider-icons/ProviderIcon-test.svg",
      "file-icons/compact/dark/pdf.svg",
      "file-icons/large/shell-dark.svg",
      "file-icons/overlays/pdf.svg",
      "apple-touch-icon.png",
      "manifest.webmanifest",
      "sw.js",
    ]) {
      const target = path.join(root, publicAsset);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, assetBody);
      await fs.utimes(target, modifiedAt, modifiedAt);
    }
    await fs.writeFile(
      path.join(root, "index.html"),
      `<html data-openclaw-control-ui-build-id="source-build"><head><link rel="icon" href="./favicon.svg"><link rel="icon" href="${basePath}/favicon-32.png"></head></html>`,
    );
    server = createServer((req, res) => {
      res.setHeader(
        "X-Test-If-Modified-Since-Count",
        String(req.headersDistinct["if-modified-since"]?.length ?? 0),
      );
      void handleControlUiHttpRequest(req, res, {
        basePath,
        config: {},
        root: {
          kind,
          path: root,
          realPath: root,
          ...(kind === "bundled" ? { publicAssetBuildId: "fixture-build" } : {}),
        },
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
    baseUrl = `http://127.0.0.1:${address.port}${basePath}`;
    assetUrl = `${baseUrl}/assets/app-fixture.js`;
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
    it.each([
      "themes/absolutely.css",
      "fonts/test.css",
      "fonts/test.woff2",
      "provider-icons/ProviderIcon-test.svg",
      "file-icons/compact/dark/pdf.svg",
      "file-icons/large/shell-dark.svg",
      "file-icons/overlays/pdf.svg",
      "apple-touch-icon.png",
      "manifest.webmanifest",
      "sw.js",
    ])("versions public %s only for the active bundled build", async (asset) => {
      for (const query of ["", "?v=", "?v=old-build", "?v=fixture-build"]) {
        for (const conditional of [false, true]) {
          const { response, body } = await requestAsset(
            `${baseUrl}/${asset}${query}`,
            method,
            conditional ? { "If-Modified-Since": lastModified } : {},
          );
          const immutable = kind === "bundled" && asset !== "sw.js" && query === "?v=fixture-build";
          expect(response.statusCode).toBe(conditional ? 304 : 200);
          expect(response.headers["cache-control"]).toBe(
            immutable ? "public, max-age=31536000, immutable" : "no-cache",
          );
          expect(response.headers["last-modified"]).toBe(lastModified);
          expect(body).toEqual(!conditional && method === "GET" ? assetBody : Buffer.alloc(0));
        }
      }
    });

    it("keeps versioned documents revalidating and missing public files uncached", async () => {
      const document = await requestAsset(`${baseUrl}/index.html?v=fixture-build`, method, {});
      expect(document.response.statusCode).toBe(200);
      expect(document.response.headers["cache-control"]).toBe("no-cache");
      if (method === "GET") {
        const html = document.body.toString();
        expect(html).not.toContain("source-build");
        expect(html.includes('data-openclaw-control-ui-build-id="fixture-build"')).toBe(
          kind === "bundled",
        );
        expect(html).toContain(
          `href="${basePath}/favicon.svg${kind === "bundled" ? "?v=fixture-build" : ""}"`,
        );
        expect(html).toContain(
          `href="${basePath}/favicon-32.png${kind === "bundled" ? "?v=fixture-build" : ""}"`,
        );
      }
      const missing = await requestAsset(
        `${baseUrl}/themes/missing.css?v=fixture-build`,
        method,
        {},
      );
      expect(missing.response.statusCode).toBe(404);
      expect(missing.response.headers["cache-control"] ?? "").not.toContain("immutable");
    });

    it.each(conditionalCases)("$name", async ({ headers, status }) => {
      const { response, body } = await requestAsset(assetUrl, method, headers);

      if (Array.isArray(headers["If-Modified-Since"])) {
        expect(response.headers["x-test-if-modified-since-count"]).toBe("2");
      }
      expect(response.statusCode, `TZ=${process.env.TZ ?? "system"}`).toBe(status);
      expect(response.headers["last-modified"]).toBe(lastModified);
      expect(response.headers["cache-control"]).toBe(cacheControl);
      expect(response.headers.vary).toBe("Accept-Encoding");
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers["content-length"]).toBe(
        status === 304 ? undefined : String(assetBody.length),
      );
      expect(body).toEqual(status === 200 && method === "GET" ? assetBody : Buffer.alloc(0));
    });

    it.each([
      ...leapSecondDates.flatMap(({ name, value }) => [
        { name: `${name} before midnight`, value, asset: afterLeapSecondAsset, status: 200 },
        {
          name: `${name} after the prior second`,
          value,
          asset: beforeLeapSecondAsset,
          status: 304,
        },
      ]),
      {
        name: "the following midnight equality",
        value: "Sun, 01 Jan 2017 00:00:00 GMT",
        asset: afterLeapSecondAsset,
        status: 304,
      },
    ])("preserves leap second ordering for $name", async ({ value, asset, status }) => {
      const { response, body } = await requestAsset(`${baseUrl}/assets/${asset.filename}`, method, {
        "If-Modified-Since": value,
      });

      expect(response.statusCode).toBe(status);
      expect(response.headers["last-modified"]).toBe(asset.modifiedAt.toUTCString());
      expect(response.headers["cache-control"]).toBe(cacheControl);
      expect(response.headers["content-length"]).toBe(
        status === 304 ? undefined : String(asset.body.length),
      );
      expect(body).toEqual(status === 200 && method === "GET" ? asset.body : Buffer.alloc(0));
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
