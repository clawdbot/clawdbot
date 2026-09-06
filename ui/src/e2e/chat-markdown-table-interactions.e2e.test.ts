import fs from "node:fs";
import path from "node:path";
import { chromium, type Browser } from "playwright";
import { beforeEach, afterAll, beforeAll, describe, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import {
  canRunPlaywrightChromium,
  captureControlUiE2eFailureDiagnostics,
  controlUiSessionUrl,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const captureProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
let artifactDir: string;
beforeEach(() => {
  if (captureProof) {
    artifactDir = createControlUiE2eArtifactDir("chat-markdown-table-interactions");
  }
});

const wideTable = `| Service | Owner | Region | Status | Version | Deploy | Incidents | Notes |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Gateway | Platform | eu-west-1 | Healthy | 2026.8.18 | Complete | 0 | [Long operational note that keeps this column wide](https://example.com/table-reference) |`;

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI Markdown table interactions", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it.each(["chat", "assistant panel"])(
    "contains overflow and preserves copy, fullscreen focus, and web links in %s",
    async (surface) => {
      const context = await browser.newContext({
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 800, width: surface === "chat" ? 760 : 1280 },
        ...(captureProof ? { recordVideo: { dir: artifactDir } } : {}),
      });
      await context.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: new URL(server.baseUrl).origin,
      });
      await context.route("https://example.com/table-reference", (route) =>
        route.fulfill({ contentType: "text/html", body: "<h1>Table reference</h1>" }),
      );
      const page = await context.newPage();
      await installMockGateway(page, {
        ...(surface === "assistant panel"
          ? {
              sessions: [
                { key: "agent:main:main", label: "Main", kind: "direct", updatedAt: Date.now() },
              ],
              featureMethods: [
                "chat.metadata",
                "chat.startup",
                "chat.history",
                "chat.send",
                "openclaw.chat",
                "openclaw.chat.history",
              ],
              methodResponses: {
                "sessions.list": {
                  cases: [
                    // Main is the only session and does not match this palette query.
                    {
                      match: { search: "Ask OpenClaw" },
                      response: { count: 0, sessions: [] },
                    },
                  ],
                },
                "openclaw.chat": {
                  sessionId: "table-proof",
                  reply: "Ready to help.",
                  action: "none",
                },
                "openclaw.chat.history": {
                  turns: [{ role: "assistant", text: wideTable, at: 1_700_000_101_000 }],
                },
              },
            }
          : {}),
        historyMessages: [
          {
            role: "assistant",
            content: [{ type: "text", text: wideTable }],
            timestamp: Date.now(),
            __openclaw: { id: "assistant-table", seq: 1 },
          },
        ],
      });

      try {
        await page.goto(`${server.baseUrl}chat`);
        if (surface === "assistant panel") {
          await page.locator(".sidebar-brand__search").click();
          await page.getByPlaceholder("Search chats and commands…").fill("Ask OpenClaw");
          await page.getByRole("option", { name: "Ask OpenClaw", exact: true }).click();
        }
        const bubble = page.locator(
          surface === "chat" ? '[data-entry-id="assistant-table"]' : ".custodian__messages",
        );
        const shell = bubble.locator(".markdown-table");
        const viewport = shell.locator(".markdown-table__viewport");
        const copy = shell.getByRole("button", { name: "Copy table" });
        const expand = shell.getByRole("button", { name: "Expand table" });
        await shell.waitFor({ state: "visible" });
        await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
        expect(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1,
          ),
        ).toBe(true);

        await viewport.evaluate((element) => {
          element.scrollLeft = Math.max(1, (element.scrollWidth - element.clientWidth) / 2);
          element.dispatchEvent(new Event("scroll"));
        });
        await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-left");
        await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");

        await copy.click();
        await expect
          .poll(() => page.evaluate(() => navigator.clipboard.readText()))
          .toContain("Service\tOwner\tRegion\tStatus\tVersion\tDeploy\tIncidents\tNotes");

        await expand.focus();
        const inlineTable = shell.locator("table");
        const inlineHeader = inlineTable.locator("th").first();
        const inlineCell = inlineTable.locator("td").first();
        await expand.dblclick();
        const dialog = page.locator(".markdown-table-dialog");
        await dialog.waitFor({ state: "visible" });
        expect(await page.locator(".markdown-table-modal").count()).toBe(1);
        const fullscreenTable = dialog.locator("table");
        const fullscreenHeader = fullscreenTable.locator("th").first();
        const fullscreenCell = fullscreenTable.locator("td").first();
        expect(await fullscreenTable.textContent()).toContain("Gateway");
        const tableProperties = [
          "background-color",
          "border-collapse",
          "border-top-width",
          "box-shadow",
        ] as const;
        const cellProperties = [
          "background-color",
          "border-right-width",
          "border-bottom-color",
          "overflow-wrap",
          "white-space",
          "word-break",
        ] as const;
        const readStyles = async (locator: typeof inlineTable, properties: readonly string[]) =>
          locator.evaluate((element, propertyNames) => {
            const styles = getComputedStyle(element);
            return Object.fromEntries(
              propertyNames.map((property) => {
                const value = styles.getPropertyValue(property);
                if (!value) {
                  throw new Error(`Missing computed value for ${property}`);
                }
                return [property, value];
              }),
            );
          }, properties);
        expect(await readStyles(fullscreenTable, tableProperties)).toEqual(
          await readStyles(inlineTable, tableProperties),
        );
        expect(await readStyles(fullscreenHeader, cellProperties)).toEqual(
          await readStyles(inlineHeader, cellProperties),
        );
        expect(await readStyles(fullscreenCell, cellProperties)).toEqual(
          await readStyles(inlineCell, cellProperties),
        );
        if (captureProof) {
          await page.screenshot({
            animations: "disabled",
            path: path.join(artifactDir, "dark-fullscreen.png"),
          });
        }

        // The viewport margin stays outside the dialog while its opening scale changes.
        await page.mouse.click(8, 8);
        await expect.poll(() => dialog.count()).toBe(0);
        await expect
          .poll(() => expand.evaluate((element) => element === document.activeElement))
          .toBe(true);

        const sourceUrl = page.url();
        await expand.click();
        await dialog.waitFor({ state: "visible" });
        const popupPromise = context.waitForEvent("page");
        await dialog
          .getByRole("link", { name: "Long operational note that keeps this column wide" })
          .press("Enter");
        const popup = await popupPromise;
        await popup.getByRole("heading", { name: "Table reference" }).waitFor();
        expect(popup.url()).toBe("https://example.com/table-reference");
        expect(page.url()).toBe(sourceUrl);
        await popup.close();
        await dialog.waitFor({ state: "detached" });

        await expand.click();
        await dialog.waitFor({ state: "visible" });
        await page.keyboard.press("Escape");
        await expect.poll(() => dialog.count()).toBe(0);
        await expect
          .poll(() => expand.evaluate((element) => element === document.activeElement))
          .toBe(true);
      } catch (error) {
        await captureControlUiE2eFailureDiagnostics(page, {
          error: error instanceof Error ? error : new Error(String(error)),
          label: `Markdown table in ${surface}`,
        });
        throw error;
      } finally {
        if (captureProof) {
          await page.screenshot({ path: path.join(artifactDir, "final-state.png") });
        }
        await context.close();
      }
    },
  );

  it("releases an expanded table when browser history retires its retained pane", async () => {
    const alphaKey = "agent:main:dashboard:table-alpha";
    const betaKey = "agent:main:dashboard:table-beta";
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(captureProof ? { recordVideo: { dir: artifactDir } } : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      sessionKey: alphaKey,
      sessions: [
        { key: alphaKey, label: "Alpha table" },
        { key: betaKey, label: "Beta table" },
      ],
      featureMethods: ["chat.metadata", "chat.startup", "chat.history", "chat.send"],
      sessionTranscripts: Object.fromEntries(
        [
          [alphaKey, betaKey, "history-alpha", "Alpha"],
          [betaKey, alphaKey, "history-beta", "Beta"],
        ].map(([key, other, id, name]) => [
          key,
          {
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: `| Name | Task |\n| --- | --- |\n| ${name} table | ${other} |`,
                  },
                ],
                timestamp: 1,
                __openclaw: { id, seq: 1 },
              },
            ],
          },
        ]),
      ),
    });
    try {
      await page.goto(controlUiSessionUrl(server.baseUrl, alphaKey));
      const alpha = page.locator('[data-entry-id="history-alpha"]');
      await alpha.waitFor({ state: "visible" });
      const alphaPane = await alpha.evaluateHandle((entry) => entry.closest("openclaw-chat-pane"));
      const timeOrigin = await page.evaluate(() => performance.timeOrigin);

      await alpha.locator(`a[data-session-key="${betaKey}"]`).click();
      await page.waitForURL(controlUiSessionUrl(server.baseUrl, betaKey));
      const beta = page.locator('[data-entry-id="history-beta"]');
      await beta.waitFor({ state: "visible" });
      const betaPane = await beta.evaluateHandle((entry) => entry.closest("openclaw-chat-pane"));
      const expectRetainedPanes = async (activeIndex: number) => {
        const states = await Promise.all(
          [alphaPane, betaPane].map((pane) =>
            pane.evaluate((element) => ({
              connected: element?.isConnected,
              hidden: element?.getAttribute("aria-hidden"),
              inert: element?.hasAttribute("inert"),
            })),
          ),
        );
        expect(states).toEqual(
          [0, 1].map((index) => ({
            connected: true,
            hidden: String(index !== activeIndex),
            inert: index !== activeIndex,
          })),
        );
        expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
      };
      await expectRetainedPanes(1);

      await beta.getByRole("button", { name: "Expand table" }).click();
      const dialog = page.locator(".markdown-table-dialog");
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.textContent()).toContain("Beta table");
      await page.goBack();
      await page.waitForURL(controlUiSessionUrl(server.baseUrl, alphaKey));
      await expect
        .poll(() => alphaPane.evaluate((pane) => pane?.getAttribute("aria-hidden")))
        .toBe("false");
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "history-back-to-alpha.png") });
      }
      await expect.poll(() => dialog.count()).toBe(0);
      await expectRetainedPanes(0);

      const alphaExpand = alpha.getByRole("button", { name: "Expand table" });
      await alphaExpand.click();
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.count()).toBe(1);
      expect(await dialog.textContent()).toContain("Alpha table");
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
      await expect
        .poll(() => alphaExpand.evaluate((element) => element === document.activeElement))
        .toBe(true);

      await page.goForward();
      await page.waitForURL(controlUiSessionUrl(server.baseUrl, betaKey));
      await expect
        .poll(() => betaPane.evaluate((pane) => pane?.getAttribute("aria-hidden")))
        .toBe("false");
      await expectRetainedPanes(1);
      await beta.getByRole("button", { name: "Expand table" }).click();
      await dialog.waitFor({ state: "visible" });
      expect(await dialog.count()).toBe(1);
      expect(await dialog.textContent()).toContain("Beta table");
      await page.keyboard.press("Escape");
      await expect.poll(() => dialog.count()).toBe(0);
    } catch (error) {
      await captureControlUiE2eFailureDiagnostics(page, {
        error: error instanceof Error ? error : new Error(String(error)),
        label: "Expanded table across retained-pane browser history",
      });
      throw error;
    } finally {
      await context.close();
    }
  });

  it("restores overflow affordances when a retained table viewport narrows", async () => {
    const context = await browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { width: 1280, height: 900 },
      ...(captureProof ? { recordVideo: { dir: artifactDir } } : {}),
    });
    const page = await context.newPage();
    await installMockGateway(page, {
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: `| Service | Status | Reference |
| --- | --- | --- |
| Gateway | Healthy | ABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890123456789 |`,
            },
          ],
          timestamp: 1,
          __openclaw: { id: "retained-table", seq: 1 },
        },
      ],
    });
    try {
      await page.goto(`${server.baseUrl}chat`);
      const shell = page.locator('[data-entry-id="retained-table"] .markdown-table');
      const viewport = shell.locator(".markdown-table__viewport");
      await shell.waitFor({ state: "visible" });
      expect(
        await viewport.evaluate((element) => element.scrollWidth <= element.clientWidth + 1),
      ).toBe(true);
      expect(await shell.getAttribute("class")).not.toContain("can-scroll-right");

      const retained = await page
        .locator("openclaw-chat-pane")
        .first()
        .evaluate((pane) => {
          const table = pane.querySelector(".markdown-table");
          const parent = pane.parentNode!;
          const next = pane.nextSibling;
          pane.remove();
          parent.insertBefore(pane, next);
          return pane.querySelector(".markdown-table") === table;
        });
      expect(retained).toBe(true);
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      // Resize only the viewport: a whole-app responsive render also resynchronizes tables.
      await viewport.evaluate((element) => {
        element.style.maxWidth = "360px";
      });
      expect(
        await viewport.evaluate((element) => element.scrollWidth - element.clientWidth),
      ).toBeGreaterThan(1);
      await expect.poll(() => shell.getAttribute("class")).toContain("can-scroll-right");
      if (captureProof) {
        await page.screenshot({ path: path.join(artifactDir, "retained-viewport-overflow.png") });
      }
    } finally {
      await context.close();
    }
  });

  it.each([
    { surface: "chat", link: "file", activation: "click" },
    { surface: "chat", link: "session", activation: "Space" },
    { surface: "assistant panel", link: "session", activation: "click" },
    { surface: "assistant panel", link: "session", activation: "Enter" },
  ])(
    "opens a $link from an expanded table in $surface with $activation",
    async ({ surface, link, activation }) => {
      const sourceKey = "agent:main:dashboard:table-source";
      const targetKey = "agent:main:dashboard:table-target";
      const table = `| File | Task |
| --- | --- |
| \`src/ready.ts:2\` | ${targetKey} |`;
      const context = await browser.newContext({
        colorScheme: "dark",
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1280 },
        ...(captureProof
          ? { recordVideo: { dir: artifactDir, size: { height: 900, width: 1280 } } }
          : {}),
      });
      const page = await context.newPage();
      page.setDefaultTimeout(15_000);
      const gateway = await installMockGateway(page, {
        sessionKey: sourceKey,
        featureMethods: [
          "chat.metadata",
          "chat.startup",
          "chat.history",
          "chat.send",
          "progressCard.get",
          "openclaw.chat",
          "openclaw.chat.history",
        ],
        sessions: [
          { key: sourceKey, label: "Table links" },
          { key: targetKey, label: "Linked task" },
        ],
        sessionTranscripts: {
          [sourceKey]: {
            messages: [
              {
                role: "assistant",
                content: [
                  {
                    type: "text",
                    text: table,
                  },
                ],
                timestamp: 1,
                __openclaw: { id: "table-links", seq: 1 },
              },
            ],
          },
          [targetKey]: {
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: "Linked task reached." }],
                timestamp: 2,
                __openclaw: { id: "linked-task", seq: 1 },
              },
            ],
          },
        },
        methodResponses: {
          "openclaw.chat": { sessionId: "table-links", reply: "Ready to help.", action: "none" },
          "openclaw.chat.history": {
            turns: [{ role: "assistant", text: table, at: 1_700_000_101_000 }],
          },
          "progressCard.get": { card: null },
          "sessions.files.get": {
            root: "/workspace",
            sessionKey: sourceKey,
            file: {
              content: "// Workspace file\nexport const ready = true;\n",
              kind: "read",
              missing: false,
              name: "ready.ts",
              path: "src/ready.ts",
              workspacePath: "src/ready.ts",
            },
          },
        },
      });
      const selector =
        link === "file" ? 'a[data-file-path="src/ready.ts"]' : `a[data-session-key="${targetKey}"]`;
      const activate = async (scope: ReturnType<typeof page.locator>) => {
        const anchor = scope.locator(selector);
        if (activation === "click") {
          await anchor.click();
        } else {
          await anchor.press(activation);
        }
      };
      const expectDestination = async (fileRequestCount: number) => {
        if (link === "file") {
          await expect
            .poll(async () => (await gateway.getRequests("sessions.files.get")).length)
            .toBe(fileRequestCount);
          await expect
            .poll(() => page.locator(".sidebar-file-view").textContent())
            .toContain("export const ready = true;");
        } else {
          await expect.poll(() => page.url()).toBe(controlUiSessionUrl(server.baseUrl, targetKey));
          await page.locator('[data-entry-id="linked-task"]').waitFor({ state: "visible" });
        }
      };
      const openSource = async () => {
        await page.goto(controlUiSessionUrl(server.baseUrl, sourceKey));
        if (surface === "assistant panel") {
          await page.locator(".sidebar-footer-bar__home").click();
          await page
            .locator("openclaw-assistant-panel")
            .getByRole("button", { name: "Ask OpenClaw", exact: true })
            .click();
        }
      };
      try {
        await openSource();
        const shell = page.locator(
          surface === "chat"
            ? '[data-entry-id="table-links"] .markdown-table'
            : ".custodian__messages .markdown-table",
        );
        await activate(shell);
        await expectDestination(1);
        if (captureProof) {
          await page.screenshot({ path: path.join(artifactDir, "inline-control.png") });
        }
        await openSource();
        await shell.getByRole("button", { name: "Expand table" }).click();
        const dialog = page.locator(".markdown-table-dialog");
        await dialog.waitFor({ state: "visible" });
        if (link === "session" && surface === "chat") {
          const sessionLink = dialog.locator(selector);
          const close = dialog.getByRole("button", { name: "Close expanded table" });
          await sessionLink.focus();
          await page.keyboard.press("Tab");
          await expect
            .poll(() => close.evaluate((element) => element === document.activeElement))
            .toBe(true);
          await page.keyboard.press("Shift+Tab");
          await expect
            .poll(() => sessionLink.evaluate((element) => element === document.activeElement))
            .toBe(true);
          if (captureProof) {
            await page.screenshot({ path: path.join(artifactDir, "tab-cycle.png") });
          }
          await gateway.setMethodResponse("progressCard.get", {
            card: {
              markdown: "[Open build log](https://example.com/build)",
              revision: 1,
              sessionKey: targetKey,
              updatedAt: 1,
            },
          });
          await gateway.emitGatewayEvent("progressCard.changed", {
            revision: 1,
            sessionKey: targetKey,
          });
          const progressLink = page
            .locator(".session-progress-hovercard")
            .getByRole("link", { name: "Open build log" });
          await progressLink.waitFor({ state: "visible" });
          if (captureProof) {
            await page.screenshot({ path: path.join(artifactDir, "progress-before-tab.png") });
          }
          await page.keyboard.press("Tab");
          await expect
            .poll(() => page.locator(".session-progress-hovercard a:focus").count())
            .toBe(1);
          expect(await dialog.isVisible()).toBe(true);
          if (captureProof) {
            await page.screenshot({ path: path.join(artifactDir, "progress-after-tab.png") });
          }
          await page.keyboard.press("Shift+Tab");
          await expect
            .poll(() => sessionLink.evaluate((element) => element === document.activeElement))
            .toBe(true);
          const popupPromise = context.waitForEvent("page");
          await sessionLink.click({ modifiers: ["ControlOrMeta"] });
          const popup = await popupPromise;
          await expect.poll(() => popup.url()).toBe(controlUiSessionUrl(server.baseUrl, targetKey));
          await popup.close();
          expect(page.url()).toBe(controlUiSessionUrl(server.baseUrl, sourceKey));
          await dialog.waitFor({ state: "detached" });
          await shell.getByRole("button", { name: "Expand table" }).click();
          await dialog.waitFor({ state: "visible" });
        }
        if (captureProof) {
          await page.screenshot({ path: path.join(artifactDir, "expanded-before-action.png") });
        }
        const before = (await gateway.getRequests("sessions.files.get")).length;
        await activate(dialog);
        await expectDestination(before + 1);
        await dialog.waitFor({ state: "detached" });
      } finally {
        if (captureProof) {
          await page.screenshot({ path: path.join(artifactDir, "expanded-after-action.png") });
          fs.writeFileSync(
            path.join(artifactDir, "actions.json"),
            JSON.stringify(
              {
                surface,
                link,
                activation,
                url: page.url(),
                requests: (await gateway.getRequests()).filter((request) =>
                  ["sessions.files.get", "chat.startup", "chat.history"].includes(request.method),
                ),
                expandedTableVisible: await page
                  .getByRole("dialog", { name: "Expanded table" })
                  .isVisible(),
              },
              null,
              2,
            ) + "\n",
          );
        }
        await context.close();
      }
    },
  );
});
