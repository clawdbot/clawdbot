// Control UI tests prove real PWA manifest loading through an HTTP Basic Auth proxy.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, it } from "vitest";
import {
  createChatFlowE2eSuite,
  installMockGateway,
  requireString,
} from "./chat-flow.test-support.ts";

type ManifestRequest = {
  authorized: boolean;
  status: 200 | 401;
};

type AuthenticatedProxy = {
  baseUrl: string;
  close: () => Promise<void>;
  manifestRequests: ManifestRequest[];
};

const httpCredentials = {
  password: "pwa-e2e-test-password",
  username: "pwa-e2e-test-user",
};
const unforwardedHeaders = new Set([
  "cache-control",
  "connection",
  "content-encoding",
  "content-length",
]);

async function startAuthenticatedProxy(upstreamBaseUrl: string): Promise<AuthenticatedProxy> {
  const manifestRequests: ManifestRequest[] = [];
  const expectedAuthorization = `Basic ${Buffer.from(
    `${httpCredentials.username}:${httpCredentials.password}`,
  ).toString("base64")}`;

  const server = createServer((request, response) => {
    void forwardAuthenticatedRequest({
      expectedAuthorization,
      manifestRequests,
      request,
      response,
      upstreamBaseUrl,
    }).catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "Cache-Control": "no-store" });
      }
      response.end();
    });
  });

  await listenOnLoopback(server);
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("HTTP Basic Auth proof proxy did not expose a loopback port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    manifestRequests,
  };
}

async function listenOnLoopback(server: Server): Promise<AddressInfo> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("HTTP Basic Auth proof proxy did not expose a loopback port"));
        return;
      }
      resolve(address);
    });
  });
}

async function forwardAuthenticatedRequest(params: {
  expectedAuthorization: string;
  manifestRequests: ManifestRequest[];
  request: IncomingMessage;
  response: ServerResponse;
  upstreamBaseUrl: string;
}): Promise<void> {
  const { expectedAuthorization, manifestRequests, request, response, upstreamBaseUrl } = params;
  const requestUrl = new URL(request.url ?? "/", upstreamBaseUrl);
  const authorized = request.headers.authorization === expectedAuthorization;

  if (requestUrl.pathname === "/manifest.webmanifest") {
    manifestRequests.push({ authorized, status: authorized ? 200 : 401 });
  }

  response.setHeader("Cache-Control", "no-store");
  if (!authorized) {
    response.writeHead(401, { "WWW-Authenticate": 'Basic realm="OpenClaw PWA E2E"' });
    response.end("HTTP Basic authentication required");
    return;
  }

  const upstream = await fetch(requestUrl, {
    headers: { Accept: request.headers.accept ?? "*/*" },
    method: request.method,
  });
  response.statusCode = upstream.status;
  for (const [name, value] of upstream.headers) {
    if (!unforwardedHeaders.has(name)) {
      response.setHeader(name, value);
    }
  }
  response.end(request.method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer()));
}

const suite = createChatFlowE2eSuite();

suite.define(() => {
  it("loads the installable same-origin PWA manifest through an HTTP Basic Auth proxy", async () => {
    const proxy = await startAuthenticatedProxy(suite.server.baseUrl);
    const context = await suite.newBrowserContext({
      httpCredentials: { ...httpCredentials, origin: new URL(proxy.baseUrl).origin },
      serviceWorkers: "block",
    });

    try {
      const unauthenticated = await fetch(new URL("manifest.webmanifest", proxy.baseUrl));
      expect(unauthenticated.status).toBe(401);
      expect(unauthenticated.headers.get("www-authenticate")).toContain("Basic");
      proxy.manifestRequests.length = 0;

      const page = await context.newPage();
      await installMockGateway(page);
      const response = await page.goto(proxy.baseUrl, { waitUntil: "domcontentloaded" });
      expect(response?.status()).toBe(200);

      // CDP uses Chromium's PWA manifest loader; page.fetch cannot prove link credentials.
      const session = await context.newCDPSession(page);
      const manifest = await session.send("Page.getAppManifest");
      const buildId = requireString(
        await page.locator("html").getAttribute("data-openclaw-control-ui-build-id"),
        "bundled public asset build id",
      );
      const manifestUrl = new URL("manifest.webmanifest", proxy.baseUrl);
      manifestUrl.searchParams.set("v", buildId);

      expect(proxy.manifestRequests.length).toBeGreaterThan(0);
      expect(proxy.manifestRequests.filter((request) => !request.authorized)).toEqual([]);
      expect(proxy.manifestRequests.every((request) => request.status === 200)).toBe(true);
      expect(manifest.url).toBe(manifestUrl.href);
      expect(manifest.errors).toEqual([]);
      expect(JSON.parse(manifest.data ?? "null")).toEqual(
        expect.objectContaining({ display: "standalone", name: "OpenClaw Control" }),
      );
      expect(
        await page.locator('link[rel="manifest"]').evaluate((link) => ({
          crossOrigin: (link as HTMLLinkElement).crossOrigin,
          href: (link as HTMLLinkElement).href,
        })),
      ).toEqual({
        crossOrigin: "use-credentials",
        href: manifestUrl.href,
      });
    } finally {
      await suite.closeBrowserContext(context);
      await proxy.close();
    }
  });
});
