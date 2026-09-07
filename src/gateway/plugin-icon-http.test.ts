// Gateway plugin icon HTTP tests cover authenticated identity lookup, bounded
// package loading, SVG normalization, caching, and failure fallback behavior.
import { execFileSync } from "node:child_process";
import fs, { mkdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import * as boundaryFileRead from "../infra/boundary-file-read.js";
import { createDeferredCore } from "../shared/deferred.js";
import { APNG_BYTES } from "./http-image.test-support.js";
import { AUTH_NONE, sendRequest, withGatewayServer } from "./server-http.test-harness.js";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  encodeImage: vi.fn(),
  readImageMetadata: vi.fn(),
  readRemoteMediaBuffer: vi.fn(),
  resolveCatalogIconUrl: vi.fn(),
  resolveIconSource: vi.fn(),
}));

vi.mock("./http-utils.js", () => ({
  authorizeControlUiReadRequestOrReply: (...args: unknown[]) => mocks.authorize(...args),
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
  resolveManagedPluginIconSource: (...args: unknown[]) => mocks.resolveIconSource(...args),
  resolveManagedSetupCatalogIconUrl: (...args: unknown[]) => mocks.resolveCatalogIconUrl(...args),
}));

const {
  clearPluginIconCacheForTest,
  handlePluginIconHttpRequest,
  LINK_FAVICON_MAX_BYTES,
  PLUGIN_ICON_CACHE_TTL_MS,
  PLUGIN_ICON_MAX_REDIRECTS,
  PLUGIN_ICON_REQUEST_TIMEOUT_MS,
} = await import("./plugin-icon-http.js");

const PNG_BYTES = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zb0YAAAAASUVORK5CYII=",
  "base64",
);
const NORMALIZED_PNG_BYTES = Buffer.from("normalized-png");
const fixtureDirs = useAutoCleanupTempDirTracker(afterAll);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const iconFixtureDir = fixtureDirs.make("openclaw-plugin-icon-");
const localIconPath = path.join(iconFixtureDir, "icon.png");
writeFileSync(localIconPath, PNG_BYTES);
const ICO_BYTES = Buffer.from([
  0, 0, 1, 0, 1, 0, 16, 16, 0, 0, 1, 0, 32, 0, 0, 0, 0, 0, 22, 0, 0, 0,
]);
const CATALOG_ICON_URL = "https://cdn.example.test/setup-tool.svg";
const ICON_ROUTES = [
  { label: "plugin", pathname: "/__openclaw__/plugin-icon/firecrawl" },
  {
    label: "catalog",
    pathname: `/__openclaw__/catalog-icon/${encodeURIComponent(CATALOG_ICON_URL)}`,
  },
] as const;
const ALL_ICON_ROUTES = [
  ...ICON_ROUTES,
  { label: "favicon", pathname: "/__openclaw__/link-favicon/example.com" },
];
const INVALID_ICON_ROUTES = [
  { label: "blank plugin id", pathname: "/__openclaw__/plugin-icon/" },
  { label: "invalid plugin id", pathname: "/__openclaw__/plugin-icon/%20" },
  { label: "malformed plugin id", pathname: "/__openclaw__/plugin-icon/%zz" },
  { label: "nested plugin id", pathname: "/__openclaw__/plugin-icon/one/two" },
  { label: "blank catalog URL", pathname: "/__openclaw__/catalog-icon/" },
  { label: "malformed catalog URL", pathname: "/__openclaw__/catalog-icon/%zz" },
  { label: "nested catalog URL", pathname: "/__openclaw__/catalog-icon/one/two" },
] as const;

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
  writeFileSync(localIconPath, PNG_BYTES);
  configForRequest = () => testConfig;
  mocks.authorize.mockReset();
  mocks.authorize.mockResolvedValue({
    authMethod: "token",
    operatorScopes: ["operator.admin", "operator.read"],
  });
  mocks.resolveIconSource.mockResolvedValue({
    kind: "file",
    path: localIconPath,
    rootPath: iconFixtureDir,
  });
  mocks.resolveCatalogIconUrl.mockImplementation(({ iconUrl }) => iconUrl);
  mocks.readImageMetadata.mockReturnValue({ width: 1, height: 1 });
  mocks.encodeImage.mockResolvedValue({ data: NORMALIZED_PNG_BYTES });
  mocks.readRemoteMediaBuffer.mockResolvedValue({
    buffer: PNG_BYTES,
    contentType: "image/png",
  });
});

function request(
  pathname: string,
  options?: { token?: string; method?: string; headers?: Record<string, string> },
) {
  const headers: Record<string, string> = { ...options?.headers };
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

describe("Control UI plugin and catalog icon routes", () => {
  it("keeps link favicon fetching off when explicitly disabled", async () => {
    configForRequest = () => ({
      gateway: { controlUi: { automaticallyFetchFavicons: false } },
    });
    const response = await request("/__openclaw__/link-favicon/example.com");

    expect(response.status).toBe(404);
    expect(mocks.authorize).toHaveBeenCalledOnce();
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("authenticates enabled link favicon requests before any remote fetch", async () => {
    configForRequest = () => ({
      gateway: { controlUi: { automaticallyFetchFavicons: true } },
    });
    mocks.authorize.mockImplementationOnce(async ({ res }) => {
      res.statusCode = 401;
      res.end();
      return null;
    });

    const response = await request("/__openclaw__/link-favicon/example.com", { token: "" });

    expect(response.status).toBe(401);
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it.each([
    "localhost",
    "router.local",
    "metadata.google.internal",
    "127.0.0.1",
    "8.8.8.8",
    "[::1]",
    "example.com/secret",
    "example.com:443",
    "user@example.com",
  ])("rejects non-public-domain favicon host %s without fetching", async (hostname) => {
    configForRequest = () => ({
      gateway: { controlUi: { automaticallyFetchFavicons: true } },
    });

    const response = await request(`/__openclaw__/link-favicon/${encodeURIComponent(hostname)}`);

    expect(response.status).toBe(404);
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
  });

  it("fetches by default only through the fixed HTTPS path and strict media guard", async () => {
    const response = await request("/__openclaw__/link-favicon/Example.COM");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="link-favicon"');
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledOnce();
    const fetchOptions = mocks.readRemoteMediaBuffer.mock.calls[0]?.[0];
    expect(fetchOptions).toMatchObject({
      url: "https://example.com/favicon.ico",
      maxBytes: LINK_FAVICON_MAX_BYTES,
      maxRedirects: PLUGIN_ICON_MAX_REDIRECTS,
      requireHttps: true,
      timeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
      responseHeaderTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
      readIdleTimeoutMs: PLUGIN_ICON_REQUEST_TIMEOUT_MS,
    });
    expect(fetchOptions).not.toHaveProperty("ssrfPolicy");
  });

  it("keeps the Gateway responsive while rejecting an adversarial SVG favicon", async () => {
    const validationStarted = createDeferredCore();
    mocks.readRemoteMediaBuffer.mockImplementationOnce(async () => {
      validationStarted.resolve();
      return {
        buffer: Buffer.from(`<!--${"--><!--".repeat(26)}-->X`),
        contentType: "image/svg+xml",
      };
    });

    await withGatewayServer({
      prefix: "link-favicon-svg-validation-",
      resolvedAuth: AUTH_NONE,
      overrides: {
        controlUiEnabled: true,
        controlUiBasePath: "",
        getRuntimeConfig: () => ({}),
      },
      run: async (gateway) => {
        const started = process.hrtime.bigint();
        const favicon = sendRequest(gateway, {
          path: "/__openclaw__/link-favicon/example.com",
        });
        await validationStarted.promise;
        const health = sendRequest(gateway, { path: "/healthz" });
        const [faviconResponse, healthResponse] = await Promise.all([favicon, health]);
        const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;

        expect(faviconResponse.res.statusCode).toBe(404);
        expect(healthResponse.res.statusCode).toBe(200);
        expect(elapsedMs).toBeLessThan(500);
      },
    });
  });

  it("serves standard ICO favicon bytes without invoking raster processing", async () => {
    configForRequest = () => ({
      gateway: { controlUi: { automaticallyFetchFavicons: true } },
    });
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: ICO_BYTES,
      contentType: "image/vnd.microsoft.icon",
    });

    const response = await request("/__openclaw__/link-favicon/github.com");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/x-icon");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(ICO_BYTES);
    expect(mocks.encodeImage).not.toHaveBeenCalled();
  });

  it.each(
    ALL_ICON_ROUTES.flatMap(({ label, pathname }) =>
      ["image/png", "image/apng; charset=binary"].map((contentType) => ({
        label,
        pathname,
        contentType,
      })),
    ),
  )(
    "normalizes APNG $label bytes declared as $contentType to PNG",
    async ({ label, pathname, contentType }) => {
      if (label === "plugin") {
        writeFileSync(localIconPath, APNG_BYTES);
      } else {
        mocks.readRemoteMediaBuffer.mockResolvedValueOnce({ buffer: APNG_BYTES, contentType });
      }
      mocks.encodeImage.mockResolvedValue({ data: PNG_BYTES });

      const response = await request(pathname);

      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG_BYTES);
      const head = await request(pathname, { method: "HEAD" });
      expect(head.status).toBe(200);
      expect(head.headers.get("content-type")).toBe("image/png");
      expect(head.headers.get("content-length")).toBe(String(PNG_BYTES.byteLength));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
    },
  );

  it("negatively caches failed link favicon fetches", async () => {
    configForRequest = () => ({
      gateway: { controlUi: { automaticallyFetchFavicons: true } },
    });
    mocks.readRemoteMediaBuffer.mockRejectedValueOnce(new Error("upstream failed"));

    const first = await request("/__openclaw__/link-favicon/missing.example");
    const second = await request("/__openclaw__/link-favicon/missing.example");

    expect(first.status).toBe(404);
    expect(second.status).toBe(404);
    expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledOnce();
  });

  it.each(INVALID_ICON_ROUTES)(
    "claims $label instead of falling through to the Control UI",
    async ({ pathname }) => {
      const response = await request(pathname);

      expect(response.status).toBe(404);
      await expect(response.text()).resolves.toBe("Not Found");
      expect(mocks.authorize).toHaveBeenCalledOnce();
      expect(mocks.resolveIconSource).not.toHaveBeenCalled();
      expect(mocks.resolveCatalogIconUrl).not.toHaveBeenCalled();
      expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    },
  );

  it.each(
    ALL_ICON_ROUTES.flatMap(({ label, pathname }) =>
      (["GET", "HEAD"] as const).map((method) => ({ label, method, pathname })),
    ),
  )(
    "authenticates $method $label icons before resolving their metadata",
    async ({ method, pathname }) => {
      mocks.authorize.mockImplementationOnce(async ({ res }) => {
        res.statusCode = 401;
        res.end();
        return null;
      });

      const response = await request(pathname, {
        method,
        token: "",
        headers: { "If-None-Match": "*" },
      });

      expect(response.status).toBe(401);
      expect(mocks.resolveIconSource).not.toHaveBeenCalled();
      expect(mocks.resolveCatalogIconUrl).not.toHaveBeenCalled();
      expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    },
  );

  it.each(
    ALL_ICON_ROUTES.flatMap(({ label, pathname }) =>
      (["image/png", "image/svg+xml", "image/x-icon"] as const).map((contentType) => ({
        contentType,
        label,
        pathname,
      })),
    ),
  )(
    "preserves $contentType $label GET/HEAD headers and revalidates cached bytes",
    async ({ contentType, label, pathname }) => {
      const svg = "<svg xmlns='http://www.w3.org/2000/svg'></svg>";
      if (contentType === "image/svg+xml") {
        mocks.readRemoteMediaBuffer.mockResolvedValue({ buffer: Buffer.from(svg), contentType });
      } else if (contentType === "image/x-icon") {
        mocks.readRemoteMediaBuffer.mockResolvedValue({ buffer: ICO_BYTES, contentType });
      }

      const get = await request(pathname);
      const head = await request(pathname, { method: "HEAD" });

      expect(get.status).toBe(200);
      expect(head.status).toBe(200);
      for (const name of [
        "cache-control",
        "content-disposition",
        "content-length",
        "content-security-policy",
        "content-type",
        "cross-origin-resource-policy",
        "etag",
        "x-content-type-options",
      ]) {
        expect(head.headers.get(name), name).toBe(get.headers.get(name));
      }
      const expectedBody =
        label !== "plugin" && contentType === "image/svg+xml"
          ? Buffer.from(svg)
          : label !== "plugin" && contentType === "image/x-icon"
            ? ICO_BYTES
            : NORMALIZED_PNG_BYTES;
      expect(Buffer.from(await get.arrayBuffer())).toEqual(expectedBody);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      const etag = get.headers.get("etag");
      expect(etag).toBeTruthy();
      for (const method of ["GET", "HEAD"]) {
        const cached = await request(pathname, {
          method,
          headers: { "If-None-Match": `W/${etag}` },
        });
        expect(cached.status).toBe(304);
        expect(cached.headers.get("etag")).toBe(etag);
        expect(cached.headers.get("content-security-policy")).toContain("sandbox");
        expect((await cached.arrayBuffer()).byteLength).toBe(0);
      }
      expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(label === "plugin" ? 0 : 1);
    },
  );

  it("does not use arbitrary remote URL parameters when no package icon exists", async () => {
    mocks.resolveIconSource.mockResolvedValueOnce(undefined);
    const response = await request(
      "/__openclaw__/plugin-icon/firecrawl?url=http%3A%2F%2F127.0.0.1%2Fsecret",
    );

    expect(response.status).toBe(404);
    expect(mocks.resolveIconSource).toHaveBeenCalledWith({
      config: testConfig,
      pluginId: "firecrawl",
    });
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    expect(mocks.encodeImage).not.toHaveBeenCalled();
  });

  it("serves a portable package icon without making a remote request", async () => {
    mocks.resolveIconSource.mockResolvedValueOnce({
      kind: "file",
      path: localIconPath,
      rootPath: iconFixtureDir,
    });

    const response = await request("/__openclaw__/plugin-icon/local-plugin");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(NORMALIZED_PNG_BYTES);
    expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
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

  it("closes the descriptor when rejecting an empty package icon", async () => {
    writeFileSync(localIconPath, "");
    let tracked: { fd: number; closed: boolean } | undefined;
    const openRootFile = boundaryFileRead.openRootFile;
    const opened = vi.spyOn(boundaryFileRead, "openRootFile").mockImplementation(async (params) => {
      const receipt = await openRootFile(params);
      if (receipt.ok) {
        // Earlier closes of this fd number belong to a different open.
        tracked = { fd: receipt.fd, closed: false };
      }
      return receipt;
    });
    const closeSync = fs.closeSync;
    const closed = vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
      closeSync(fd);
      if (tracked?.fd === fd) {
        tracked.closed = true;
      }
    });
    try {
      // The owner imports Node's named binding; observe release before the fd number can be reused.
      syncBuiltinESMExports();
      const response = await request("/__openclaw__/plugin-icon/empty-package");
      expect(response.status).toBe(404);
      expect(tracked?.closed).toBe(true);
    } finally {
      try {
        if (tracked && !tracked.closed) {
          closeSync(tracked.fd);
        }
      } finally {
        opened.mockRestore();
        closed.mockRestore();
        syncBuiltinESMExports();
      }
    }
  });

  it("rejects a package icon redirected outside its package after discovery", async () => {
    const fixtureRoot = tempDirs.make("openclaw-plugin-icon-swap-");
    const packageRoot = path.join(fixtureRoot, "package");
    const assetsPath = path.join(packageRoot, "assets");
    const displacedAssetsPath = path.join(packageRoot, "assets-original");
    const outsidePath = path.join(fixtureRoot, "outside");
    const iconPath = path.join(assetsPath, "icon.png");
    mkdirSync(assetsPath, { recursive: true });
    mkdirSync(outsidePath);
    writeFileSync(iconPath, PNG_BYTES);
    writeFileSync(path.join(outsidePath, "icon.png"), PNG_BYTES);
    renameSync(assetsPath, displacedAssetsPath);
    symlinkSync(outsidePath, assetsPath, "dir");
    mocks.resolveIconSource.mockResolvedValueOnce({
      kind: "file",
      path: iconPath,
      rootPath: packageRoot,
    });

    const response = await request("/__openclaw__/plugin-icon/swapped-package");

    expect(response.status).toBe(404);
    expect(mocks.encodeImage).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")(
    "rejects a substituted package icon FIFO without waiting for a writer",
    async () => {
      const fixtureRoot = tempDirs.make("openclaw-plugin-icon-fifo-");
      const iconPath = path.join(fixtureRoot, "icon.png");
      execFileSync("mkfifo", [iconPath]);
      mocks.resolveIconSource.mockResolvedValueOnce({
        kind: "file",
        path: iconPath,
        rootPath: fixtureRoot,
      });
      const delayedWriter = setTimeout(() => writeFileSync(iconPath, PNG_BYTES), 250);
      const startedAt = performance.now();

      try {
        const response = await request("/__openclaw__/plugin-icon/fifo-package");

        expect(response.status).toBe(404);
        expect(performance.now() - startedAt).toBeLessThan(200);
        expect(mocks.encodeImage).not.toHaveBeenCalled();
      } finally {
        clearTimeout(delayedWriter);
      }
    },
  );

  it("resolves encoded catalog URLs through the server-owned allowlist", async () => {
    const iconUrl = CATALOG_ICON_URL;
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

    const response = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent(CATALOG_ICON_URL)}`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="plugin-icon"');
    expect(response.headers.get("content-security-policy")).toContain("sandbox");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe(svg);
  });

  it.each(ICON_ROUTES)(
    "shares one $label icon download across concurrent GET and HEAD",
    async ({ label, pathname }) => {
      const [get, head] = await Promise.all([
        request(pathname),
        request(pathname, { method: "HEAD" }),
      ]);

      expect(get.status).toBe(200);
      expect(head.status).toBe(200);
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(label === "catalog" ? 1 : 0);
      expect(mocks.encodeImage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ICON_ROUTES)(
    "reuses a $label icon loaded by HEAD on a later GET",
    async ({ label, pathname }) => {
      const head = await request(pathname, { method: "HEAD" });
      const get = await request(pathname);

      expect(head.status).toBe(200);
      expect(get.status).toBe(200);
      expect(head.headers.get("content-length")).toBe(get.headers.get("content-length"));
      expect((await head.arrayBuffer()).byteLength).toBe(0);
      expect(Buffer.from(await get.arrayBuffer())).toEqual(NORMALIZED_PNG_BYTES);
      expect(mocks.readRemoteMediaBuffer).toHaveBeenCalledTimes(label === "catalog" ? 1 : 0);
      expect(mocks.encodeImage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(ICON_ROUTES)(
    "returns a bodyless 404 for an unavailable $label icon HEAD",
    async ({ label, pathname }) => {
      if (label === "plugin") {
        mocks.resolveIconSource.mockResolvedValueOnce(undefined);
      } else {
        mocks.resolveCatalogIconUrl.mockReturnValueOnce(undefined);
      }

      const response = await request(pathname, { method: "HEAD" });

      expect(response.status).toBe(404);
      expect(response.headers.get("content-length")).toBe("9");
      expect((await response.arrayBuffer()).byteLength).toBe(0);
      expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
    },
  );

  it("accepts one canonical scoped plugin id encoded as a single path segment", async () => {
    const response = await request(
      `/__openclaw__/plugin-icon/${encodeURIComponent("@expediagroup/expedia-openclaw")}`,
    );

    expect(response.status).toBe(200);
    expect(mocks.resolveIconSource).toHaveBeenCalledWith({
      config: testConfig,
      pluginId: "@expediagroup/expedia-openclaw",
    });
  });

  it("refreshes cached icon bytes after the cache lifetime", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      mocks.encodeImage.mockResolvedValueOnce({ data: PNG_BYTES });
      const first = await request("/__openclaw__/plugin-icon/firecrawl");
      const etag = first.headers.get("etag");
      const cached = await request("/__openclaw__/plugin-icon/firecrawl");
      now.mockReturnValue(1_000 + PLUGIN_ICON_CACHE_TTL_MS + 1);
      const refreshed = await request("/__openclaw__/plugin-icon/firecrawl", {
        headers: { "If-None-Match": etag ?? "" },
      });

      expect(first.status).toBe(200);
      expect(cached.status).toBe(200);
      expect(cached.headers.get("etag")).toBe(etag);
      expect(refreshed.status).toBe(200);
      expect(refreshed.headers.get("etag")).not.toBe(etag);
      expect(Buffer.from(await refreshed.arrayBuffer())).toEqual(NORMALIZED_PNG_BYTES);
      expect(mocks.readRemoteMediaBuffer).not.toHaveBeenCalled();
      expect(mocks.encodeImage).toHaveBeenCalledTimes(2);
    } finally {
      now.mockRestore();
    }
  });

  it("returns not found when plugin metadata is absent or catalog image validation fails", async () => {
    mocks.resolveIconSource.mockResolvedValueOnce(undefined);
    const missing = await request("/__openclaw__/plugin-icon/missing");
    expect(missing.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("<html>nope</html>"),
      contentType: "text/html",
    });
    const invalid = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent("https://cdn.example.test/not-an-image")}`,
    );
    expect(invalid.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: Buffer.from("<html>still nope</html>"),
      contentType: "image/png",
    });
    const mislabeled = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent("https://cdn.example.test/mislabeled")}`,
    );
    expect(mislabeled.status).toBe(404);

    mocks.readImageMetadata.mockReturnValueOnce({ width: 10_000, height: 10_000 });
    mocks.readRemoteMediaBuffer.mockResolvedValueOnce({
      buffer: PNG_BYTES,
      contentType: "image/png",
    });
    const oversized = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent("https://cdn.example.test/oversized")}`,
    );
    expect(oversized.status).toBe(404);

    mocks.readRemoteMediaBuffer.mockRejectedValueOnce(new Error("upstream failed"));
    const failed = await request(
      `/__openclaw__/catalog-icon/${encodeURIComponent("https://cdn.example.test/broken")}`,
    );
    expect(failed.status).toBe(404);
  });

  it.each(ICON_ROUTES)(
    "rejects non-read $label icon methods without loading metadata",
    async ({ pathname }) => {
      const response = await request(pathname, { method: "POST" });

      expect(response.status).toBe(405);
      expect(response.headers.get("allow")).toBe("GET, HEAD");
      expect(mocks.resolveIconSource).not.toHaveBeenCalled();
      expect(mocks.resolveCatalogIconUrl).not.toHaveBeenCalled();
    },
  );

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
      for (const { pathname } of ICON_ROUTES) {
        for (const method of ["GET", "HEAD"]) {
          const response = await fetch(`http://127.0.0.1:${handledPort}/openclaw${pathname}`, {
            headers: { Authorization: "Bearer test-token" },
            method,
          });
          expect(response.status).toBe(200);
          if (method === "HEAD") {
            expect((await response.arrayBuffer()).byteLength).toBe(0);
          }
        }
      }
    } finally {
      await new Promise<void>((resolve, reject) => {
        handledServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
