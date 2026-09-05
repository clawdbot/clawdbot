import { expect, it } from "vitest";
import { controlUiBundledSettingsStorageKey } from "../test-helpers/control-ui-e2e.ts";
import {
  SESSION_DRAG_MIME,
  captureSessionAccessibilityProof,
  captureUiProof,
  chatSessionListResponse,
  controlUiSessionPath,
  createChatFlowE2eSuite,
  controlUiSessionUrl,
  installMockGateway,
  requireRecord,
  sidebarSessionOrder,
  waitForChatScrollIdle,
} from "./chat-flow.test-support.ts";
import { dockChatSidePanel, openChatSidePanelType } from "./chat-side-panel.test-support.ts";

const suite = createChatFlowE2eSuite();
const rosterMatch = { includeGlobal: true };

async function readTopTranscriptAnchor(thread: import("playwright").Locator) {
  return thread.evaluate((element) => {
    const top = element.getBoundingClientRect().top;
    const rows = [...element.querySelectorAll<HTMLElement>("[data-virtual-row-key]")];
    const row = rows.find((candidate) => candidate.getBoundingClientRect().bottom > top);
    return row
      ? { key: row.dataset.virtualRowKey ?? null, offset: row.getBoundingClientRect().top - top }
      : null;
  });
}

suite.define(() => {
  it("coalesces persisted same-session split panes during cold startup", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    await context.addInitScript((settingsKey) => {
      localStorage.setItem(
        settingsKey,
        JSON.stringify({
          chatSplitLayout: {
            activePaneId: "p1",
            columns: [
              {
                id: "c1",
                panes: [{ id: "p1", sessionKey: "agent:main:session-a" }],
                paneWeights: [1],
              },
              {
                id: "c2",
                panes: [{ id: "p2", sessionKey: "agent:main:session-a" }],
                paneWeights: [1],
              },
            ],
            columnWeights: [0.5, 0.5],
          },
        }),
      );
    }, controlUiBundledSettingsStorageKey(suite.server.baseUrl));
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["chat.startup", "chat.startup"],
      historyMessages: [
        {
          content: [{ type: "text", text: "Shared cold startup proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      await expect.poll(() => panes.count(), { timeout: 10_000 }).toBe(2);
      await expect
        .poll(() =>
          panes.evaluateAll((nodes) =>
            nodes.map((node) =>
              Boolean(
                (node as HTMLElement & { state?: { chatLoading?: boolean } }).state?.chatLoading,
              ),
            ),
          ),
        )
        .toEqual([true, true]);
      expect(await gateway.getRequests("chat.startup")).toHaveLength(1);

      await gateway.resolveDeferred("chat.startup");
      await expect.poll(() => page.getByText("Shared cold startup proof.").count()).toBe(2);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("retains scrolled and end-anchored sessions without history reloads", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 720, width: 1280 },
    });
    const page = await context.newPage();
    const sessionA = "agent:main:session-a";
    const sessionB = "agent:main:session-b";
    const messages = (label: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `${label} message ${index}: ${"wrapped transcript content ".repeat(8)}`,
        timestamp: 1_000 + index,
        __openclaw: { seq: index + 1 },
      }));
    const response = (sessionKey: string, transcript: unknown[]) => ({
      messages: transcript,
      sessionId: `${sessionKey}:backing`,
      thinkingLevel: null,
    });
    const responseCases = (messagesA: unknown[], messagesB = messages("B", 30)) => ({
      cases: [
        { match: { sessionKey: sessionA }, response: response(sessionA, messagesA) },
        { match: { sessionKey: sessionB }, response: response(sessionB, messagesB) },
      ],
    });
    const initialMessagesA = messages("A", 70);
    const initialResponses = responseCases(initialMessagesA);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": initialResponses,
        "chat.startup": initialResponses,
        "sessions.list": chatSessionListResponse([
          {
            key: sessionA,
            sessionId: `${sessionA}:backing`,
            kind: "direct",
            label: "Session A",
            updatedAt: 2,
          },
          {
            key: sessionB,
            sessionId: `${sessionB}:backing`,
            kind: "direct",
            label: "Session B",
            updatedAt: 1,
          },
        ]),
      },
      sessionKey: sessionA,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionA));
      await waitForChatScrollIdle(page);
      await gateway.waitForRequest("agent.identity.get");
      const initialIdentityRequestCount = (await gateway.getRequests("agent.identity.get")).length;
      const thread = page.locator(".chat-pane-cache__pane--active .chat-thread");
      await expect.poll(() => thread.count()).toBe(1);
      const initialDistance = await thread.evaluate((element) => {
        const transcript = element as HTMLElement;
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      });
      expect(initialDistance).toBeLessThanOrEqual(8);
      await thread.evaluate((element) => {
        const transcript = element as HTMLElement;
        transcript.scrollTop = Math.floor((transcript.scrollHeight - transcript.clientHeight) / 3);
        transcript.dispatchEvent(new Event("scroll", { bubbles: true }));
      });
      await waitForChatScrollIdle(page);
      const storedAnchor = await readTopTranscriptAnchor(thread);
      expect(storedAnchor?.key).not.toBeNull();

      const sessionLink = (sessionKey: string) =>
        page.locator(
          `.sidebar-recent-session[data-session-key="${sessionKey}"] a.sidebar-recent-session__link`,
        );
      await sessionLink(sessionB).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionB));
      await waitForChatScrollIdle(page);
      expect(await gateway.getRequests("agent.identity.get")).toHaveLength(
        initialIdentityRequestCount,
      );
      const firstVisitDistance = await thread.evaluate((element) => {
        const transcript = element as HTMLElement;
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      });
      expect(firstVisitDistance).toBeLessThanOrEqual(8);

      const historyRequestsBeforeReturn = (await gateway.getRequests("chat.history")).length;
      await sessionLink(sessionA).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionA));
      await waitForChatScrollIdle(page);
      expect(await gateway.getRequests("chat.history")).toHaveLength(historyRequestsBeforeReturn);

      const restored = await thread.evaluate((element) => {
        const transcript = element as HTMLElement;
        return {
          distanceFromBottom:
            transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight,
          scrollTop: transcript.scrollTop,
        };
      });
      const restoredAnchor = await readTopTranscriptAnchor(thread);
      expect(restoredAnchor?.key).toBe(storedAnchor?.key);
      expect(
        Math.abs((restoredAnchor?.offset ?? 0) - (storedAnchor?.offset ?? 0)),
        JSON.stringify({ restoredAnchor, storedAnchor }),
      ).toBeLessThanOrEqual(2);
      expect(restored.distanceFromBottom).toBeGreaterThan(8);

      const historyRequestsBeforeEndReturn = (await gateway.getRequests("chat.history")).length;
      await sessionLink(sessionB).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe(controlUiSessionPath(sessionB));
      await waitForChatScrollIdle(page);
      expect(await gateway.getRequests("chat.history")).toHaveLength(
        historyRequestsBeforeEndReturn,
      );
      const endAnchoredDistance = await thread.evaluate((element) => {
        const transcript = element as HTMLElement;
        return transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight;
      });
      expect(endAnchoredDistance).toBeLessThanOrEqual(8);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("renders always-on pane headers without desktop topbar chrome", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ type: "text", text: "Split toolbar proof." }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
      methodResponses: { "sessions.list": chatSessionListResponse() },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      await page.getByText("Split toolbar proof.").waitFor({ timeout: 10_000 });

      // Desktop renders no topbar row: the sidebar owns navigation.
      await expect.poll(() => page.locator(".topbar").isVisible()).toBe(false);

      const splitEntry = page.getByRole("button", { name: "Open split view" });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await expect.poll(() => page.locator(".chat-pane__header").count()).toBe(1);
      const taskHeader = page.locator(".chat-pane__header");
      const regularHeaderPadding = await taskHeader.evaluate(
        (header) => getComputedStyle(header).paddingLeft,
      );
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill("Keep this draft while docking beside native controls");
      const originalComposer = await composer.elementHandle();
      await page.evaluate(() => {
        document.documentElement.classList.add("openclaw-native-macos");
        document.querySelector(".shell")?.classList.add("shell--nav-collapsed");
      });
      await expect
        .poll(() =>
          page
            .locator(".chat-pane__header")
            .evaluate((header) => getComputedStyle(header).paddingLeft),
        )
        .toBe("90px");
      await openChatSidePanelType(page, "Files");
      await dockChatSidePanel(page, "left");
      const sideHeader = page.locator('[data-region-header="side"]');
      const filesTab = sideHeader.getByRole("tab", { name: "Files", exact: true });
      await filesTab.waitFor();
      await expect
        .poll(() => taskHeader.evaluate((header) => getComputedStyle(header).paddingLeft))
        .toBe(regularHeaderPadding);
      await expect
        .poll(() => filesTab.evaluate((tab) => tab.getBoundingClientRect().left))
        .toBeGreaterThanOrEqual(90);
      const taskHeaderBox = await taskHeader.boundingBox();
      const sideHeaderBox = await sideHeader.boundingBox();
      expect(taskHeaderBox?.y).toBeCloseTo(sideHeaderBox!.y, 0);
      expect(taskHeaderBox!.x).toBeGreaterThan(sideHeaderBox!.x);
      expect(
        await composer.evaluate((element, original) => element === original, originalComposer),
      ).toBe(true);
      expect(await composer.inputValue()).toBe(
        "Keep this draft while docking beside native controls",
      );
      await originalComposer?.dispose();
      await sideHeader.getByRole("button", { name: "Close Files", exact: true }).click();
      await filesTab.waitFor({ state: "detached" });
      await composer.fill("");
      await page.evaluate(() => {
        document.documentElement.classList.remove("openclaw-native-macos");
        document.querySelector(".shell")?.classList.remove("shell--nav-collapsed");
      });
      await page.setViewportSize({ height: 900, width: 1100 });
      await expect.poll(() => splitEntry.isVisible()).toBe(true);
      await page.setViewportSize({ height: 900, width: 1440 });
      await expect
        .poll(() =>
          splitEntry.evaluate((node) => node.closest(".agent-chat__composer-shell") == null),
        )
        .toBe(true);
      await page.locator("openclaw-chat-pane").evaluate((pane) => {
        (
          globalThis as typeof globalThis & {
            classicChatPane?: Element;
          }
        ).classicChatPane = pane;
      });
      const startupRequestsBeforeSplit = (await gateway.getRequests("chat.startup")).length;
      await gateway.deferNext("chat.startup");
      await splitEntry.click();
      await expect
        .poll(async () => (await gateway.getRequests("chat.startup")).length)
        .toBeGreaterThan(startupRequestsBeforeSplit);

      // Each pane owns the same in-flow header in classic and split layouts.
      const panes = page.locator("openclaw-chat-pane.chat-split-view__pane");
      const headers = page.locator(".chat-pane__header");
      await expect.poll(() => panes.count()).toBe(2);
      await panes.last().getByText("Split toolbar proof.").waitFor();
      await expect
        .poll(() =>
          panes
            .last()
            .locator('openclaw-panel-loading-skeleton[data-panel-skeleton="chat"]')
            .count(),
        )
        .toBe(0);
      await gateway.resolveDeferred("chat.startup");
      await expect
        .poll(() =>
          panes.first().evaluate(
            (pane) =>
              (
                globalThis as typeof globalThis & {
                  classicChatPane?: Element;
                }
              ).classicChatPane === pane,
          ),
        )
        .toBe(true);
      await expect.poll(() => headers.count()).toBe(2);
      await expect
        .poll(async () => {
          const visible = await Promise.all((await headers.all()).map((pane) => pane.isVisible()));
          return visible.every(Boolean);
        })
        .toBe(true);
      await expect.poll(() => splitEntry.count()).toBe(0);
      // The pane header owns one side-panel toggle; individual tools live in its tab strip.
      await expect.poll(() => headers.first().locator(".chat-side-panel-toggle").count()).toBe(1);
      await expect.poll(() => page.locator(".chat-workspace-rail").count()).toBe(0);

      const cells = page.locator(".chat-split-view__cell");
      const actionRows = headers.locator(".chat-pane__actions");
      await expect.poll(() => actionRows.first().isVisible()).toBe(false);
      await expect.poll(() => actionRows.last().isVisible()).toBe(true);
      expect(
        await headers
          .first()
          .locator(".chat-pane__close-pane")
          .evaluate((button) => {
            (button as HTMLElement).focus();
            return document.activeElement === button;
          }),
      ).toBe(false);

      await panes.first().click({ position: { x: 20, y: 80 } });
      await expect.poll(() => cells.first().getAttribute("class")).toContain("--active");
      await expect.poll(() => actionRows.first().isVisible()).toBe(true);
      await expect.poll(() => actionRows.last().isVisible()).toBe(false);
      const paneEmphasis = await cells.evaluateAll((nodes) =>
        nodes.map((cell) => {
          const style = getComputedStyle(cell);
          return {
            active: cell.classList.contains("chat-split-view__cell--active"),
            boxShadow: style.boxShadow,
            filter: style.filter,
            opacity: style.opacity,
          };
        }),
      );
      expect(paneEmphasis).toEqual([
        { active: true, boxShadow: "none", filter: "none", opacity: "1" },
        { active: false, boxShadow: "none", filter: "saturate(0.45)", opacity: "1" },
      ]);

      const lastPane = page.locator(".chat-split-view__pane").last();
      await lastPane.click({ position: { x: 20, y: 80 } });
      await expect.poll(() => cells.last().getAttribute("class")).toContain("--active");
      await expect.poll(() => actionRows.first().isVisible()).toBe(false);
      await expect.poll(() => actionRows.last().isVisible()).toBe(true);
      const targetHeader = headers.first();
      const headerGeometry = await headers.evaluateAll((nodes) =>
        nodes.map((header) => {
          const owner = header.closest("openclaw-chat-pane");
          const main = owner?.querySelector('[data-region="main"]:not([hidden])');
          if (!main) {
            throw new Error("Each task toolbar must have visible main content");
          }
          const toolbar = header.getBoundingClientRect();
          const content = main.getBoundingClientRect();
          return {
            height: toolbar.height,
            left: Math.abs(toolbar.left - content.left),
            right: Math.abs(toolbar.right - content.right),
            gap: Math.abs(toolbar.bottom - content.top),
          };
        }),
      );
      for (const geometry of headerGeometry) {
        expect(geometry.height).toBeGreaterThan(0);
        expect(Math.max(geometry.left, geometry.right, geometry.gap)).toBeLessThanOrEqual(1);
      }

      const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
      await dataTransfer.evaluate(
        (transfer, data) => {
          transfer.setData(data.mime, data.sessionKey);
        },
        { mime: SESSION_DRAG_MIME, sessionKey: "agent:main:session-b" },
      );
      const unrelatedTarget = page.locator(".chat-split-view");
      const unrelatedDrag = {
        bubbles: true,
        clientX: 0,
        clientY: 0,
        dataTransfer,
      };
      await unrelatedTarget.dispatchEvent("dragenter", unrelatedDrag);
      await unrelatedTarget.dispatchEvent("dragover", unrelatedDrag);
      await expect.poll(() => page.locator(".chat-split-view__drop-indicator").count()).toBe(0);
      await unrelatedTarget.dispatchEvent("drop", unrelatedDrag);
      await expect.poll(() => panes.count()).toBe(2);
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:session-a"));

      // Start with no retained pane preview and target the visible header.
      const targetBox = await targetHeader.boundingBox();
      if (!targetBox) {
        throw new Error("expected the pane header to have a layout box");
      }
      const directHeaderDrag = {
        bubbles: true,
        clientX: targetBox.x + targetBox.width / 2,
        clientY: targetBox.y + targetBox.height / 2,
        dataTransfer,
      };
      await targetHeader.dispatchEvent("dragenter", directHeaderDrag);
      await targetHeader.dispatchEvent("dragover", directHeaderDrag);
      await expect.poll(() => page.locator(".chat-split-view__drop-indicator").count()).toBe(1);
      await targetHeader.dispatchEvent("drop", directHeaderDrag);
      await dataTransfer.dispose();

      await expect.poll(() => panes.count()).toBe(3);
      await expect
        .poll(async () =>
          (await page.locator(".chat-pane__session-title").allTextContents()).map((title) =>
            title.trim(),
          ),
        )
        .toContain("Session B");
      await expect
        .poll(() => new URL(page.url()).pathname)
        .toBe(controlUiSessionPath("agent:main:session-b"));
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("opens current context and latest-run usage from the composer ring", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        { role: "user", content: "Show current usage", timestamp: Date.now() - 1_000 },
        {
          role: "assistant",
          content: "Usage ready.",
          cost: {
            input: 0.003456,
            output: 0.018,
            cacheRead: 0.0015,
            cacheWrite: 0.0005,
            total: 0.023456,
          },
          model: "gpt-5.5",
          provider: "openai",
          timestamp: Date.now(),
        },
        {
          role: "assistant",
          content: "Usage ready.",
          model: "gateway-injected",
          provider: "openclaw",
          timestamp: Date.now() + 1,
          usage: {
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
      ],
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: {
            contextTokens: 200_000,
            model: "gpt-5.5",
            modelProvider: "openai",
          },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              estimatedCostUsd: 0.023456,
              inputTokens: 757_300,
              key: "main",
              kind: "direct",
              model: "gpt-5.5",
              modelProvider: "openai",
              outputTokens: 42_300,
              totalTokens: 46_000,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const trigger = page.locator("summary.context-ring");
      await trigger.waitFor({ timeout: 10_000 });
      await trigger.click();

      const popover = page.locator(".context-usage__popover");
      await expect.poll(() => popover.isVisible()).toBe(true);
      await expect.poll(() => popover.textContent()).toContain("46k / 200k · 23%");
      await expect.poll(() => popover.textContent()).toContain("757.3k");
      await expect.poll(() => popover.textContent()).toContain("42.3k");
      await expect.poll(() => popover.textContent()).toContain("Est. cost");
      await expect.poll(() => popover.textContent()).toContain("$0.023");
      await expect.poll(() => popover.textContent()).toContain("Cost by Type");
      await expect.poll(() => popover.textContent()).toContain("$0.0035");
      await expect.poll(() => popover.textContent()).toContain("$0.018");
      await expect.poll(() => popover.textContent()).toContain("$0.0015");
      await expect.poll(() => popover.textContent()).toContain("$0.0005");

      await page.keyboard.press("Escape");
      await expect.poll(() => popover.isHidden()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("routes page typing to the active composer without stealing text input focus", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          content: [{ text: "Type whenever you are ready.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      await page.getByText("Type whenever you are ready.").click();

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await expect
        .poll(() => composer.evaluate((element) => element === document.activeElement))
        .toBe(false);

      await page.keyboard.type("first character preserved");
      expect(await composer.inputValue()).toBe("first character preserved");
      await expect
        .poll(() => composer.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.getByRole("button", { name: "Open command palette" }).click();
      const paletteInput = page.locator(".cmd-palette__input");
      await paletteInput.waitFor({ state: "visible", timeout: 10_000 });
      await expect
        .poll(() => paletteInput.evaluate((element) => element === document.activeElement))
        .toBe(true);
      await page.keyboard.type("session search");

      expect(await paletteInput.inputValue()).toBe("session search");
      expect(await composer.inputValue()).toBe("first character preserved");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps stale context visible as approximate without warning", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      methodResponses: {
        "sessions.list": {
          count: 1,
          defaults: { contextTokens: 200_000, model: "gpt-5.5", modelProvider: "openai" },
          path: "",
          sessions: [
            {
              contextTokens: 200_000,
              key: "main",
              kind: "direct",
              totalTokens: 190_000,
              totalTokensFresh: false,
              updatedAt: Date.now(),
            },
          ],
          ts: Date.now(),
        },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);
      const trigger = page.locator("summary.context-ring");
      await trigger.waitFor({ timeout: 10_000 });
      expect((await trigger.textContent())?.trim()).toBe("");
      expect(await trigger.getAttribute("aria-label")).toBe(
        "Session context usage: ~190k of 200k (~95%)",
      );
      expect(
        await trigger.evaluate((element) => element.classList.contains("context-ring--warning")),
      ).toBe(false);

      await trigger.click();
      await expect
        .poll(() => page.locator(".context-usage__popover").textContent())
        .toContain("~190k / 200k · ~95%");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps chat usable while sessions are still loading", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      deferredMethods: ["sessions.list"],
      featureMethods: ["chat.metadata", "chat.startup", "sessions.create"],
      historyMessages: [
        {
          content: [{ text: "History renders before sessions finish.", type: "text" }],
          role: "assistant",
          timestamp: Date.now(),
        },
      ],
    });

    try {
      await page.goto(`${suite.server.baseUrl}chat`);

      await page.getByText("History renders before sessions finish.").waitFor({ timeout: 10_000 });
      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.waitFor({ state: "visible", timeout: 10_000 });

      // The chat boot hydrates the sidebar session list; that request stays
      // deferred here while the composer must remain fully usable.
      await gateway.waitForRequest("sessions.list", { match: rosterMatch });

      await composer.fill("draft while sessions load");
      expect(await composer.inputValue()).toBe("draft while sessions load");
      await composer.fill("");

      // The background hydrate must not take the shared sessions loading
      // flag, which would disable New session for the whole request.
      const newThread = page.getByRole("link", { name: "New session" }).first();
      expect(await newThread.isEnabled()).toBe(true);

      await gateway.resolveDeferred("sessions.list");
      await expect.poll(() => newThread.isEnabled()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps every sidebar session stable while selecting sessions and supports sort modes", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const createdSessionKeys = Array.from(
      { length: 11 },
      (_, index) => `agent:main:session-${String.fromCharCode(97 + index)}`,
    );
    const pinnedSessionKey = "agent:main:session-pinned";
    const createdOrder = [pinnedSessionKey, ...createdSessionKeys];
    const updatedOrder = [pinnedSessionKey, ...createdSessionKeys.toReversed()];
    const sessions = {
      count: createdSessionKeys.length + 1,
      defaults: {
        contextTokens: null,
        model: "gpt-5.5",
        modelProvider: "openai",
      },
      path: "",
      sessions: [
        {
          key: pinnedSessionKey,
          kind: "direct",
          label: "Pinned Session",
          pinned: true,
          pinnedAt: 1,
          updatedAt: 50,
        },
        ...createdSessionKeys.map((key, index) => ({
          key,
          kind: "direct",
          label: `Session ${key.slice(-1).toUpperCase()}`,
          updatedAt: (index + 1) * 100,
        })),
      ],
      ts: Date.now(),
    };
    await installMockGateway(page, {
      methodResponses: { "sessions.list": sessions },
      sessionKey: "agent:main:session-a",
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, "agent:main:session-a"));
      await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
        .waitFor({
          timeout: 10_000,
        });
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder.slice(0, 11));
      await page.getByRole("button", { name: "Show more" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      await page
        .locator(
          '.sidebar-recent-session[data-session-key="agent:main:session-b"] a.sidebar-recent-session__link',
        )
        .click();
      await page.locator(".sidebar-recent-session--active").getByText("Session B").waitFor({
        timeout: 10_000,
      });
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      const activeWeight = await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-b"]')
        .locator(".sidebar-recent-session__name")
        .evaluate((label) => getComputedStyle(label).fontWeight);
      const inactiveWeight = await page
        .locator('.sidebar-recent-session[data-session-key="agent:main:session-a"]')
        .locator(".sidebar-recent-session__name")
        .evaluate((label) => getComputedStyle(label).fontWeight);
      expect(activeWeight).toBe(inactiveWeight);

      const filterAndSort = page.getByRole("button", { name: "Filter & sort" });
      await filterAndSort.click();
      await page.getByRole("menuitemradio", { name: "Last updated" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(updatedOrder);

      await filterAndSort.click();
      await page.getByRole("menuitemradio", { name: "Created" }).click();
      await expect.poll(() => sidebarSessionOrder(page)).toEqual(createdOrder);

      await filterAndSort.click();
      await page.getByRole("main").click();
      await expect.poll(() => page.getByRole("menuitemradio", { name: "Created" }).count()).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("releases a retained queued send after the canonical session list records idle", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const firstKey = "agent:main:thread:aaaaaaaa-1111-4111-8111-111111111111";
    const secondKey = "agent:main:thread:bbbbbbbb-2222-4222-8222-222222222222";
    const activeSessions = chatSessionListResponse([
      {
        key: firstKey,
        kind: "direct",
        label: "Instant A",
        updatedAt: 2,
        activeRunIds: ["server-run"],
        hasActiveRun: true,
        status: "running",
      },
      { key: secondKey, kind: "direct", label: "Instant B", updatedAt: 1 },
    ]);
    const idleSessions = chatSessionListResponse([
      {
        key: firstKey,
        kind: "direct",
        label: "Instant A",
        updatedAt: 3,
        activeRunIds: [],
        hasActiveRun: false,
        lastRunId: "server-run",
        status: "done",
      },
      { key: secondKey, kind: "direct", label: "Instant B", updatedAt: 1 },
    ]);
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "chat.history": {
          messages: [],
          sessionInfo: { hasActiveRun: false, status: "done" },
          thinkingLevel: null,
        },
        "sessions.list": activeSessions,
      },
      sessionKey: firstKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, firstKey));
      await page.locator(`.sidebar-recent-session[data-session-key="${secondKey}"]`).waitFor();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant A")
        .waitFor();
      await page.waitForTimeout(500);
      const initialListCount = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      const initialMetadataCount = (await gateway.getRequests("chat.metadata")).length;
      await gateway.deferNext("sessions.list", rosterMatch);

      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${secondKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant B")
        .waitFor();
      const emptyOutboxListRequests = (
        await gateway.getRequests("sessions.list", rosterMatch)
      ).slice(initialListCount);
      expect(emptyOutboxListRequests).toHaveLength(0);
      expect(await gateway.getRequests("chat.metadata")).toHaveLength(initialMetadataCount);
      const emptyOutboxListCount = initialListCount + emptyOutboxListRequests.length;

      await page.locator('openclaw-chat-pane[aria-hidden="false"]').evaluate((pane, targetKey) => {
        const state = (
          pane as HTMLElement & {
            state: {
              settings?: { gatewayUrl?: string };
            };
          }
        ).state;
        const gatewayOwner = state.settings?.gatewayUrl?.trim() || "default";
        const key = `openclaw.control.chatComposer.v2:${encodeURIComponent(gatewayOwner)}`;
        sessionStorage.setItem(
          key,
          JSON.stringify({
            version: 2,
            gatewayOwner,
            sessions: {
              [`${targetKey}\u0000agent:main`]: {
                updatedAt: Date.now(),
                queue: [
                  {
                    id: "queued-before-switch",
                    text: "flush after idle reconciliation",
                    createdAt: Date.now(),
                    sendState: "waiting-idle",
                    sessionKey: targetKey,
                    agentId: "main",
                  },
                ],
              },
            },
          }),
        );
        window.dispatchEvent(new StorageEvent("storage", { key, storageArea: sessionStorage }));
      }, firstKey);
      await page
        .locator(
          `.sidebar-recent-session[data-session-key="${firstKey}"] a.sidebar-recent-session__link`,
        )
        .click();
      await page
        .locator(".chat-pane-cache__pane--visible .chat-pane__session-title")
        .getByText("Instant A")
        .waitFor();
      await expect
        .poll(async () => (await gateway.getRequests("sessions.list", rosterMatch)).length)
        .toBe(emptyOutboxListCount + 1);
      const queued = page.locator(".chat-queue").getByText("flush after idle reconciliation");
      await queued.waitFor();
      expect(await gateway.getRequests("chat.send")).toHaveLength(0);
      await captureUiProof(suite, page, "queued-idle-release", "01-queued-before-idle.png");
      await gateway.resolveDeferred("sessions.list", idleSessions);
      const send = await gateway.waitForRequest("chat.send");
      expect(requireRecord(send.params)).toMatchObject({
        message: "flush after idle reconciliation",
        sessionKey: firstKey,
      });
      await queued.waitFor({ state: "detached" });
      await captureUiProof(suite, page, "queued-idle-release", "02-sent-after-idle.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps derived sidebar titles and accessible state after session patch refreshes", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    const page = await context.newPage();
    const initialKey = "agent:main:session-a";
    const key = "agent:main:session-b";
    const readableTitle = "Readable planning title";
    const baseTime = Date.now();
    const sessionsWithDerivedTitle = chatSessionListResponse([
      {
        key: initialKey,
        kind: "direct",
        label: initialKey,
        displayName: initialKey,
        derivedTitle: "Initial readable title",
        updatedAt: baseTime,
      },
      {
        key,
        kind: "direct",
        label: key,
        displayName: key,
        derivedTitle: readableTitle,
        updatedAt: baseTime - 60_000,
      },
    ]);
    const sessionsWithoutDerivedTitle = chatSessionListResponse([
      {
        key: initialKey,
        kind: "direct",
        label: initialKey,
        displayName: initialKey,
        updatedAt: baseTime,
      },
      {
        key,
        kind: "direct",
        label: key,
        displayName: key,
        updatedAt: baseTime - 60_000,
      },
    ]);
    const gateway = await installMockGateway(page, {
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      methodResponses: {
        "sessions.list": {
          cases: [
            { match: { includeDerivedTitles: true }, response: sessionsWithDerivedTitle },
            { match: {}, response: sessionsWithoutDerivedTitle },
          ],
        },
      },
      sessionKey: initialKey,
    });

    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, initialKey));
      const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
      await row.locator("a.sidebar-recent-session__link").click();
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list", rosterMatch);
          return requests.map((request) => request.params);
        })
        .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
      const label = row.locator(".sidebar-recent-session__name");
      const link = row.locator("a.sidebar-recent-session__link");
      const tree = row.locator("..");
      const list = tree.locator("..");
      await expect.poll(() => label.textContent()).toBe(readableTitle);
      expect(await list.getAttribute("role")).toBe("list");
      expect(await tree.getAttribute("role")).toBe("listitem");
      expect(await row.getAttribute("role")).toBeNull();
      expect(await row.getAttribute("aria-label")).toBeNull();
      expect(await link.getAttribute("aria-label")).toBeNull();
      expect(await link.getAttribute("aria-current")).toBe("page");
      expect(await link.getAttribute("aria-describedby")).toBeNull();
      expect(await link.ariaSnapshot()).toContain(`link "${readableTitle}"`);
      await captureSessionAccessibilityProof(suite, page, "after-derived-title");

      const listCountBeforePatch = (await gateway.getRequests("sessions.list", rosterMatch)).length;
      await row.hover();
      await row.getByRole("button", { name: "Pin session" }).click();

      const patchRequest = await gateway.waitForRequest("sessions.patch");
      expect(requireRecord(patchRequest.params)).toMatchObject({
        key,
        pinned: true,
      });
      await expect
        .poll(async () => {
          const requests = await gateway.getRequests("sessions.list", rosterMatch);
          return requests.slice(listCountBeforePatch).map((request) => request.params);
        })
        .toContainEqual(expect.objectContaining({ includeDerivedTitles: true }));
      await expect.poll(() => label.textContent()).toBe(readableTitle);
      expect(await link.getAttribute("aria-current")).toBe("page");
      expect(await link.ariaSnapshot()).toContain(`link "${readableTitle}"`);
      await captureSessionAccessibilityProof(suite, page, "after-patch-refresh");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
