// Diffs Language Pack plugin module implements plugin tests.
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it } from "vitest";
import type { OpenClawPluginApi } from "../api.js";
import { registerDiffsLanguagePackPlugin } from "./plugin.js";

const VIEWER_RUNTIME_PATH = "/plugins/diffs-language-pack/assets/viewer-runtime.js";
const UNKNOWN_ASSET_PATH = "/plugins/diffs-language-pack/assets/does-not-exist.js";

type HttpRouteHandler = (req: IncomingMessage, res: ServerResponse) => boolean | Promise<boolean>;

type ServedResponse = {
  status: number;
  contentLength: string | null;
  bodyBytes: number;
};

function captureHandler(): HttpRouteHandler {
  let registeredHttpRouteHandler: HttpRouteHandler | undefined;
  const api = createTestPluginApi({
    id: "diffs-language-pack",
    name: "Diffs Language Pack",
    description: "Diffs Language Pack",
    source: "test",
    config: {},
    registerHttpRoute(params: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]) {
      registeredHttpRouteHandler = params.handler as HttpRouteHandler;
    },
  });
  registerDiffsLanguagePackPlugin(api as unknown as OpenClawPluginApi);
  if (!registeredHttpRouteHandler) {
    throw new Error("expected the plugin to register an HTTP route");
  }
  return registeredHttpRouteHandler;
}

async function withLanguagePackServer(run: (base: string) => Promise<void>): Promise<void> {
  const handler = captureHandler();
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

describe("diffs-language-pack viewer http handler", () => {
  it("sends byte-accurate Content-Length on HEAD asset responses", async () => {
    await withLanguagePackServer(async (base) => {
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
    await withLanguagePackServer(async (base) => {
      const head = await fetchServed(base, UNKNOWN_ASSET_PATH, "HEAD");

      expect(head.status).toBe(404);
      expect(head.bodyBytes).toBe(0);
      expect(head.contentLength).toBe(String(Buffer.byteLength("Asset not found")));
    });
  });
});
