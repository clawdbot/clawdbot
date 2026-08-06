import fs from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { chromium, type CDPSession, type Worker } from "playwright-core";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";
import {
  GATEWAY_CLIENT_CAPS,
  GATEWAY_CLIENT_IDS,
} from "../../../packages/gateway-protocol/src/client-info.js";
import { PROTOCOL_VERSION } from "../../../packages/gateway-protocol/src/version.js";
import { useAutoCleanupTempDirTracker } from "../test-support.js";
import {
  assertCopilotStaleRunIsolation,
  countCopilotHistoryRequests,
  copyCopilotSidepanelExtension,
  openTabPanel,
  rawDataText,
  resolveChromiumExecutableOverride,
  textValue,
  type PanelTarget,
  waitForContextExtensionId,
  waitForLoadedExtensionId,
} from "./sidepanel.e2e-support.js";

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
  storage: {
    local: {
      set(values: Record<string, unknown>): Promise<void>;
    };
    session: {
      get(keys: string[]): Promise<Record<string, unknown>>;
      set(values: Record<string, unknown>): Promise<void>;
    };
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
  labels: Map<string, string>;
  port: number;
  requests: RequestFrame[];
  close: () => Promise<void>;
  disconnectClients: () => void;
  emitEvent: (event: string, payload: Record<string, unknown>) => void;
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

function sendError(
  socket: WebSocket,
  id: string,
  message: string,
  { code = "UNAVAILABLE", retryable = true } = {},
): void {
  socket.send(
    JSON.stringify({
      type: "res",
      id,
      ok: false,
      error: { code, message, retryable },
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
  const labels = new Map<string, string>();
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
        payload: { nonce: "browser-copilot-e2e-nonce", ts: 1_777_777_777_000 },
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
        const label = textValue(params.label);
        const existingKey = labels.get(label);
        if (label && existingKey && existingKey !== key) {
          sendError(socket, frame.id, `label already in use: ${label}`, {
            code: "INVALID_REQUEST",
            retryable: false,
          });
          return;
        }
        if (label) {
          labels.set(label, key);
        }
        if (!histories.has(key)) {
          histories.set(key, []);
        }
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
    labels,
    port,
    requests,
    disconnectClients: () => {
      for (const client of wss.clients) {
        client.terminate();
      }
    },
    emitEvent: (event, payload) => {
      for (const client of wss.clients) {
        client.send(JSON.stringify({ type: "event", event, payload }));
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

async function restartServiceWorker(
  browserCdp: CDPSession,
  worker: Worker,
  panel: PanelTarget,
): Promise<void> {
  const targets = (await browserCdp.send("Target.getTargets")) as {
    targetInfos: Array<{ targetId: string; type: string; url: string }>;
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
  it("survives an unpacked-extension reload across a browser restart", async () => {
    const gateway = await createGatewayHarness();
    cleanups.push(gateway.close);
    const relay = await createRelayHarness();
    cleanups.push(relay.close);
    const fixture = await createFixtureServer();
    cleanups.push(fixture.close);
    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const userDataDir = tempDirs.make("openclaw-copilot-reload-profile-");
    const executablePath = await resolveChromiumExecutableOverride();
    const launchOptions: Parameters<typeof chromium.launchPersistentContext>[1] = {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: true,
      // Playwright disables extensions by default, which overrides the unpacked fixture below.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${unpackedExtension}`,
        `--load-extension=${unpackedExtension}`,
      ],
    };
    const initialContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await initialContext.close());
    const browser = initialContext.browser();
    if (!browser) {
      throw new Error("Chromium browser connection unavailable");
    }
    const browserCdp = await browser.newBrowserCDPSession();
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const launcher = initialContext.pages()[0] ?? (await initialContext.newPage());
    await launcher.goto(`chrome-extension://${extensionId}/e2e-launcher.html`);
    await launcher.evaluate(
      async ({ gatewayPort, relayPort }) =>
        await chrome.runtime.sendMessage({
          type: "pair",
          pairingString: `ws://127.0.0.1:${relayPort}/extension?gateway=${encodeURIComponent(`ws://127.0.0.1:${gatewayPort}`)}#relay-e2e-token`,
          groupColor: "#ff7020",
        }),
      { gatewayPort: gateway.port, relayPort: relay.port },
    );
    await expect.poll(() => gateway.connectParams.length, { timeout: 10_000 }).toBe(1);

    const tabId = await launcher.evaluate(async () => (await chrome.tabs.getCurrent()).id);
    if (typeof tabId !== "number") {
      throw new Error("Chrome did not expose the extension tab id");
    }
    const oldSessionKey =
      "agent:main:main:thread:browser-copilot-11111111-1111-4111-8111-111111111111";
    gateway.labels.set("Browser copilot", oldSessionKey);
    gateway.histories.set(oldSessionKey, []);
    await launcher.evaluate(
      async ({ gatewayScope, archivedSessionKey, currentTabId }) => {
        await chrome.storage.local.set({
          copilotSessionRegistryV1: {
            sessions: {
              [currentTabId]: {
                tabId: currentTabId,
                browserInstanceId: "beta-5-browser-instance",
                gatewayScope,
                sessionKey: archivedSessionKey,
                sessionId: "beta-5-session",
              },
            },
            pendingArchives: [],
          },
        });
        await chrome.storage.session.set({
          copilotBrowserInstanceV1: "beta-5-browser-instance",
        });
      },
      {
        archivedSessionKey: oldSessionKey,
        currentTabId: tabId,
        gatewayScope: `ws://127.0.0.1:${gateway.port}/`,
      },
    );

    await initialContext.close();
    const reloadedContext = await chromium.launchPersistentContext(userDataDir, launchOptions);
    cleanups.push(async () => await reloadedContext.close());
    const reloadedBrowser = reloadedContext.browser();
    if (!reloadedBrowser) {
      throw new Error("Reloaded Chromium browser connection unavailable");
    }
    const reloadedBrowserCdp = await reloadedBrowser.newBrowserCDPSession();
    const reloadedExtensionId = await waitForLoadedExtensionId(
      reloadedBrowserCdp,
      unpackedExtension,
    );
    expect(reloadedExtensionId).toBe(extensionId);
    const reloadedLauncher = reloadedContext.pages()[0] ?? (await reloadedContext.newPage());
    await reloadedLauncher.goto(`chrome-extension://${reloadedExtensionId}/e2e-launcher.html`);
    await expect.poll(() => gateway.connectParams.length, { timeout: 15_000 }).toBe(2);
    const browserInstanceId = await reloadedLauncher.evaluate(async () => {
      const stored = await chrome.storage.session.get(["copilotBrowserInstanceV1"]);
      return stored.copilotBrowserInstanceV1;
    });
    expect(browserInstanceId).not.toBe("beta-5-browser-instance");

    const panel = await openTabPanel({
      browserCdp: reloadedBrowserCdp,
      expect,
      extensionId: reloadedExtensionId,
      page: reloadedLauncher,
    });
    await reloadedLauncher.goto(`${fixture.baseUrl}/reload`);
    await panel.click("#gate-action");
    await expect
      .poll(async () => !(await panel.disabled("#message-input")), { timeout: 15_000 })
      .toBe(true);
    await expect.poll(() => gateway.archived.has(oldSessionKey), { timeout: 10_000 }).toBe(true);

    const created = gateway.requests.filter((request) => request.method === "sessions.create");
    const fresh = created.find((request) => request.params?.key !== oldSessionKey);
    expect(fresh?.params).toEqual({
      key: expect.stringMatching(/:thread:browser-copilot-[0-9a-f-]{36}$/),
      label: expect.stringMatching(/^Browser copilot [0-9a-f-]{36}$/),
    });
    expect(fresh?.params?.label).not.toBe("Browser copilot");
    expect(gateway.labels.get("Browser copilot")).toBe(oldSessionKey);

    await panel.fill("#message-input", "reload recovery marker");
    await panel.click("#send-button");
    await expect
      .poll(async () => await panel.allText(".message.assistant"), { timeout: 10_000 })
      .toContain("Isolated reply: reload recovery marker");
  }, 90_000);

  it("returns one error response when a panel's tab disappears", async () => {
    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const userDataDir = tempDirs.make("openclaw-copilot-missing-tab-profile-");
    const executablePath = await resolveChromiumExecutableOverride();
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: true,
      // Playwright disables extensions by default, which overrides the unpacked fixture below.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
        `--disable-extensions-except=${unpackedExtension}`,
        `--load-extension=${unpackedExtension}`,
      ],
    });
    cleanups.push(async () => await context.close());
    const extensionId = await waitForContextExtensionId(context, unpackedExtension);
    const popup = context.pages()[0] ?? (await context.newPage());
    await popup.goto(`chrome-extension://${extensionId}/popup.html`);

    const outcome = await popup.evaluate(async () => {
      const currentTab = await chrome.tabs.getCurrent();
      if (typeof currentTab?.id !== "number") {
        throw new Error("Chrome did not expose the extension tab");
      }
      const valid = await chrome.runtime.sendMessage({
        type: "prepareCopilotPanel",
        tabId: currentTab.id,
      });
      const missing = await Promise.race([
        chrome.runtime.sendMessage({ type: "prepareCopilotPanel", tabId: 2_147_483_000 }).then(
          (response) => ({ kind: "response", response }),
          (error: unknown) => ({
            kind: "rejection",
            error: error instanceof Error ? error.message : String(error),
          }),
        ),
        new Promise((resolve) => {
          setTimeout(() => resolve({ kind: "timeout" }), 1_200);
        }),
      ]);
      return { valid, missing };
    });

    expect(outcome.valid).toEqual({
      ok: true,
      path: expect.stringMatching(/^sidepanel\.html\?binding=/),
    });
    expect(outcome.missing).toEqual({
      kind: "response",
      response: {
        ok: false,
        error: expect.stringMatching(/No tab with id: 2147483000/),
      },
    });
  });

  it("isolates two tab sessions, enforces bindings, denies unshared use, and archives on close", async () => {
    const gateway = await createGatewayHarness();
    cleanups.push(gateway.close);
    const relay = await createRelayHarness();
    cleanups.push(relay.close);
    const fixture = await createFixtureServer();
    cleanups.push(fixture.close);
    const unpackedExtension = await copyCopilotSidepanelExtension(tempDirs);
    const userDataDir = tempDirs.make("openclaw-copilot-profile-");
    const executablePath = await resolveChromiumExecutableOverride();
    const context = await chromium.launchPersistentContext(userDataDir, {
      ...(executablePath ? { executablePath } : { channel: "chromium" }),
      headless: true,
      // Playwright disables extensions by default, which overrides the unpacked fixture below.
      ignoreDefaultArgs: ["--disable-extensions"],
      args: [
        "--enable-unsafe-extension-debugging",
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
    const extensionId = await waitForLoadedExtensionId(browserCdp, unpackedExtension);
    const alphaTab = context.pages()[0] ?? (await context.newPage());
    await alphaTab.goto(`chrome-extension://${extensionId}/e2e-launcher.html`);
    const worker = context.serviceWorkers()[0] ?? (await context.waitForEvent("serviceworker"));
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

    const alphaPanel = await openTabPanel({ browserCdp, expect, extensionId, page: alphaTab });
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
    await alphaPanel.fill("#message-input", "にほん");
    expect(await alphaPanel.pressEnter("#message-input", true)).toEqual({
      defaultPrevented: false,
      value: "にほん",
    });
    expect(gateway.chatSends).toHaveLength(0);
    expect(await alphaPanel.allText(".message.user")).toEqual([]);
    await alphaPanel.fill("#message-input", "alpha marker");
    await expect.poll(async () => !(await alphaPanel.disabled("#send-button"))).toBe(true);
    expect(await alphaPanel.pressEnter("#message-input", false)).toEqual({
      defaultPrevented: true,
      value: "",
    });
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
    const betaPanel = await openTabPanel({ browserCdp, expect, extensionId, page: betaTab });
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
      expect,
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
    const historiesBeforeReconnectTurn = countCopilotHistoryRequests(gateway);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(4);
    await expect
      .poll(async () => await reopenedBetaPanel.allText(".message.assistant"), {
        timeout: 10_000,
      })
      .toContain("Isolated reply: after reconnect marker");
    await expect
      .poll(() => countCopilotHistoryRequests(gateway), { timeout: 10_000 })
      .toBeGreaterThan(historiesBeforeReconnectTurn);

    await reopenedBetaPanel.fill("#message-input", "panel linger marker");
    await expect.poll(async () => !(await reopenedBetaPanel.disabled("#send-button"))).toBe(true);
    await reopenedBetaPanel.click("#send-button");
    await expect.poll(() => gateway.chatSends.length, { timeout: 10_000 }).toBe(5);
    const panelRunId = textValue(gateway.chatSends[4]?.idempotencyKey);
    const historiesBeforeNavigation = countCopilotHistoryRequests(gateway);
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
    expect(countCopilotHistoryRequests(gateway)).toBe(historiesBeforeNavigation);
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
      expect,
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

    await assertCopilotStaleRunIsolation({ expect, gateway, panel: reopenedBetaPanel });
  }, 120_000);
});
