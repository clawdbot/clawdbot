// Browser tests cover pw ai plugin behavior.
import { once } from "node:events";
import { createServer } from "node:http";
import type { Browser, ConnectOverCDPTransport } from "playwright-core";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";

const { connectOverCdpMock } = vi.hoisted(() => ({
  connectOverCdpMock: vi.fn<(transport: ConnectOverCDPTransport) => Promise<Browser>>(),
}));

vi.mock("./playwright-core.runtime.js", () => ({
  getPlaywrightUserAgent: () => "Playwright/test",
  getPlaywrightCore: () => ({
    chromium: { connectOverCDP: connectOverCdpMock },
    devices: {},
  }),
}));

let cdpUrl: string;
const discoveryRequests = vi.fn();
const server = createServer((request, response) => {
  discoveryRequests(request.url);
  if (request.url !== "/json/version") {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(
    JSON.stringify({
      webSocketDebuggerUrl: `${cdpUrl.replace("http:", "ws:")}/devtools/browser/test`,
    }),
  );
});
const socketServer = new WebSocketServer({ server, path: "/devtools/browser/test" });
const socketConnections = vi.fn();
socketServer.on("connection", socketConnections);

type FakeSession = {
  send: ReturnType<typeof vi.fn>;
  detach: ReturnType<typeof vi.fn>;
};

function createPage(opts: { targetId: string; snapshotFull?: string; hasAriaSnapshot?: boolean }) {
  const session: FakeSession = {
    send: vi.fn().mockResolvedValue({
      targetInfo: { targetId: opts.targetId },
    }),
    detach: vi.fn().mockResolvedValue(undefined),
  };

  const context = {
    newCDPSession: vi.fn().mockResolvedValue(session),
  };

  const click = vi.fn().mockResolvedValue(undefined);
  const dblclick = vi.fn().mockResolvedValue(undefined);
  const fill = vi.fn().mockResolvedValue(undefined);
  const locator = vi.fn().mockReturnValue({ click, dblclick, fill });

  const page = {
    context: () => context,
    locator,
    on: vi.fn(),
    off: vi.fn(),
    url: vi.fn(() => `https://example.test/${opts.targetId}`),
    ...(opts.hasAriaSnapshot === false
      ? {}
      : {
          ariaSnapshot: vi.fn().mockResolvedValue(opts.snapshotFull ?? "SNAP"),
        }),
  };

  return { page, session, locator, click, fill };
}

function createBrowser(pages: unknown[]) {
  const ctx = {
    pages: () => pages,
    on: vi.fn(),
  };
  const close = vi.fn<Browser["close"]>();
  const browser = {
    contexts: () => [ctx],
    on: vi.fn(),
    close,
  } as unknown as Browser;
  connectOverCdpMock.mockImplementation(async (transport) => {
    const closed = new Promise<void>((resolve) => {
      // oxlint-disable-next-line unicorn/prefer-add-event-listener -- Playwright's transport owns this callback.
      transport.onclose = () => resolve();
    });
    close.mockImplementation(async () => {
      transport.close();
      await closed;
    });
    return browser;
  });
}

let snapshotAiViaPlaywright: typeof import("./pw-tools-core.snapshot.js").snapshotAiViaPlaywright;
let clickViaPlaywright: typeof import("./pw-tools-core.interactions.js").clickViaPlaywright;
let closePlaywrightBrowserConnection: typeof import("./pw-session.js").closePlaywrightBrowserConnection;

beforeAll(async () => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cdpUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  ({ snapshotAiViaPlaywright } = await import("./pw-tools-core.snapshot.js"));
  ({ clickViaPlaywright } = await import("./pw-tools-core.interactions.js"));
  ({ closePlaywrightBrowserConnection } = await import("./pw-session.js"));
});

afterEach(async () => {
  const socketClosures = [...socketServer.clients].map((socket) => once(socket, "close"));
  await closePlaywrightBrowserConnection();
  await Promise.all(socketClosures);
  expect(socketServer.clients.size).toBe(0);
  vi.clearAllMocks();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    socketServer.close((error) => (error ? reject(error) : resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

describe("pw-ai", () => {
  it("captures an ai snapshot via Playwright for a specific target", async () => {
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    const p2 = createPage({ targetId: "T2", snapshotFull: "TWO" });
    createBrowser([p1.page, p2.page]);

    const res = await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T2",
    });

    expect(res.snapshot).toBe("TWO");
    expect(p1.session.detach).toHaveBeenCalled();
    expect(p2.session.detach).toHaveBeenCalled();
    expect(p2.page.off).toHaveBeenCalledWith("framenavigated", expect.any(Function));
    expect(p2.page.off).toHaveBeenCalledWith("framedetached", expect.any(Function));
  });

  it("registers aria refs from ai snapshots for act commands", async () => {
    const snapshot = ['- button "OK" [ref=e1]', '- link "Docs" [ref=e2]'].join("\n");
    const p1 = createPage({ targetId: "T1", snapshotFull: snapshot });
    createBrowser([p1.page]);

    const res = await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T1",
    });

    expect(res.refs.e1).toEqual({ role: "button", name: "OK" });
    expect(res.refs.e2).toEqual({ role: "link", name: "Docs" });

    await clickViaPlaywright({
      cdpUrl,
      targetId: "T1",
      ref: "e1",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=e1");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("truncates oversized snapshots", async () => {
    const firstLine = "VISIBLE";
    const marker = "[...TRUNCATED - page too large]";
    const longSnapshot = `${firstLine}\n${"A".repeat(50)}`;
    const p1 = createPage({ targetId: "T1", snapshotFull: longSnapshot });
    createBrowser([p1.page]);

    const res = await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T1",
      maxChars: firstLine.length + 2 + marker.length,
    });

    expect(res.truncated).toBe(true);
    expect(res.snapshot).toBe(`${firstLine}\n\n${marker}`);
  });

  it("returns numeric ai snapshot refs in the public snapshot output", async () => {
    const snapshot = ['- button "OK" [ref=1]', '- link "Docs" [ref=2]'].join("\n");
    const p1 = createPage({ targetId: "T1", snapshotFull: snapshot });
    createBrowser([p1.page]);

    const res = await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T1",
    });

    expect(res.snapshot).toContain("[ref=1]");
    expect(res.snapshot).toContain("[ref=2]");
    expect(res.refs["1"]).toEqual({ role: "button", name: "OK" });
    expect(res.refs["2"]).toEqual({ role: "link", name: "Docs" });

    await clickViaPlaywright({
      cdpUrl,
      targetId: "T1",
      ref: "1",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=1");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("clicks a ref using aria-ref locator", async () => {
    const p1 = createPage({ targetId: "T1" });
    createBrowser([p1.page]);

    await clickViaPlaywright({
      cdpUrl,
      targetId: "T1",
      ref: "76",
    });

    expect(p1.locator).toHaveBeenCalledWith("aria-ref=76");
    expect(p1.click).toHaveBeenCalledTimes(1);
  });

  it("uses Playwright's public AI aria snapshot API", async () => {
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    createBrowser([p1.page]);

    await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T1",
      timeoutMs: 1234,
    });

    expect("ariaSnapshot" in p1.page ? p1.page.ariaSnapshot : undefined).toHaveBeenCalledWith({
      mode: "ai",
      timeout: 1234,
    });
  });

  it("reuses the CDP connection for repeated calls", async () => {
    const p1 = createPage({ targetId: "T1", snapshotFull: "ONE" });
    createBrowser([p1.page]);

    await snapshotAiViaPlaywright({
      cdpUrl,
      targetId: "T1",
    });
    await clickViaPlaywright({
      cdpUrl,
      targetId: "T1",
      ref: "1",
    });

    expect(connectOverCdpMock).toHaveBeenCalledTimes(1);
    expect(discoveryRequests).toHaveBeenCalledExactlyOnceWith("/json/version");
    expect(socketConnections).toHaveBeenCalledTimes(1);
    expect(socketServer.clients.size).toBe(1);
  });
});
