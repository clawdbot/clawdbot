import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  chromium,
  type BrowserContext,
  type CDPSession,
  type Page,
  type Worker,
} from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { useAutoCleanupTempDirTracker } from "../test-support.js";

declare const chrome: {
  runtime: {
    sendMessage(message: Record<string, unknown>): Promise<unknown>;
    getContexts(filter: { contextTypes: string[] }): Promise<
      Array<{
        contextType: string;
        documentId?: string;
        documentUrl: string;
        tabId: number;
      }>
    >;
  };
  sidePanel: {
    setOptions(options: { tabId: number; enabled: boolean }): Promise<void>;
  };
  tabs: {
    getCurrent(): Promise<{ id?: number }>;
    ungroup(tabIds: number[]): Promise<void>;
  };
};

const runE2E = process.env.OPENCLAW_BROWSER_COPILOT_E2E === "1";
const extensionDir = path.dirname(fileURLToPath(import.meta.url));

type RequestFrame = {
  id: string;
  method: string;
  params?: Record<string, unknown>;
  type: "req";
};

type GatewayHarness = {
  archived: Set<string>;
  chatSends: Array<Record<string, unknown>>;
  connectParams: Array<Record<string, unknown>>;
  histories: Map<string, Array<Record<string, unknown>>>;
  port: number;
  requests: RequestFrame[];
  close: () => Promise<void>;
  disconnectClients: () => void;
  failNextAbort: () => void;
  holdNextSubscription: () => () => void;
};

type RelayHarness = {
  readonly connectionCount: number;
  hellos: Array<Record<string, unknown>>;
  port: number;
  close: () => Promise<void>;
  setAvailable: (available: boolean) => void;
};

type TargetInfo = { targetId: string; type: string; url: string };

type PanelTarget = {
  allText: (selector: string) => Promise<string[]>;
  click: (selector: string) => Promise<void>;
  disabled: (selector: string) => Promise<boolean>;
  fill: (selector: string, value: string) => Promise<void>;
  hidden: (selector: string) => Promise<boolean>;
  screenshot: (targetPath: string) => Promise<void>;
  text: (selector: string) => Promise<string>;
  wakeBackground: () => Promise<void>;
};

function isSidePanelTarget(target: TargetInfo): boolean {
  try {
    return new URL(target.url).pathname.endsWith("/sidepanel.html");
  } catch {
    return false;
  }
}

function textValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data).toString("utf8");
  }
  return data instanceof ArrayBuffer
    ? Buffer.from(new Uint8Array(data)).toString("utf8")
    : data.toString("utf8");
}

const cleanups: Array<() => Promise<void>> = [];
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) {
    await cleanup().catch(() => undefined);
  }
});

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  return address.port;
}

function sendResponse(socket: WebSocket, id: string, payload: unknown): void {
  socket.send(JSON.stringify({ type: "res", id, ok: true, payload }));
}

function sendError(socket: WebSocket, id: string, message: string): void {
  socket.send(
    JSON.stringify({
      type: "res",
      id,
      ok: false,
      error: { code: "UNAVAILABLE", message, retryable: true },
    }),
  );
}

async function createRelayHarness(): Promise<RelayHarness> {
  const server = createServer();
  const port = await listen(server);
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: 1_000_000,
    handleProtocols: (protocols) => protocols.values().next().value ?? false,
  });
  const hellos: Array<Record<string, unknown>> = [];
  let available = true;
  let connectionCount = 0;
  server.on("upgrade", (request, socket, head) => {
    if (!available) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      wss.emit("connection", client, request);
    });
  });
  wss.on("connection", (socket) => {
    connectionCount += 1;
    socket.on("message", (data) => {
      const message = JSON.parse(rawDataText(data)) as Record<string, unknown>;
      if (message.type === "hello") {
        hellos.push(message);
      }
    });
  });
  return {
    get connectionCount() {
      return connectionCount;
    },
    hellos,
    port,
    setAvailable: (nextAvailable) => {
      available = nextAvailable;
      if (!available) {
        for (const client of wss.clients) {
          client.terminate();
        }
      }
    },
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function createGatewayHarness(): Promise<GatewayHarness> {
  const server = createServer();
  const port = await listen(server);
  const wss = new WebSocketServer({ server });
  const histories = new Map<string, Array<Record<string, unknown>>>();
  const archived = new Set<string>();
  const requests: RequestFrame[] = [];
  const connectParams: Array<Record<string, unknown>> = [];
  const chatSends: Array<Record<string, unknown>> = [];
  let heldSubscription: Promise<void> | null = null;
  let rejectNextAbort = false;

  wss.on("connection", (socket) => {
    socket.send(
      JSON.stringify({
        type: "event",
        event: "connect.challenge",
        payload: { nonce: "browser-copilot-e2e-nonce" },
      }),
    );
    socket.on("message", (data) => {
      const frame = JSON.parse(rawDataText(data)) as RequestFrame;
      requests.push(frame);
      const params = frame.params ?? {};
      if (frame.method === "connect") {
        connectParams.push(params);
        sendResponse(socket, frame.id, {
          type: "hello-ok",
          protocol: PROTOCOL_VERSION,
          server: { version: "e2e", connId: "browser-copilot-e2e" },
          features: { methods: [], events: ["chat"] },
          snapshot: {
            sessionDefaults: {
              defaultAgentId: "main",
              mainKey: "main",
              mainSessionKey: "agent:main:main",
            },
          },
          auth: {
            deviceToken: "test-device-token",
            role: "operator",
            scopes: ["operator.read", "operator.write"],
          },
          policy: {
            maxPayload: 1_000_000,
            maxBufferedBytes: 1_000_000,
            tickIntervalMs: 60_000,
          },
        });
        return;
      }
      const key = textValue(params.key) || textValue(params.sessionKey);
      if (frame.method === "sessions.create") {
        histories.set(key, []);
        sendResponse(socket, frame.id, { ok: true, key, sessionId: `id-${histories.size}` });
        return;
      }
      if (frame.method === "chat.history") {
        sendResponse(socket, frame.id, { messages: histories.get(key) ?? [] });
        return;
      }
      if (frame.method === "sessions.messages.subscribe" && heldSubscription) {
        const pending = heldSubscription;
        heldSubscription = null;
        void pending.then(() => sendResponse(socket, frame.id, { ok: true }));
        return;
      }
      if (frame.method === "chat.send") {
        chatSends.push(params);
        const message = textValue(params.message);
        const history = histories.get(key) ?? [];
        history.push({ role: "user", content: [{ type: "text", text: message }] });
        const runId = textValue(params.idempotencyKey);
        if (message === "ambiguous linger marker") {
          histories.set(key, history);
          socket.terminate();
          return;
        }
        if (message.endsWith("linger marker")) {
          histories.set(key, history);
          sendResponse(socket, frame.id, { runId, status: "started" });
          return;
        }
        const reply = `Isolated reply: ${message}`;
        history.push({ role: "assistant", content: [{ type: "text", text: reply }] });
        histories.set(key, history);
        sendResponse(socket, frame.id, { runId, status: "started" });
        socket.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: { sessionKey: key, runId, state: "delta", deltaText: reply },
          }),
        );
        socket.send(
          JSON.stringify({
            type: "event",
            event: "chat",
            payload: { sessionKey: key, runId, state: "final" },
          }),
        );
        return;
      }
      if (frame.method === "sessions.abort" && rejectNextAbort) {
        rejectNextAbort = false;
        sendError(socket, frame.id, "fixture abort retry");
        return;
      }
      if (frame.method === "sessions.patch" && params.archived === true) {
        archived.add(key);
      }
      sendResponse(socket, frame.id, { ok: true });
    });
  });

  return {
    archived,
    chatSends,
    connectParams,
    histories,
    port,
    requests,
    disconnectClients: () => {
      for (const client of wss.clients) {
        client.terminate();
      }
    },
    failNextAbort: () => {
      rejectNextAbort = true;
    },
    holdNextSubscription: () => {
      let release: () => void = () => void 0;
      heldSubscription = new Promise<void>((resolve) => {
        release = resolve;
      });
      return release;
    },
    close: async () => {
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

async function createFixtureServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer((request, response) => {
    const name = request.url === "/beta" ? "Beta" : "Alpha";
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(
      `<!doctype html><title>Fixture ${name}</title><main><h1>${name} workspace</h1><p>Sanitized local fixture.</p></main>`,
    );
  });
  const port = await listen(server);
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: async () =>
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function copyExtension(): Promise<string> {
  const target = tempDirs.make("openclaw-copilot-extension-");
  await fs.cp(extensionDir, target, {
    recursive: true,
    filter: (source) => !source.endsWith(".test.ts"),
  });
  await fs.writeFile(
    path.join(target, "e2e-launcher.html"),
    '<!doctype html><button id="open">Open tab panel</button><script type="module" src="e2e-launcher.js"></script>',
  );
  await fs.writeFile(
    path.join(target, "e2e-launcher.js"),
    `const tab = await chrome.tabs.getCurrent();
    const panel = await chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: tab.id });
    if (!panel?.ok) throw new Error(panel?.error ?? "panel prepare failed");
    document.body.dataset.ready = "true";
    document.querySelector("#open").addEventListener("click", async () => {
      try {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: panel.path, enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
        document.body.dataset.opened = "true";
      } catch (error) {
        document.body.dataset.error = error instanceof Error ? error.message : String(error);
      }
    });\n`,
  );
  return target;
}

async function resolveChromiumExecutable(): Promise<string | undefined> {
  const override = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
  const candidates = [override, "/usr/bin/chromium-browser", "/usr/bin/chromium"].filter(
    (candidate): candidate is string => Boolean(candidate),
  );
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Continue to Playwright's managed Chromium.
    }
  }
  return undefined;
}

async function waitForServiceWorker(context: BrowserContext): Promise<Worker> {
  return context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
}

async function restartServiceWorker(
  browserCdp: CDPSession,
  worker: Worker,
  panel: PanelTarget,
): Promise<void> {
  const targets = (await browserCdp.send("Target.getTargets")) as {
    targetInfos: TargetInfo[];
  };
  const target = targets.targetInfos.find(
    (candidate) => candidate.type === "service_worker" && candidate.url === worker.url(),
  );
  if (!target) {
    throw new Error("Chromium did not expose the extension service worker target");
  }
  const closed = (await browserCdp.send("Target.closeTarget", {
    targetId: target.targetId,
  })) as { success?: boolean };
  if (closed.success !== true) {
    throw new Error("Chromium did not stop the extension service worker");
  }
  // A real extension message wakes the terminated worker. The panel must then
  // reconnect its long-lived port before it can become ready again.
  await panel.wakeBackground();
}

function createPanelTarget(root: CDPSession, sessionId: string): PanelTarget {
  let commandId = 0;
  const pending = new Map<
    number,
    { reject: (error: Error) => void; resolve: (result: Record<string, unknown>) => void }
  >();
  root.on("Target.receivedMessageFromTarget", (event: { message: string; sessionId: string }) => {
    if (event.sessionId !== sessionId) {
      return;
    }
    const message = JSON.parse(event.message) as {
      error?: { message?: string };
      id?: number;
      result?: Record<string, unknown>;
    };
    if (typeof message.id !== "number") {
      return;
    }
    const waiter = pending.get(message.id);
    if (!waiter) {
      return;
    }
    pending.delete(message.id);
    if (message.error) {
      waiter.reject(new Error(message.error.message ?? "CDP panel command failed"));
    } else {
      waiter.resolve(message.result ?? {});
    }
  });

  async function send(method: string, params: Record<string, unknown> = {}) {
    const id = ++commandId;
    const result = new Promise<Record<string, unknown>>((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    await root.send("Target.sendMessageToTarget", {
      sessionId,
      message: JSON.stringify({ id, method, params }),
    });
    return await result;
  }

  async function evaluate<T>(expression: string): Promise<T> {
    const result = await send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    const exception = result.exceptionDetails as { text?: string } | undefined;
    if (exception) {
      throw new Error(exception.text ?? "side-panel evaluation failed");
    }
    return (result.result as { value?: T } | undefined)?.value as T;
  }

  const selectorExpression = (selector: string) => JSON.stringify(selector);
  return {
    allText: async (selector) =>
      await evaluate<string[]>(
        `[...document.querySelectorAll(${selectorExpression(selector)})].map((node) => node.textContent ?? "")`,
      ),
    click: async (selector) => {
      await evaluate(`document.querySelector(${selectorExpression(selector)})?.click()`);
    },
    disabled: async (selector) =>
      await evaluate<boolean>(
        `Boolean(document.querySelector(${selectorExpression(selector)})?.disabled)`,
      ),
    fill: async (selector, value) => {
      await evaluate(`(() => {
        const input = document.querySelector(${selectorExpression(selector)});
        input.value = ${JSON.stringify(value)};
        input.dispatchEvent(new Event("input", { bubbles: true }));
      })()`);
    },
    hidden: async (selector) =>
      await evaluate<boolean>(
        `document.querySelector(${selectorExpression(selector)})?.classList.contains("hidden") === true`,
      ),
    screenshot: async (targetPath) => {
      await send("Page.enable");
      const result = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
      await fs.writeFile(targetPath, Buffer.from(String(result.data), "base64"));
    },
    text: async (selector) =>
      await evaluate<string>(
        `document.querySelector(${selectorExpression(selector)})?.textContent ?? ""`,
      ),
    wakeBackground: async () => {
      await evaluate(
        `chrome.runtime.sendMessage({ type: "copilot.e2e.wake" }).catch(() => undefined)`,
      );
    },
  };
}

async function openTabPanel(params: {
  browserCdp: CDPSession;
  extensionId: string;
  page: Page;
}): Promise<PanelTarget> {
  const prior = (await params.browserCdp.send("Target.getTargets")) as {
    targetInfos: TargetInfo[];
  };
  const priorTargetIds = new Set(prior.targetInfos.map((target) => target.targetId));
  await params.page.goto(`chrome-extension://${params.extensionId}/e2e-launcher.html`);
  await expect
    .poll(async () => await params.page.locator("body").getAttribute("data-ready"))
    .toBe("true");
  await params.page.locator("#open").click();
  await expect
    .poll(
      async () =>
        await params.page.locator("body").evaluate((body) => ({
          error: body.dataset.error,
          opened: body.dataset.opened,
        })),
      { timeout: 5_000 },
    )
    .toEqual({ error: undefined, opened: "true" });
  await expect
    .poll(
      async () => {
        const targets = (await params.browserCdp.send("Target.getTargets")) as {
          targetInfos: TargetInfo[];
        };
        return targets.targetInfos.find(
          (target) => !priorTargetIds.has(target.targetId) && isSidePanelTarget(target),
        );
      },
      { timeout: 15_000 },
    )
    .toBeTruthy();
  const targets = (await params.browserCdp.send("Target.getTargets")) as {
    targetInfos: TargetInfo[];
  };
  const target = targets.targetInfos.find(
    (candidate) => !priorTargetIds.has(candidate.targetId) && isSidePanelTarget(candidate),
  );
  if (!target) {
    throw new Error("Chrome did not expose the tab-specific side-panel target");
  }
  const attached = (await params.browserCdp.send("Target.attachToTarget", {
    targetId: target.targetId,
    flatten: false,
  })) as { sessionId: string };
  return createPanelTarget(params.browserCdp, attached.sessionId);
}

async function disableTabPanel(worker: Worker, tabId: number): Promise<void> {
  await worker.evaluate(async (boundTabId) => {
    await chrome.sidePanel.setOptions({ tabId: boundTabId, enabled: false });
  }, tabId);
  await expect
    .poll(
      async () =>
        await worker.evaluate(async () => {
          const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
          return contexts.length;
        }),
      { timeout: 10_000 },
    )
    .toBe(0);
}

async function unshareTab(worker: Worker, tabId: number): Promise<void> {
  await worker.evaluate(async (boundTabId) => {
    await chrome.tabs.ungroup([boundTabId]);
  }, tabId);
}

describe.runIf(runE2E)("browser copilot Chromium side panel", () => {
  it("isolates two tab sessions, enforces bindings, denies unshared use, and archives on close", async () => {
    const gateway = await createGatewayHarness();
    cleanups.push(gateway.close);
    const relay = await createRelayHarness();
    cleanups.push(relay.close);
    const fixture = await createFixtureServer();
    cleanups.push(fixture.close);
    const unpackedExtension = await copyExtension();
    const userDataDir = tempDirs.make("openclaw-copilot-profile-");
    const executablePath = await resolveChromiumExecutable();
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: true,
      args: [
        `--disable-extensions-except=${unpackedExtension}`,
        `--load-extension=${unpackedExtension}`,
      ],
    });
    cleanups.push(async () => await context.close());
    const browser = context.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const worker = await waitForServiceWorker(context);
    const extensionId = new URL(worker.url()).hostname;
    const alphaTab = context.pages()[0] ?? (await context.newPage());
    await alphaTab.goto(`chrome-extension://${extensionId}/e2e-launcher.html`);
    await alphaTab.evaluate(
      async ({ gatewayPort, relayPort }) =>
        await chrome.runtime.sendMessage({
          type: "pair",
          pairingString: `ws://127.0.0.1:${relayPort}/extension?gateway=${encodeURIComponent(`ws://127.0.0.1:${gatewayPort}`)}#relay-e2e-token`,
          groupColor: "#ff7020",
        }),
      { gatewayPort: gateway.port, relayPort: relay.port },
    );
    await expect.poll(() => gateway.connectParams.length, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => relay.connectionCount, { timeout: 10_000 }).toBe(1);
    await expect.poll(() => relay.hellos.length, { timeout: 10_000 }).toBe(1);

    const artifactDir =
      process.env.OPENCLAW_BROWSER_COPILOT_ARTIFACT_DIR ??
      path.join(os.tmpdir(), "openclaw-browser-copilot-artifacts");
    await fs.mkdir(artifactDir, { recursive: true });

    const alphaPanel = await openTabPanel({ browserCdp, extensionId, page: alphaTab });
    const alphaContextProof = await alphaTab.evaluate(async () => {
      const tab = await chrome.tabs.getCurrent();
      const contexts = await chrome.runtime.getContexts({ contextTypes: ["SIDE_PANEL"] });
      return {
        currentTabId: tab?.id,
        contexts: contexts.map((panelContext) => ({
          contextType: panelContext.contextType,
          hasDocumentId: Boolean(panelContext.documentId),
          pathname: new URL(panelContext.documentUrl).pathname,
          queryKeys: [...new URL(panelContext.documentUrl).searchParams.keys()],
          tabId: panelContext.tabId,
        })),
      };
    });
    expect(alphaContextProof).toEqual({
      currentTabId: expect.any(Number),
      contexts: [
        {
          contextType: "SIDE_PANEL",
          hasDocumentId: true,
          pathname: "/sidepanel.html",
          queryKeys: ["binding"],
          tabId: -1,
        },
      ],
    });
    await alphaTab.goto(`${fixture.baseUrl}/alpha`);
    await expect
      .poll(
        async () => ({
          detail: await alphaPanel.text("#gate-detail"),
          title: await alphaPanel.text("#gate-title"),
        }),
        { timeout: 10_000 },
      )
      .toEqual({
        detail:
          "Sharing adds this tab to the OpenClaw group. The copilot can act here, but nowhere else.",
        title: "Keep the boundary visible",
      });
    expect(await alphaPanel.disabled("#message-input")).toBe(true);
    await alphaPanel.screenshot(path.join(artifactDir, "before-unshared.png"));
    await alphaPanel.click("#gate-action");
    await expect
      .poll(async () => !(await alphaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);
    await alphaPanel.fill("#message-input", "alpha marker");
    await expect.poll(async () => !(await alphaPanel.disabled("#send-button"))).toBe(true);
    await alphaPanel.click("#send-button");
    await expect
      .poll(
        async () => ({
          chatSends: gateway.chatSends.length,
          users: await alphaPanel.allText(".message.user"),
        }),
        { timeout: 10_000 },
      )
      .toEqual({ chatSends: 1, users: ["alpha marker"] });
    await expect
      .poll(async () => await alphaPanel.allText(".message.assistant"), { timeout: 10_000 })
      .toContain("Isolated reply: alpha marker");

    const betaTab = await context.newPage();
    const betaPanel = await openTabPanel({ browserCdp, extensionId, page: betaTab });
    const betaTabId = await betaTab.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    if (typeof betaTabId !== "number") {
      throw new Error("Chrome did not expose the beta tab id");
    }
    await betaTab.goto(`${fixture.baseUrl}/beta`);
    await expect
      .poll(async () => await betaPanel.text("#gate-title"))
      .toBe("Keep the boundary visible");
    await betaPanel.click("#gate-action");
    await expect
      .poll(async () => !(await betaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(await betaPanel.text("#messages")).not.toContain("alpha marker");
    await betaPanel.fill("#message-input", "beta marker");
    await expect.poll(async () => !(await betaPanel.disabled("#send-button"))).toBe(true);
    await betaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(2);
    await expect
      .poll(async () => await betaPanel.allText(".message.assistant"), { timeout: 10_000 })
      .toContain("Isolated reply: beta marker");
    await betaPanel.screenshot(path.join(artifactDir, "after-isolated.png"));

    expect(gateway.chatSends).toHaveLength(2);
    const [alphaSend, betaSend] = gateway.chatSends;
    if (!alphaSend || !betaSend) {
      throw new Error("expected one isolated send per tab");
    }
    expect(alphaSend.sessionKey).not.toBe(betaSend.sessionKey);
    for (const send of gateway.chatSends) {
      expect(send.deliver).toBe(false);
      expect(send).not.toHaveProperty("url");
      expect(send).not.toHaveProperty("title");
      expect(send).not.toHaveProperty("pageContent");
      expect(send.toolBindings).toEqual({
        browser: expect.objectContaining({
          kind: "tab",
          profile: "chrome",
          tabId: expect.any(Number),
          target: "host",
          targetId: expect.any(String),
        }),
      });
    }
    expect(gateway.histories.get(textValue(alphaSend.sessionKey))).not.toEqual(
      gateway.histories.get(textValue(betaSend.sessionKey)),
    );
    expect(gateway.connectParams[0]).toEqual(
      expect.objectContaining({
        client: expect.objectContaining({ id: GATEWAY_CLIENT_IDS.BROWSER_COPILOT }),
        caps: expect.arrayContaining([
          GATEWAY_CLIENT_CAPS.RUN_TOOL_BINDINGS,
          GATEWAY_CLIENT_CAPS.SESSION_SCOPED_EVENTS,
        ]),
        device: expect.objectContaining({
          id: expect.any(String),
          publicKey: expect.any(String),
          signature: expect.any(String),
        }),
      }),
    );

    await alphaTab.close();
    await expect
      .poll(() => gateway.archived.has(textValue(alphaSend.sessionKey)), { timeout: 15_000 })
      .toBe(true);
    const alphaLifecycle = gateway.requests
      .filter((request) => textValue(request.params?.key) === alphaSend.sessionKey)
      .map((request) => request.method);
    expect(alphaLifecycle).toEqual(
      expect.arrayContaining(["sessions.messages.unsubscribe", "sessions.abort", "sessions.patch"]),
    );
    expect(gateway.histories.get(textValue(alphaSend.sessionKey))).toHaveLength(2);
    const subscriptionsBeforeRace = gateway.requests.filter(
      (request) => request.method === "sessions.messages.subscribe",
    ).length;
    const releaseSubscription = gateway.holdNextSubscription();
    const connectionsBeforeSetupRace = gateway.connectParams.length;
    gateway.disconnectClients();
    await expect
      .poll(() => gateway.connectParams.length, { timeout: 15_000 })
      .toBe(connectionsBeforeSetupRace + 1);
    await expect
      .poll(
        () =>
          gateway.requests.filter((request) => request.method === "sessions.messages.subscribe")
            .length,
        { timeout: 10_000 },
      )
      .toBe(subscriptionsBeforeRace + 1);
    expect(await betaPanel.disabled("#message-input")).toBe(true);
    expect(await betaPanel.text("#gate-title")).toBe("Preparing this tab");
    await disableTabPanel(worker, betaTabId);
    releaseSubscription();
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    expect(gateway.chatSends).toHaveLength(2);

    let reopenedBetaPanel = await openTabPanel({
      browserCdp,
      extensionId,
      page: betaTab,
    });
    await betaTab.goto(`${fixture.baseUrl}/beta`);
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);

    const subscriptionsBeforeConsentRace = gateway.requests.filter(
      (request) => request.method === "sessions.messages.subscribe",
    ).length;
    const releaseConsentSubscription = gateway.holdNextSubscription();
    const connectionsBeforeConsentRace = gateway.connectParams.length;
    gateway.disconnectClients();
    await expect
      .poll(() => gateway.connectParams.length, { timeout: 15_000 })
      .toBe(connectionsBeforeConsentRace + 1);
    await expect
      .poll(
        () =>
          gateway.requests.filter((request) => request.method === "sessions.messages.subscribe")
            .length,
        { timeout: 10_000 },
      )
      .toBe(subscriptionsBeforeConsentRace + 1);
    expect(await reopenedBetaPanel.disabled("#message-input")).toBe(true);
    await unshareTab(worker, betaTabId);
    releaseConsentSubscription();
    await expect
      .poll(async () => await reopenedBetaPanel.text("#gate-title"), { timeout: 10_000 })
      .toBe("Keep the boundary visible");
    expect(gateway.chatSends).toHaveLength(2);
    await reopenedBetaPanel.click("#gate-action");
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);

    await reopenedBetaPanel.fill("#message-input", "ambiguous linger marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    const connectionsBeforeAmbiguousSend = gateway.connectParams.length;
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(3);
    const networkRunId = textValue(gateway.chatSends[2]?.idempotencyKey);
    await expect
      .poll(() => gateway.connectParams.length, { timeout: 15_000 })
      .toBe(connectionsBeforeAmbiguousSend + 1);
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);
    expect(gateway.connectParams.at(-1)?.auth).toEqual(
      expect.objectContaining({ token: expect.any(String) }),
    );
    expect(
      gateway.requests.some(
        (request) => request.method === "sessions.abort" && request.params?.runId === networkRunId,
      ),
    ).toBe(true);
    await reopenedBetaPanel.fill("#message-input", "after reconnect marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(4);
    await expect
      .poll(async () => await reopenedBetaPanel.allText(".message.assistant"), {
        timeout: 10_000,
      })
      .toContain("Isolated reply: after reconnect marker");

    await reopenedBetaPanel.fill("#message-input", "panel linger marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(5);
    const panelRunId = textValue(gateway.chatSends[4]?.idempotencyKey);
    const historiesBeforeNavigation = gateway.requests.filter(
      (request) => request.method === "chat.history",
    ).length;
    await betaTab.goto(`${fixture.baseUrl}/beta?during-run=1`);
    await expect
      .poll(
        async () => ({
          gateHidden: await reopenedBetaPanel.hidden("#gate"),
          messagesHidden: await reopenedBetaPanel.hidden("#messages"),
        }),
        { timeout: 10_000 },
      )
      .toEqual({ gateHidden: true, messagesHidden: false });
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
    expect(gateway.requests.filter((request) => request.method === "chat.history")).toHaveLength(
      historiesBeforeNavigation,
    );
    gateway.failNextAbort();
    await disableTabPanel(worker, betaTabId);
    await expect
      .poll(
        () => ({
          aborts: gateway.requests.filter(
            (request) =>
              request.method === "sessions.abort" && request.params?.runId === panelRunId,
          ).length,
          unsubscribed: gateway.requests.some(
            (request) =>
              request.method === "sessions.messages.unsubscribe" &&
              request.params?.key === betaSend.sessionKey,
          ),
        }),
        { timeout: 10_000 },
      )
      .toEqual({ aborts: 2, unsubscribed: true });

    reopenedBetaPanel = await openTabPanel({
      browserCdp,
      extensionId,
      page: betaTab,
    });
    await betaTab.goto(`${fixture.baseUrl}/beta`);
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);
    await reopenedBetaPanel.fill("#message-input", "reopened marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(6);
    await expect
      .poll(async () => await reopenedBetaPanel.allText(".message.assistant"), {
        timeout: 10_000,
      })
      .toContain("Isolated reply: reopened marker");

    await reopenedBetaPanel.fill("#message-input", "relay disconnect linger marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(7);
    const relayRunId = textValue(gateway.chatSends[6]?.idempotencyKey);
    const relayConnectionsBeforeDrop = relay.connectionCount;
    relay.setAvailable(false);
    await expect
      .poll(
        async () => ({
          detail: await reopenedBetaPanel.text("#gate-detail"),
          disabled: await reopenedBetaPanel.disabled("#message-input"),
          title: await reopenedBetaPanel.text("#gate-title"),
        }),
        { timeout: 10_000 },
      )
      .toEqual({
        detail: "Browser relay reconnecting",
        disabled: true,
        title: "Preparing this tab",
      });
    await expect
      .poll(
        () =>
          gateway.requests.some(
            (request) =>
              request.method === "sessions.abort" && request.params?.runId === relayRunId,
          ),
        { timeout: 10_000 },
      )
      .toBe(true);
    relay.setAvailable(true);
    await expect
      .poll(() => relay.connectionCount, { timeout: 15_000 })
      .toBeGreaterThan(relayConnectionsBeforeDrop);
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);

    const connectionsBeforeWorkerRestart = gateway.connectParams.length;
    await restartServiceWorker(browserCdp, worker, reopenedBetaPanel);
    await expect
      .poll(() => gateway.connectParams.length, { timeout: 15_000 })
      .toBe(connectionsBeforeWorkerRestart + 1);
    await expect
      .poll(async () => !(await reopenedBetaPanel.disabled("#message-input")), {
        timeout: 15_000,
      })
      .toBe(true);
  }, 75_000);
});
