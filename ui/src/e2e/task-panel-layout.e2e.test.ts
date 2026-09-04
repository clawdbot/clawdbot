import type { Server as HttpServer } from "node:http";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
import type { Locator, Page } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildWidgetDocument } from "../../../src/canvas/wrap.js";
import { buildBoardWidgetSandboxPath } from "../../../src/gateway/board-sandbox.js";
import { createSandboxHostHttpServer } from "../../../src/gateway/mcp-app-sandbox-http.js";
import { controlUiSessionUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { dockChatSidePanel } from "./chat-side-panel.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI task panel layout",
  startServerBeforeBrowser: true,
});
const sessionKey = "agent:main:task-panel-layout";
let sandbox: HttpServer;
let sandboxPort: number;

async function regionSize(region: Locator, dimension: "width" | "height" = "width") {
  return region.evaluate((element, axis) => element.getBoundingClientRect()[axis], dimension);
}

function widgetInput(page: Page): Locator {
  return page.frameLocator(".board-widget__frame").frameLocator("iframe").locator("#widget-note");
}

suite.define(() => {
  beforeAll(async () => {
    sandbox = createSandboxHostHttpServer();
    await new Promise<void>((resolve) => {
      sandbox.listen(0, "127.0.0.1", resolve);
    });
    const address = sandbox.address();
    if (!address || typeof address === "string") {
      throw new Error("Dashboard sandbox did not bind");
    }
    sandboxPort = address.port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => {
      sandbox?.close(() => resolve());
    });
  });

  it("preserves live content and saved geometry across main, dock, focus, and narrow layouts", async () => {
    await suite.withPage(
      {
        viewport: { width: 1440, height: 1000 },
        permissions: ["local-network-access"],
      },
      async ({ page }) => {
        const widgetHtml = buildWidgetDocument(
          "Panel continuity",
          '<label>Widget note <input id="widget-note"></label><script>globalThis.documentIdentity=crypto.randomUUID();</script>',
        );
        await page.route("**/__openclaw__/board/**", (route) =>
          route.fulfill({ status: 200, contentType: "text/html", body: widgetHtml }),
        );
        const gateway = await installMockGateway(page, {
          sessionKey,
          terminalEnabled: true,
          communityInvite: false,
          featureMethods: ["board.get", "chat.metadata", "chat.startup", "terminal.open"],
          historyMessages: [
            { role: "assistant", content: "Arrange the dashboard beside this chat." },
          ],
          methodResponses: {
            "board.get": {
              sessionKey,
              revision: 1,
              tabs: [{ tabId: "main", title: "Main", position: 0 }],
              widgets: [
                {
                  name: "continuity",
                  tabId: "main",
                  title: "Panel continuity",
                  contentKind: "html",
                  sizeW: 12,
                  sizeH: 4,
                  heightMode: "fixed",
                  position: 0,
                  grantState: "none",
                  revision: 1,
                  instanceId: "continuity-instance",
                  frameUrl: `${new URL(suite.server.baseUrl).origin}/__openclaw__/board/${encodeURIComponent(sessionKey)}/continuity/index.html?bt=ticket`,
                  viewTicket: "ticket",
                  viewTicketTtlMs: 1_200_000,
                  viewGeneration: "0123456789abcdef0123456789abcdef",
                  sandboxUrl: buildBoardWidgetSandboxPath({ grantState: "none" }),
                  sandboxPort,
                },
              ],
            },
          },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, sessionKey, "dashboard"));
        const input = widgetInput(page);
        await input.fill("Keep this unsaved widget input");
        const documentIdentity = await input.evaluate((element) =>
          Reflect.get(element.ownerDocument.defaultView!, "documentIdentity"),
        );
        const composer = page.locator(".agent-chat__composer-combobox textarea");
        await composer.fill("Keep this chat draft");
        const chat = page.locator(".sidebar-region__primary");
        const dashboard = page.locator('[data-panel-slot="dashboard"]');
        const mainHeader = page.locator('[data-region-header="main"]');
        const sideHeader = page.locator('[data-region-header="side"]');
        const swap = page.locator(".chat-panel-swap");
        const layoutMenu = page.locator(".chat-panel-layout-menu");
        const width = await regionSize(dashboard);
        const expectContinuity = async () => {
          expect(
            await input.evaluate((element) =>
              Reflect.get(element.ownerDocument.defaultView!, "documentIdentity"),
            ),
          ).toBe(documentIdentity);
          expect(await input.inputValue()).toBe("Keep this unsaved widget input");
          expect(await composer.inputValue()).toBe("Keep this chat draft");
        };
        const expectSwapLabel = async (label: string) => {
          await expect.poll(() => swap.getAttribute("aria-label")).toBe(label);
          await page.mouse.move(0, 0);
          await swap.hover();
          const tooltip = swap.locator("..").locator("wa-tooltip .tooltip-content");
          await tooltip.waitFor();
          expect(await tooltip.textContent()).toBe(label);
          await page.mouse.move(0, 0);
        };

        expect(await swap.count()).toBe(1);
        expect(await layoutMenu.count()).toBe(1);
        expect(await page.getByRole("button", { name: "Layout", exact: true }).count()).toBe(1);
        await expectSwapLabel("Swap Chat and Dashboard");
        await chat.evaluate((element) => {
          const initialWidth = element.getBoundingClientRect().width;
          element.parentElement!.addEventListener("openclaw-sidebar-geometry-commit", (event) => {
            if (element.getBoundingClientRect().width !== initialWidth) {
              element.setAttribute(
                "data-swap-width-invalidated",
                element.getAttribute("data-swap-width-invalidated") ??
                  String((event as CustomEvent).detail.widthChanged),
              );
            }
          });
        });
        await swap.click();
        await expect.poll(() => dashboard.getAttribute("data-region")).toBe("main");
        await expectSwapLabel("Swap Dashboard and Chat");
        await expect.poll(() => regionSize(chat)).toBeCloseTo(width, 0);
        expect(await chat.getAttribute("data-swap-width-invalidated")).toBe("true");
        for (const dock of ["left", "bottom", "right"] as const) {
          await dockChatSidePanel(page, dock);
          const chatBox = await chat.boundingBox();
          const dashboardBox = await dashboard.boundingBox();
          expect(chatBox).not.toBeNull();
          expect(dashboardBox).not.toBeNull();
          if (dock === "bottom") {
            expect(chatBox!.y).toBeGreaterThan(dashboardBox!.y);
          } else {
            expect(chatBox!.x < dashboardBox!.x).toBe(dock === "left");
            expect(chatBox!.width).toBeCloseTo(width, 0);
          }
          await mainHeader.getByRole("button", { name: "Focus", exact: true }).click();
          await chat.waitFor({ state: "hidden" });
          expect(await swap.isVisible()).toBe(false);
          await expectContinuity();
          await mainHeader.getByRole("button", { name: "Restore split", exact: true }).click();
          await chat.waitFor();
          await swap.waitFor();
          await expectContinuity();
        }
        await dockChatSidePanel(page, "left");
        const divider = page.getByRole("separator", { name: "Resize side panel" });
        await divider.focus();
        await page.keyboard.press("ArrowRight");
        await expect.poll(() => regionSize(chat)).toBeGreaterThan(width);
        const resizedWidth = await regionSize(chat);
        await sideHeader.getByRole("button", { name: "Close", exact: true }).click();
        await chat.waitFor({ state: "hidden" });
        expect(await swap.isVisible()).toBe(false);
        await mainHeader.getByRole("button", { name: "Focus", exact: true }).click();
        await mainHeader.getByRole("button", { name: "Restore split", exact: true }).click();
        await chat.waitFor();
        await expectContinuity();
        await sideHeader.getByRole("button", { name: "Close", exact: true }).click();
        await chat.waitFor({ state: "hidden" });
        await mainHeader.getByRole("button", { name: "Side panel", exact: true }).click();
        await chat.waitFor();
        await expectSwapLabel("Swap Dashboard and Chat");
        await expectContinuity();
        expect(await regionSize(chat)).toBeCloseTo(resizedWidth, 0);

        await page.reload();
        await page
          .locator('.sidebar-region--left [data-panel-slot="dashboard"][data-region="main"]')
          .waitFor();
        await expect.poll(() => regionSize(chat)).toBeCloseTo(resizedWidth, 0);
        await input.waitFor();
        await sideHeader.getByRole("button", { name: "Add side panel tab", exact: true }).click();
        await sideHeader
          .locator(".side-panel-type-menu wa-dropdown-item")
          .filter({ hasText: "Terminal" })
          .click();
        const terminal = page.locator("openclaw-terminal-panel");
        await terminal.locator(".tp-host canvas").waitFor();
        await expect.poll(() => gateway.getRequests("terminal.open")).toHaveLength(1);
        await expectSwapLabel("Swap Dashboard and Terminal");
        await swap.click();
        await page.locator('[data-panel-slot="terminal"][data-region="main"]').waitFor();
        await expectSwapLabel("Swap Terminal and Dashboard");
        await dockChatSidePanel(page, "right");
        await mainHeader.getByRole("button", { name: "Focus", exact: true }).click();
        await mainHeader.getByRole("button", { name: "Restore split", exact: true }).click();
        expect(await gateway.getRequests("terminal.open")).toHaveLength(1);
        expect(await gateway.getRequests("terminal.close")).toHaveLength(0);

        await page.setViewportSize({ width: 400, height: 900 });
        await page.locator(".sidebar-region--narrow").waitFor();
        await expect
          .poll(
            async () =>
              asOptionalRecord((await gateway.getRequests("terminal.resize")).at(-1)?.params)?.cols,
          )
          .toBeGreaterThan(30);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(400);
        expect(await layoutMenu.isVisible()).toBe(false);
        for (const control of [
          mainHeader.getByRole("button", { name: "Focus", exact: true }),
          mainHeader.getByRole("button", { name: "Side panel", exact: true }),
          swap,
          sideHeader.getByRole("button", { name: "Close", exact: true }),
        ]) {
          await control.click({ trial: true });
          const box = await control.boundingBox();
          expect(box?.x).toBeGreaterThanOrEqual(0);
          expect(box!.x + box!.width).toBeLessThanOrEqual(400);
        }
        await swap.click();
        await expect.poll(() => dashboard.getAttribute("data-region")).toBe("main");
        await expect
          .poll(() => swap.getAttribute("aria-label"))
          .toBe("Swap Dashboard and Terminal");
        await mainHeader.getByRole("button", { name: "Focus", exact: true }).click();
        await mainHeader.getByRole("button", { name: "Restore split", exact: true }).click();
        await terminal.locator(".tp-host canvas").waitFor();
      },
    );
  }, 120_000);
});
