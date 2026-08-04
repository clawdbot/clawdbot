// Control UI tests prove trusted-proxy and browser-origin auth through real transports.
import { mkdir, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import net from "node:net";
import path from "node:path";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { ConnectErrorDetailCodes } from "../../../packages/gateway-protocol/src/connect-error-details.js";
import type { GatewayServer } from "../../../src/gateway/server.js";
import { waitForActiveGatewayRootWork } from "../../../src/process/gateway-work-admission.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.js";
import {
  canRunPlaywrightChromium,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const artifactDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() ||
    ".artifacts/control-ui-e2e/control-ui-auth-transports",
);
const viewport = { height: 900, width: 1280 };
const trustedProxyUser = "qa-operator";
const controlUiSettleTimeoutMs = 60_000;
const originProxyHeaderBlocklist = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "transfer-encoding",
]);

type ProxyRoute = "trusted" | "untrusted";

type BrowserConnectEvidence = {
  authFields: string[];
  clientId: string | null;
  clientMode: string | null;
  hasDevice: boolean;
  scopes: string[];
};

type GatewayResultEvidence = {
  errorCode: string | null;
  errorReason: string | null;
  helloType: string | null;
  message: string | null;
  ok: boolean;
};

type ProxyConnectionEvidence = {
  browserConnect?: BrowserConnectEvidence;
  browserOrigin: string | null;
  gatewayResult?: GatewayResultEvidence;
  identityInjected: boolean;
  requiredHeaderInjected: boolean;
  route: ProxyRoute;
  upstreamHandshakeStatus?: number;
};

type RealTransportProxy = {
  close: () => Promise<void>;
  evidence: ProxyConnectionEvidence[];
  port: number;
  trustedUrl: string;
  untrustedUrl: string;
};

type RealGateway = {
  cleanup: () => Promise<void>;
  port: number;
  server: GatewayServer;
  state: OpenClawTestState;
  url: string;
};

let browser: Browser;
let allowedUi: ControlUiE2eServer;
let rejectedUi: ControlUiE2eServer;
let gateway: RealGateway;
let proxy: RealTransportProxy;
const openContexts = new Set<BrowserContext>();

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function parseJsonFrame(data: RawData): Record<string, unknown> | null {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : data.toString("utf8");
    return asRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function captureBrowserConnect(
  evidence: ProxyConnectionEvidence,
  frame: Record<string, unknown>,
): string | null {
  if (frame.type !== "req" || frame.method !== "connect") {
    return null;
  }
  const params = asRecord(frame.params);
  const client = asRecord(params?.client);
  const auth = asRecord(params?.auth);
  evidence.browserConnect = {
    authFields: auth ? Object.keys(auth).toSorted() : [],
    clientId: stringValue(client?.id),
    clientMode: stringValue(client?.mode),
    hasDevice: asRecord(params?.device) !== null,
    scopes: stringArray(params?.scopes).toSorted(),
  };
  return stringValue(frame.id);
}

function captureGatewayResult(
  evidence: ProxyConnectionEvidence,
  frame: Record<string, unknown>,
  connectRequestId: string | null,
): void {
  if (frame.type !== "res" || stringValue(frame.id) !== connectRequestId) {
    return;
  }
  const error = asRecord(frame.error);
  const details = asRecord(error?.details);
  const payload = asRecord(frame.payload);
  evidence.gatewayResult = {
    errorCode: stringValue(details?.code) ?? stringValue(error?.code),
    errorReason: stringValue(details?.authReason) ?? stringValue(details?.reason),
    helloType: stringValue(payload?.type),
    message: stringValue(error?.message),
    ok: frame.ok === true,
  };
}

function sanitizeProxyEvidence(evidence: ProxyConnectionEvidence) {
  return {
    browserConnect: evidence.browserConnect,
    browserOriginPresent: Boolean(evidence.browserOrigin),
    gatewayResult: evidence.gatewayResult,
    identityInjected: evidence.identityInjected,
    requiredHeaderInjected: evidence.requiredHeaderInjected,
    route: evidence.route,
    upstreamHandshakeStatus: evidence.upstreamHandshakeStatus,
  };
}

function startProxyConnection(
  request: IncomingMessage,
  browserSocket: WebSocket,
  gatewayUrl: string,
  evidence: ProxyConnectionEvidence,
  activeSockets: Set<WebSocket>,
): void {
  const headers =
    evidence.route === "trusted"
      ? {
          "x-forwarded-for": "192.0.2.10",
          "x-forwarded-proto": "http",
          "x-forwarded-user": trustedProxyUser,
        }
      : {};
  const upstream = new WebSocket(gatewayUrl, {
    headers,
    origin: evidence.browserOrigin ?? undefined,
  });
  activeSockets.add(browserSocket);
  activeSockets.add(upstream);
  const pendingBrowserFrames: Array<{ data: RawData; isBinary: boolean }> = [];
  let connectRequestId: string | null = null;

  browserSocket.on("message", (data, isBinary) => {
    const frame = parseJsonFrame(data);
    if (frame) {
      connectRequestId = captureBrowserConnect(evidence, frame) ?? connectRequestId;
    }
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.send(data, { binary: isBinary });
      return;
    }
    pendingBrowserFrames.push({ data, isBinary });
  });
  upstream.on("open", () => {
    for (const frame of pendingBrowserFrames.splice(0)) {
      upstream.send(frame.data, { binary: frame.isBinary });
    }
  });
  upstream.on("message", (data, isBinary) => {
    const frame = parseJsonFrame(data);
    if (frame) {
      captureGatewayResult(evidence, frame, connectRequestId);
    }
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.send(data, { binary: isBinary });
    }
  });
  upstream.on("unexpected-response", (_upstreamRequest, response) => {
    evidence.upstreamHandshakeStatus = response.statusCode;
    const body: Buffer[] = [];
    response.on("data", (chunk) => body.push(Buffer.from(chunk)));
    response.on("end", () => {
      const reason = Buffer.concat(body).toString("utf8").trim() || "gateway rejected websocket";
      if (browserSocket.readyState === WebSocket.OPEN) {
        browserSocket.close(1008, reason.slice(0, 120));
      }
    });
  });
  upstream.on("close", (code, reason) => {
    activeSockets.delete(upstream);
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.close(code, reason.toString().slice(0, 120));
    }
  });
  upstream.on("error", () => {
    if (browserSocket.readyState === WebSocket.OPEN) {
      browserSocket.close(1011, "gateway transport error");
    }
  });
  browserSocket.on("close", () => {
    activeSockets.delete(browserSocket);
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) {
      upstream.close();
    }
  });
  browserSocket.on("error", () => {
    if (upstream.readyState === WebSocket.OPEN) {
      upstream.close();
    }
  });

  request.socket.once("error", () => {
    browserSocket.terminate();
    upstream.terminate();
  });
}

async function startRealTransportProxy(gatewayUrl: string): Promise<RealTransportProxy> {
  const evidence: ProxyConnectionEvidence[] = [];
  const activeSockets = new Set<WebSocket>();
  const websocketServer = new WebSocketServer({ noServer: true });
  const server = createServer((_request, response) => {
    response.writeHead(404).end();
  });

  server.on("upgrade", (request, socket, head) => {
    const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
    const route =
      pathname === "/trusted" ? "trusted" : pathname === "/untrusted" ? "untrusted" : null;
    if (!route) {
      socket.destroy();
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      const connectionEvidence: ProxyConnectionEvidence = {
        browserOrigin: stringValue(request.headers.origin),
        identityInjected: route === "trusted",
        requiredHeaderInjected: route === "trusted",
        route,
      };
      evidence.push(connectionEvidence);
      startProxyConnection(request, browserSocket, gatewayUrl, connectionEvidence, activeSockets);
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("real-transport proxy did not bind a TCP port");
  }
  const baseUrl = `ws://localhost:${address.port}`;
  return {
    close: async () => {
      for (const socket of activeSockets) {
        socket.terminate();
      }
      activeSockets.clear();
      await new Promise<void>((resolve, reject) => {
        websocketServer.close(() => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
    evidence,
    port: address.port,
    trustedUrl: `${baseUrl}/trusted`,
    untrustedUrl: `${baseUrl}/untrusted`,
  };
}

async function startControlUiOriginProxy(upstreamBaseUrl: string): Promise<ControlUiE2eServer> {
  const server = createServer((request, response) => {
    void (async () => {
      const upstream = await fetch(new URL(request.url ?? "/", upstreamBaseUrl), {
        headers: { Accept: request.headers.accept ?? "*/*" },
        method: request.method,
        redirect: "manual",
      });
      response.statusCode = upstream.status;
      for (const [name, value] of upstream.headers) {
        if (!originProxyHeaderBlocklist.has(name)) {
          response.setHeader(name, value);
        }
      }
      response.end(
        request.method === "HEAD" ? undefined : Buffer.from(await upstream.arrayBuffer()),
      );
    })().catch(() => {
      if (!response.headersSent) {
        response.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
      }
      response.end("Control UI origin proxy failed");
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Control UI origin proxy did not bind a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a Gateway port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function startRealGateway(allowedOrigin: string): Promise<RealGateway> {
  const port = await getFreePort();
  const state = await createOpenClawTestState({
    label: "control-ui-auth-transports",
    layout: "home",
    env: {
      OPENCLAW_GATEWAY_PASSWORD: undefined,
      OPENCLAW_GATEWAY_TOKEN: undefined,
      OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
      OPENCLAW_SKIP_CANVAS_HOST: "1",
      OPENCLAW_SKIP_CHANNELS: "1",
      OPENCLAW_SKIP_CRON: "1",
      OPENCLAW_SKIP_GMAIL_WATCHER: "1",
      OPENCLAW_SKIP_PROVIDERS: "1",
      OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      VITEST: "1",
    },
  });
  const trustedProxy = {
    allowLoopback: true,
    allowUsers: [trustedProxyUser],
    deviceAutoApprove: {
      enabled: true,
      scopes: ["operator.approvals", "operator.questions", "operator.read", "operator.write"],
    },
    requiredHeaders: ["x-forwarded-proto"],
    userHeader: "x-forwarded-user",
  };
  await state.writeConfig({
    gateway: {
      auth: {
        mode: "trusted-proxy",
        trustedProxy,
      },
      controlUi: {
        allowedOrigins: [allowedOrigin],
        enabled: false,
      },
      port,
      trustedProxies: ["127.0.0.1", "::1"],
    },
  });
  state.applyEnv();
  try {
    const { startGatewayServer } = await import("../../../src/gateway/server.js");
    const server = await startGatewayServer(port, {
      auth: {
        mode: "trusted-proxy",
        trustedProxy,
      },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    return {
      cleanup: async () => {
        await server.close({ reason: "control ui auth transports test cleanup" });
        await state.cleanup();
      },
      port,
      server,
      state,
      url: `ws://127.0.0.1:${port}`,
    };
  } catch (error) {
    await state.cleanup();
    throw error;
  }
}

function withGatewayUrl(baseUrl: string, gatewayUrl: string): string {
  const url = new URL("settings/connection", baseUrl);
  url.searchParams.set("gatewayUrl", gatewayUrl);
  return url.toString();
}

async function createBrowserPage(
  baseUrl: string,
  gatewayUrl: string,
): Promise<{
  context: BrowserContext;
  evidenceStartIndex: number;
  errors: string[];
  page: Page;
}> {
  await mkdir(artifactDir, { recursive: true });
  const context = await browser.newContext({
    locale: "en-US",
    recordVideo: captureUiProofEnabled ? { dir: artifactDir, size: viewport } : undefined,
    serviceWorkers: "block",
    viewport,
  });
  openContexts.add(context);
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(String(error)));
  page.setDefaultTimeout(15_000);
  const evidenceStartIndex = proxy.evidence.length;
  const response = await page.goto(withGatewayUrl(baseUrl, gatewayUrl), {
    timeout: controlUiSettleTimeoutMs,
    waitUntil: "domcontentloaded",
  });
  expect(response?.status()).toBe(200);
  // Source-served UI startup shares CI shard CPU. Bound navigation and the
  // first rendered interaction separately; transport assertions stay narrow.
  const confirmation = page.locator("openclaw-gateway-url-confirmation");
  await confirmation.waitFor({ timeout: controlUiSettleTimeoutMs });
  expect(await confirmation.textContent()).toContain(gatewayUrl);
  expect(proxy.evidence).toHaveLength(evidenceStartIndex);
  await confirmation
    .getByRole("button", { name: "Confirm", exact: true })
    .click({ timeout: controlUiSettleTimeoutMs });
  await expect
    .poll(() => proxy.evidence.length, { timeout: 15_000 })
    .toBeGreaterThan(evidenceStartIndex);
  return { context, errors, evidenceStartIndex, page };
}

async function closeContext(context: BrowserContext): Promise<void> {
  openContexts.delete(context);
  await context.close();
}

async function closeConnectedContext(context: BrowserContext): Promise<void> {
  await closeContext(context);
  // UI requests intentionally outlive socket teardown. Drain their admitted work
  // before another browser interaction so lazy handler imports cannot starve it.
  await expect(waitForActiveGatewayRootWork()).resolves.toEqual({ active: 0, drained: true });
}

async function captureChromiumScreenshot(page: Page, fileName: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  const session = await page.context().newCDPSession(page);
  try {
    // The live dashboard keeps rendering while RPCs settle. Capture the current
    // Chromium surface directly so proof does not wait on unrelated UI activity.
    const result = await session.send("Page.captureScreenshot", {
      captureBeyondViewport: false,
      format: "png",
      fromSurface: true,
    });
    await writeFile(path.join(artifactDir, fileName), Buffer.from(result.data, "base64"));
  } finally {
    await session.detach();
  }
}

async function waitForConnectionEvidence(
  predicate: (entry: ProxyConnectionEvidence) => boolean,
  evidenceStartIndex: number,
): Promise<ProxyConnectionEvidence> {
  const currentPageEvidence = () => proxy.evidence.slice(evidenceStartIndex);
  await expect.poll(() => currentPageEvidence().some(predicate), { timeout: 15_000 }).toBe(true);
  const entry = currentPageEvidence().find(predicate);
  if (!entry) {
    throw new Error("expected reverse-proxy connection evidence");
  }
  return entry;
}

async function waitForVisibleFailure(page: Page, expectedText: string): Promise<string> {
  const failure = page.locator(".login-gate__failure");
  await failure.waitFor();
  expect(await failure.getAttribute("role")).toBe("alert");
  const raw = (await failure.locator(".login-gate__failure-raw").textContent()) ?? "";
  expect(raw.toLowerCase()).toContain(expectedText.toLowerCase());
  expect(await failure.locator(".login-gate__failure-steps").isVisible()).toBe(true);
  expect(await page.locator("openclaw-app-shell").count()).toBe(0);
  return raw;
}

async function isPortClosed(host: string, port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host, port });
    const finish = (closed: boolean) => {
      socket.destroy();
      resolve(closed);
    };
    socket.once("connect", () => finish(false));
    socket.once("error", () => finish(true));
    socket.setTimeout(1_000, () => finish(true));
  });
}

describeControlUiE2e("Control UI real auth transports E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(
        `Playwright Chromium is not installed or cannot start at ${chromiumExecutablePath}.`,
      );
    }
    await mkdir(artifactDir, { recursive: true });
    allowedUi = await startControlUiE2eServer();
    // A lightweight proxy supplies the distinct rejected Origin without starting
    // a second Vite compiler in the already resource-intensive browser shard.
    rejectedUi = await startControlUiOriginProxy(allowedUi.baseUrl);
    gateway = await startRealGateway(new URL(allowedUi.baseUrl).origin);
    proxy = await startRealTransportProxy(gateway.url);
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  }, 120_000);

  afterAll(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
    const cleanupResults = await Promise.allSettled([
      browser?.close(),
      proxy?.close(),
      gateway?.cleanup(),
      allowedUi?.close(),
      rejectedUi?.close(),
    ]);
    expect(
      cleanupResults
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason)),
    ).toEqual([]);

    const cleanup = {
      gatewayPortClosed: gateway ? await isPortClosed("127.0.0.1", gateway.port) : true,
      proxyPortClosed: proxy ? await isPortClosed("127.0.0.1", proxy.port) : true,
    };
    await writeFile(
      path.join(artifactDir, "cleanup-summary.json"),
      `${JSON.stringify(cleanup, null, 2)}\n`,
      "utf8",
    );
    expect(cleanup).toEqual({
      gatewayPortClosed: true,
      proxyPortClosed: true,
    });
  }, 30_000);

  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("connects through the trusted path and rejects the untrusted proxy path", async () => {
    // A connected shell starts bootstrap RPCs that can outlive context teardown.
    // Keep it last so those requests cannot starve the next browser interaction.
    const rejected = await createBrowserPage(allowedUi.baseUrl, proxy.untrustedUrl);
    const expectedReason = "trusted_proxy_missing_header_x-forwarded-proto";
    await waitForVisibleFailure(rejected.page, "unauthorized");
    const untrustedEvidence = await waitForConnectionEvidence(
      (entry) => entry.route === "untrusted" && entry.gatewayResult?.ok === false,
      rejected.evidenceStartIndex,
    );
    expect(untrustedEvidence.gatewayResult?.message).toContain("unauthorized");
    expect(untrustedEvidence.gatewayResult?.errorReason).toBe(expectedReason);
    expect(untrustedEvidence.identityInjected).toBe(false);
    expect(untrustedEvidence.requiredHeaderInjected).toBe(false);
    await captureChromiumScreenshot(rejected.page, "02-untrusted-proxy-rejected.png");
    expect(rejected.errors).toEqual([]);
    await closeContext(rejected.context);

    const connected = await createBrowserPage(allowedUi.baseUrl, proxy.trustedUrl);
    await connected.page
      .locator("openclaw-app-shell")
      .waitFor({ timeout: controlUiSettleTimeoutMs });
    const trustedEvidence = await waitForConnectionEvidence(
      (entry) =>
        entry.route === "trusted" &&
        entry.gatewayResult?.ok === true &&
        entry.gatewayResult.helloType === "hello-ok",
      connected.evidenceStartIndex,
    );
    expect(trustedEvidence.browserConnect).toMatchObject({
      authFields: [],
      clientId: "openclaw-control-ui",
      clientMode: "webchat",
      hasDevice: true,
    });
    expect(trustedEvidence.identityInjected).toBe(true);
    expect(trustedEvidence.requiredHeaderInjected).toBe(true);
    await captureChromiumScreenshot(connected.page, "01-trusted-proxy-connected.png");
    expect(connected.errors).toEqual([]);
    await closeConnectedContext(connected.context);

    await writeFile(
      path.join(artifactDir, "trusted-proxy-behavior.json"),
      `${JSON.stringify(
        {
          connected: sanitizeProxyEvidence(trustedEvidence),
          rejected: sanitizeProxyEvidence(untrustedEvidence),
          visibleOutcomes: {
            connectedShell: true,
            rejectedRecovery: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });

  it("confirms gatewayUrl, accepts the allowed origin, and rejects an unlisted origin", async () => {
    const rejected = await createBrowserPage(rejectedUi.baseUrl, proxy.trustedUrl);
    await waitForVisibleFailure(rejected.page, "origin not allowed");
    const rejectedOrigin = new URL(rejectedUi.baseUrl).origin;
    const rejectedEvidence = await waitForConnectionEvidence(
      (entry) =>
        entry.route === "trusted" &&
        entry.browserOrigin === rejectedOrigin &&
        (entry.gatewayResult?.errorCode === ConnectErrorDetailCodes.CONTROL_UI_ORIGIN_NOT_ALLOWED ||
          entry.upstreamHandshakeStatus === 403),
      rejected.evidenceStartIndex,
    );
    await captureChromiumScreenshot(rejected.page, "04-rejected-origin-recovery.png");
    expect(rejected.errors).toEqual([]);
    await closeContext(rejected.context);

    const allowed = await createBrowserPage(allowedUi.baseUrl, proxy.trustedUrl);
    await allowed.page.locator("openclaw-app-shell").waitFor({ timeout: controlUiSettleTimeoutMs });
    const allowedOrigin = new URL(allowedUi.baseUrl).origin;
    const allowedEvidence = await waitForConnectionEvidence(
      (entry) =>
        entry.route === "trusted" &&
        entry.browserOrigin === allowedOrigin &&
        entry.gatewayResult?.ok === true,
      allowed.evidenceStartIndex,
    );
    await captureChromiumScreenshot(allowed.page, "03-allowed-origin-connected.png");
    expect(allowed.errors).toEqual([]);
    await closeConnectedContext(allowed.context);

    await writeFile(
      path.join(artifactDir, "allowed-origins-behavior.json"),
      `${JSON.stringify(
        {
          allowed: sanitizeProxyEvidence(allowedEvidence),
          rejected: sanitizeProxyEvidence(rejectedEvidence),
          visibleOutcomes: {
            explicitGatewayUrlConfirmed: true,
            allowedOriginConnected: true,
            rejectedOriginRecovery: true,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  });
});
