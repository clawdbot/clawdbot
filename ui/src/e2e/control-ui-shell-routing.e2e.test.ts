import { writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { takeControlUiViewportScreenshot } from "../test-helpers/control-ui-e2e-screenshot.ts";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
let artifactDir: string;
beforeEach(() => {
  artifactDir = createControlUiE2eArtifactDir("control-ui-shell-routing");
});
const basePath = "/control";
const forwardedHeaderBlocklist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);
const publicAssetPaths = new Set([
  "/apple-touch-icon.png",
  "/favicon-32.png",
  "/favicon.svg",
  "/manifest.webmanifest",
]);

type BasePathProxy = {
  baseUrl: string;
  close: () => Promise<void>;
  requests: string[];
};

let browser: Browser;
let server: ControlUiE2eServer;
let proxy: BasePathProxy;

async function listenOnLoopback(httpServer: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      const address = httpServer.address();
      if (!address || typeof address === "string") {
        reject(new Error("Control UI base-path proxy did not expose a loopback port"));
        return;
      }
      resolve(address);
    });
  });
}

async function startBasePathProxy(upstreamBaseUrl: string): Promise<BasePathProxy> {
  const requests: string[] = [];
  const proxyServer = createServer((request, response) => {
    void (async () => {
      const incomingUrl = new URL(request.url ?? "/", "http://control-ui.invalid");
      requests.push(incomingUrl.pathname);
      const hasBasePath = incomingUrl.pathname.startsWith(`${basePath}/`);
      if (!hasBasePath && publicAssetPaths.has(incomingUrl.pathname)) {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Public assets require the configured Control UI base path");
        return;
      }
      const upstreamPath = hasBasePath
        ? incomingUrl.pathname.slice(basePath.length)
        : incomingUrl.pathname;
      const upstreamUrl = new URL(`${upstreamPath}${incomingUrl.search}`, upstreamBaseUrl);
      const upstream = await fetch(upstreamUrl, {
        headers: { Accept: request.headers.accept ?? "*/*" },
        method: request.method,
        // Let Chromium observe redirects so the proxy cannot hide a root-mount regression.
        redirect: "manual",
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!forwardedHeaderBlocklist.has(name)) {
          response.setHeader(name, value);
        }
      }
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      let body = Buffer.from(await upstream.arrayBuffer());
      if (
        incomingUrl.pathname.startsWith(`${basePath}/`) &&
        upstream.headers.get("content-type")?.startsWith("text/html")
      ) {
        body = Buffer.from(
          body
            .toString("utf8")
            .replace("<html", `<html data-openclaw-control-ui-base-path="${basePath}"`),
        );
      }
      response.end(body);
    })().catch((error: unknown) => {
      response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      response.end(error instanceof Error ? error.message : String(error));
    });
  });

  const address = await listenOnLoopback(proxyServer);
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        proxyServer.close((error) => (error ? reject(error) : resolve()));
      }),
    requests,
  };
}

describeControlUiE2e("Control UI shell routing E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer(undefined, { source: true });
    proxy = await startBasePathProxy(server.baseUrl);
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await proxy?.close();
    await server?.close();
  });

  it("opens a base-path route and connects to the confirmed alternate Gateway URL", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      recordVideo: { dir: artifactDir, size: { height: 720, width: 1280 } },
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const explicitGatewayUrl = "ws://127.0.0.1:29991/alternate";
    const gateway = await installMockGateway(page, { basePath });

    try {
      const url = new URL(`${basePath}/chat`, proxy.baseUrl);
      url.hash = new URLSearchParams({ gatewayUrl: explicitGatewayUrl }).toString();
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);

      const confirmation = page.locator("openclaw-gateway-url-confirmation");
      await confirmation.waitFor();
      expect(await confirmation.getByText(explicitGatewayUrl, { exact: true }).count()).toBe(1);
      await confirmation
        .getByRole("button", { name: "Switch to 127.0.0.1:29991", exact: true })
        .click();

      await gateway.waitForRequest("connect");
      await page.locator("openclaw-app-shell").waitFor();
      await page.locator("openclaw-chat-page").waitFor();

      expect(new URL(page.url()).pathname).toBe(`${basePath}/chat/main`);
      expect(new URL(page.url()).hash).toBe("");
      expect((await gateway.getSocketUrls()).at(-1)).toBe(explicitGatewayUrl);
      expect(await page.locator("html").getAttribute("data-openclaw-control-ui-base-path")).toBe(
        basePath,
      );

      // The proxy rejects root asset fallbacks. Assert the rewritten DOM and
      // request paths so only main.ts can make these links load under the base path.
      const assetResults = await page.evaluate(async () => {
        const links = Array.from(
          document.querySelectorAll<HTMLLinkElement>(
            'link[rel="icon"], link[rel="apple-touch-icon"], link[rel="manifest"]',
          ),
        );
        return Promise.all(
          links.map(async (link) => {
            const assetResponse = await fetch(link.href, { credentials: "include" });
            return {
              contentType: assetResponse.headers.get("content-type") ?? "",
              pathname: new URL(link.href).pathname,
              rel: link.rel,
              status: assetResponse.status,
              type: link.type,
            };
          }),
        );
      });
      expect(assetResults).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            contentType: expect.stringContaining("image/svg+xml"),
            pathname: `${basePath}/favicon.svg`,
            rel: "icon",
            status: 200,
            type: "image/svg+xml",
          }),
          expect.objectContaining({
            contentType: expect.stringContaining("image/png"),
            pathname: `${basePath}/favicon-32.png`,
            rel: "icon",
            status: 200,
            type: "image/png",
          }),
          expect.objectContaining({
            contentType: expect.stringContaining("image/png"),
            pathname: `${basePath}/apple-touch-icon.png`,
            rel: "apple-touch-icon",
            status: 200,
          }),
          expect.objectContaining({
            contentType: expect.stringContaining("application/manifest+json"),
            pathname: `${basePath}/manifest.webmanifest`,
            rel: "manifest",
            status: 200,
          }),
        ]),
      );
      expect(proxy.requests).toEqual(
        expect.arrayContaining([
          `${basePath}/chat`,
          `${basePath}/favicon.svg`,
          `${basePath}/favicon-32.png`,
          `${basePath}/apple-touch-icon.png`,
          `${basePath}/manifest.webmanifest`,
        ]),
      );
      const unprefixedPublicAssetRequests = proxy.requests.filter((requestPath) =>
        publicAssetPaths.has(requestPath),
      );
      expect(unprefixedPublicAssetRequests).toEqual([]);

      await writeFile(
        path.join(artifactDir, "connected-shell.png"),
        await takeControlUiViewportScreenshot(page, page.locator(".shell"), [
          page.locator(".chat-main"),
        ]),
      );
      await writeFile(
        path.join(artifactDir, "behavior-summary.json"),
        `${JSON.stringify(
          {
            basePath,
            finalPathname: new URL(page.url()).pathname,
            gatewayUrl: explicitGatewayUrl,
            publicAssetLinks: assetResults,
            proxyRequestPaths: [
              ...new Set(
                proxy.requests.filter((requestPath) => requestPath.startsWith(`${basePath}/`)),
              ),
            ].toSorted(),
            schemaVersion: 1,
            unprefixedPublicAssetRequests,
          },
          null,
          2,
        )}\n`,
      );
    } finally {
      await context.close();
    }
  });
});
