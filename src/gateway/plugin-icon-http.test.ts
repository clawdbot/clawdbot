// Gateway plugin icon HTTP tests cover authenticated identity lookup, bounded
// remote loading, SVG normalization, caching, and failure fallback behavior.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  encodeImage: vi.fn(),
  readImageMetadata: vi.fn(),
  readRemoteMediaBuffer: vi.fn(),
  resolveCatalogIconUrl: vi.fn(),
  resolveIconUrl: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeGatewayHttpRequestOrReply: (...args: unknown[]) => mocks.authorize(...args),
}));

vi.mock("../media/fetch.js", () => ({
  readRemoteMediaBuffer: (...args: unknown[]) => mocks.readRemoteMediaBuffer(...args),
}));

vi.mock("../media/image-ops.js", () => ({
  createImageProcessor: () => ({
    encode: (...args: unknown[]) => mocks.encodeImage(...args),
  }),
  MAX_IMAGE_INPUT_PIXELS: 25_000_000,
  readImageMetadataFromHeader: (...args: unknown[]) => mocks.readImageMetadata(...args),
}));

vi.mock("../plugins/management-service.js", () => ({
  resolveManagedPluginIconUrl: (...args: unknown[]) => mocks.resolveIconUrl(...args),
  resolveManagedSetupCatalogIconUrl: (...args: unknown[]) => mocks.resolveCatalogIconUrl(...args),
}));

const {
  clearPluginIconCacheForTest,
  handlePluginIconHttpRequest,
  PLUGIN_ICON_CACHE_TTL_MS,
  PLUGIN_ICON_MAX_BYTES,
  PLUGIN_ICON_MAX_REDIRECTS,
  PLUGIN_ICON_REQUEST_TIMEOUT_MS,
} = await import("./plugin-icon-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const NORMALIZED_PNG_BYTES = Buffer.from("normalized-png");

let port = 0;
let server: ReturnType<typeof createServer>;
const testConfig = {};
let configForRequest = () => testConfig;

beforeAll(async () => {
  server = createServer((req, res) => {
    void handlePluginIconHttpRequest(req, res, {
      auth: { mode: "token", token: "test-token", allowTailscale: false },
      config: configForRequest(),
    }).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end("unhandled");
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      port = (server.address() as AddressInfo).port;
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  clearPluginIconCacheForTest();
  vi.clearAllMocks();
  configForRequest = () => testConfig;
  mocks.authorize.mockResolvedValue({
    authMethod: "token",
    trustDeclaredOperatorScopes: false,
  });
  mocks.resolveIconUrl.mockResolvedValue("https://cdn.example.test/plugin.svg");
  mocks.resolveCatalogIconUrl.mockImplementation(({ iconUrl }) => iconUrl);
  mocks.readImageMetadata.mockReturnValue({ width: 1, height: 1 });
  mocks.encodeImage.mockResolvedValue({ data: NORMALIZED_PNG_BYTES });
  mocks.readRemoteMediaBuffer.mockResolvedValue({
    buffer: PNG_BYTES,
    contentType: "image/png",
  });
});

function request(pathname: string, options?: { token?: string; method?: string }) {
  const headers: Record<string, string> = {};
  if (options?.token === undefined) {
    headers.Authorization = "Bearer test-token";
  } else if (options.token) {
    headers.Authorization = `Bearer ${options.token}`;
  }
  return fetch(`http://127.0.0.1:${port}${pathname}`, {
    method: options?.method ?? "GET",
    headers,
  });
}

describe("GET /__openclaw__/plugin-icon/:pluginId", () => {
  it("requires gateway authentication before resolving plugin metadata", async () => {
    mocks.authorize.mockImplementationOnce(async ({ res }) => {
      res.statusCode = 401;
      res.end();
      return null;
    });

    const response = await request("/__openclaw__/plugin-icon/firecrawl", { token: "" });

    expect(response.status).toBe(401);
    expect(mocks.resolveIconUrl).not.toHaveBeenCalled();
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("resolves by plugin identity and ignores arbitrary remote URL parameters", async () => {
    const response = await request(
      "/__openclaw__/plugin-icon/firecrawl?url=http%3A%2F%2F127.0.0.1%2Fsecret",
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("cache-control")).toBe("private, max-age=3600");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="plugin-icon"');
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(NORMALIZED_PNG_BYTES);
    expect(mocks.resolveIconUrl).toHaveBeenCalledWith({
      config: testConfig,
      pluginId: "firecrawl",
    });
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledWith({
      url: "https://cdn.example.test/plugin.svg",
      maxBytes: PLUGIN_ICON_MAX_BYTES,
      maxRedirects: PLUGIN_ICON_MAX_REDIRECTS,
      timeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
      responseHeaderTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
      readIdleTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
      requestInit: {
        headers: {
          Accept: "image/avif,image/webp,image/png,image/jpeg,image/gif,image/svg+xml",
        },
      },
    });
    expect(mocks.encodeImage).toHaveBeenCalledWith(PNG_BYTES, {
      format: "png",
      compressionLevel: 9,
      resize: {
        fit: "inside",
        maxSide: 256,
        enlarge: false,
      },
    });
  });

  it("resolves encoded catalog URLs through the server-owned allowlist", async () => {
    const iconUrl = "https://cdn.example.test/setup-tool.svg";
    const response = await request(`/__openclaw__/catalog-icon/${encodeURIComponent(iconUrl)}`);

    expect(response.status).toBe(200);
    expect(mocks.resolveCatalogIconUrl).toHaveBeenCalledWith({
      config: testConfig,
      iconUrl,
    });
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledWith(
      expect.objectContaining({ url: iconUrl }),
    );
  });

  it("does not fetch catalog URLs rejected by the server-owned allowlist", async () => {
    mocks.resolveCatalogIconUrl.mockReturnValueOnce(undefined);
    const response = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent("https://untrusted.example/icon.png")}`,
    );

    expect(response.status).toBe(404);
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("serves SVG only as a sandboxed attachment for browser-side rasterization", async () => {
    const svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from(svg),
      contentType: "image/svg+xml",
    });

    const response = await request("/__openclaw__/plugin-icon/simple-icons");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="plugin-icon"');
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(svg);
  });

  it("reuses successful icon bytes from the bounded process cache", async () => {
    configForRequest = () => ({});
    const first = await request("/__openclaw__/plugin-icon/firecrawl");
    const second = await request("/__openclaw__/plugin-icon/firecrawl");

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(mocks.resolveIconUrl).toHaveBeenCalledTimes(2);
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(1);
  });

  it("accepts one canonical scoped plugin id encoded as a single path segment", async () => {
    const response = await request(
      `/__openclaw__/plugin-icon/${encodeURIComponent("@expediagroup/expedia-openclaw")}`,
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveIconUrl).toHaveBeenCalledWith({
      config: testConfig,
      pluginId: "@expediagroup/expedia-openclaw",
    });
  });

  it("refreshes cached icon bytes after the cache lifetime", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const first = await request("/__openclaw__/plugin-icon/firecrawl");
      const cached = await request("/__openclaw__/plugin-icon/firecrawl");
      now.mockReturnValue(1_000 + PLUGIN_ICON_CACHE_TTL_MS + 1);
      const refreshed = await request("/__openclaw__/plugin-icon/firecrawl");

      expect(first.status).toBe(200);
      expect(cached.status).toBe(200);
      expect(refreshed.status).toBe(200);
      expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("returns not found when metadata is absent or remote image validation fails", async () => {
    mocks.resolveIconUrl.mockResolvedValueOnce(undefined);
    const missing = await request("/__openclaw__/plugin-icon/missing");
    expect(missing.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("<html>nope</html>"),
      contentType: "text/html",
    });
    const invalid = await request("/__openclaw__/plugin-icon/not-an-image");
    expect(invalid.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("<html>still nope</html>"),
      contentType: "image/png",
    });
    const mislabeled = await request("/__openclaw__/plugin-icon/mislabeled");
    expect(mislabeled.status).toBe(404);

    mocks.readImageMetadata.mockReturnValueOnce({ width: 10_000, height: 10_000 });
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: PNG_BYTES,
      contentType: "image/png",
    });
    const oversized = await request("/__openclaw__/plugin-icon/oversized");
    expect(oversized.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockRejectedValueOnce(new Error("upstream failed"));
    const failed = await request("/__openclaw__/plugin-icon/broken");
    expect(failed.status).toBe(404);
  });

  it("rejects non-GET methods without loading metadata", async () => {
    const response = await request("/__openclaw__/plugin-icon/firecrawl", { method: "POST" });

    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(mocks.resolveIconUrl).not.toHaveBeenCalled();
  });

  it("matches the configured Control UI base path", async () => {
    const handledServer = createServer((req, res) => {
      void handlePluginIconHttpRequest(req, res, {
        auth: { mode: "token", token: "test-token", allowTailscale: false },
        config: {},
        basePath: "/openclaw",
      }).then((handled) => {
        if (!handled) {
          res.statusCode = 404;
          res.end("unhandled");
        }
      });
    });
    await new Promise<void>((resolve, reject) => {
      handledServer.once("error", reject);
      handledServer.listen(0, "127.0.0.1", resolve);
    });
    try {
      const handledPort = (handledServer.address() as AddressInfo).port;
      const response = await fetch(
        `http://127.0.0.1:${handledPort}/openclaw/__openclaw__/plugin-icon/firecrawl`,
        { headers: { Authorization: "Bearer test-token" } },
      );
      expect(response.status).toBe(200);
    } finally {
      await new Promise<void>((resolve, reject) => {
        handledServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
