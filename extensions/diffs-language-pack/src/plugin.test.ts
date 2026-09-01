// Diffs Language Pack plugin module implements plugin tests.
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { withServer } from "openclaw/plugin-sdk/test-env";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawPluginApi, OpenClawPluginHttpRouteHandler } from "../api.js";
import { registerDiffsLanguagePackPlugin } from "./plugin.js";

const execFileAsync = promisify(execFile);

const VIEWER_RUNTIME_PATH = "/plugins/diffs-language-pack/assets/viewer-runtime.js";
const UNKNOWN_ASSET_PATH = "/plugins/diffs-language-pack/assets/does-not-exist.js";

type ServedResponse = {
  status: number;
  contentLength: string | null;
  bodyBytes: number;
};

async function ensureViewerRuntimeForTests(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const runtimePath = path.join(
    repoRoot,
    "extensions",
    "diffs-language-pack",
    "assets",
    "viewer-runtime.js",
  );
  try {
    await fs.stat(runtimePath);
    return;
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  // viewer-runtime.js is ignored generated output; build the fixture before
  // serving assets in a clean checkout.
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/build-diffs-viewer-runtime.mts", "full"],
    { cwd: repoRoot },
  );
}

beforeAll(async () => {
  await ensureViewerRuntimeForTests();
}, 120_000);

function captureHandler(): OpenClawPluginHttpRouteHandler {
  let registeredHttpRouteHandler: OpenClawPluginHttpRouteHandler | undefined;
  const api = createTestPluginApi({
    id: "diffs-language-pack",
    name: "Diffs Language Pack",
    description: "Diffs Language Pack",
    source: "test",
    config: {},
    registerHttpRoute(params: Parameters<OpenClawPluginApi["registerHttpRoute"]>[0]) {
      registeredHttpRouteHandler = params.handler;
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
  await withServer((req, res) => {
    void Promise.resolve(handler(req, res)).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  }, run);
}

async function fetchServed(
  base: string,
  requestPath: string,
  method = "GET",
): Promise<ServedResponse> {
  const response = await fetch(`${base}${requestPath}`, { method });
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
