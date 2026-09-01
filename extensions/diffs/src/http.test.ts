// Diffs plugin module implements http tests.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { beforeAll, describe, expect, it } from "vitest";
import { createDiffsHttpHandler } from "./http.js";
import type { DiffArtifactStore } from "./store.js";
import { ensureCuratedViewerRuntimeForTests } from "./test-helpers.js";

const VIEWER_RUNTIME_PATH = "/plugins/diffs/assets/viewer-runtime.js";
const UNKNOWN_ASSET_PATH = "/plugins/diffs/assets/does-not-exist.js";
const UNKNOWN_VIEW_PATH = "/plugins/diffs/view/not-an-artifact/not-a-token";

beforeAll(async () => {
  // viewer-runtime.js is ignored generated output; build the fixture before
  // serving assets in a clean checkout.
  await ensureCuratedViewerRuntimeForTests();
});

type ServedResponse = {
  status: number;
  contentLength: string | null;
  bodyBytes: number;
};

async function withDiffsServer(run: (base: string) => Promise<void>): Promise<void> {
  const handler = createDiffsHttpHandler({ store: {} as DiffArtifactStore });
  const server: Server = createServer((req, res) => {
    void handler(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("expected TCP server address");
  }
  try {
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

async function fetchServed(base: string, path: string, method = "GET"): Promise<ServedResponse> {
  const response = await fetch(`${base}${path}`, { method });
  const body = await response.arrayBuffer();
  return {
    status: response.status,
    contentLength: response.headers.get("content-length"),
    bodyBytes: body.byteLength,
  };
}

describe("diffs viewer http handler", () => {
  it("sends byte-accurate Content-Length on HEAD asset responses", async () => {
    await withDiffsServer(async (base) => {
      const get = await fetchServed(base, VIEWER_RUNTIME_PATH);
      const head = await fetchServed(base, VIEWER_RUNTIME_PATH, "HEAD");

      expect(get.status).toBe(200);
      expect(get.bodyBytes).toBeGreaterThan(0);
      expect(get.contentLength).toBe(String(get.bodyBytes));
      expect(head.status).toBe(200);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(get.bodyBytes));
    });
  });

  it("sends Content-Length on HEAD 404 responses for missing assets", async () => {
    await withDiffsServer(async (base) => {
      const head = await fetchServed(base, UNKNOWN_ASSET_PATH, "HEAD");

      expect(head.status).toBe(404);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(Buffer.byteLength("Asset not found")));
    });
  });

  it("sends Content-Length on HEAD 404 responses for unknown diff views", async () => {
    await withDiffsServer(async (base) => {
      const head = await fetchServed(base, UNKNOWN_VIEW_PATH, "HEAD");

      expect(head.status).toBe(404);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(Buffer.byteLength("Diff not found")));
    });
  });
});
