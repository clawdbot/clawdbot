import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionRow,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it("sets and clears session colors through desktop and compact menus", async () => {
    const key = "agent:main:color-proof";
    const now = Date.now();
    const proofDir = "/tmp/session-color-web-proof";
    const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const context = await suite.browser.newContext({
      locale: "en-US",
      colorScheme: "dark",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
      recordVideo: capture ? { dir: proofDir, size: { width: 1440, height: 900 } } : undefined,
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      sessionKey: key,
      historyMessages: [
        {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "The design review is ready. Use session colors to keep related conversations easy to find.",
            },
          ],
        },
      ],
      methodResponses: {
        "sessions.list": sessionsListResponse([
          sessionRow(key, "Design review", now),
          { ...sessionRow("agent:main:research", "Research notes", now - 60_000), color: "green" },
          {
            ...sessionRow("agent:main:release", "Release checklist", now - 120_000),
            color: "orange",
          },
        ]),
        "sessions.patch": {},
        "sessions.catalog.list": {
          catalogs: [
            {
              id: "claude",
              label: "Claude Code",
              capabilities: { continueSession: false, archive: false },
              hosts: [
                {
                  hostId: "gateway:claude",
                  label: "Gateway",
                  kind: "gateway",
                  connected: true,
                  sessions: [
                    {
                      threadId: "imported",
                      name: "Imported CLI notes",
                      status: "stored",
                      color: "cyan",
                      canContinue: false,
                      canArchive: false,
                    },
                  ],
                },
              ],
            },
          ],
        },
      },
      featureMethods: ["chat.metadata", "chat.startup", "sessions.patch", "sessions.catalog.list"],
    });
    const shot = async (name: string) => {
      if (capture) {
        await mkdir(proofDir, { recursive: true });
        await page.screenshot({
          path: path.join(proofDir, name),
          animations: "disabled",
          fullPage: true,
        });
      }
    };
    const row = page.locator(`.sidebar-recent-session[data-session-key="${key}"]`);
    const dot = page.locator(".chat-pane__session-title .session-color-dot");
    const stripe = () =>
      row.evaluate((element) => getComputedStyle(element, "::before").backgroundColor);
    try {
      await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
      await row.waitFor({ state: "visible" });
      expect(await row.getAttribute("class")).not.toContain("sidebar-recent-session--colored");
      expect(await dot.count()).toBe(0);
      await shot("before-no-color.png");
      const imported = page
        .locator("[data-catalog-session-key]")
        .filter({ hasText: "Imported CLI notes" });
      await imported.waitFor({ state: "visible" });
      expect(await imported.getAttribute("style")).toContain("--session-color-cyan");

      await row.click({ button: "right" });
      await openSessionMenuSubmenu(page, "Color");
      await page.getByRole("menuitemradio", { name: "Purple", exact: true }).click();
      const set = await waitForPatch(
        gateway,
        (params) => params.key === key && params.color === "purple",
      );
      expect(set.params).toMatchObject({ key, color: "purple" });
      await expect
        .poll(() => row.getAttribute("class"))
        .toContain("sidebar-recent-session--colored");
      await dot.waitFor({ state: "visible" });
      expect(await dot.getAttribute("aria-label")).toBe("Session color: Purple");
      expect(await row.getAttribute("style")).toContain("--session-color-purple");
      expect(await row.evaluate((element) => getComputedStyle(element, "::before").width)).toBe(
        "3px",
      );
      const darkStripe = await stripe();
      expect(darkStripe).not.toBe("rgba(0, 0, 0, 0)");
      await row.hover();
      await row.getByRole("button", { name: "Open session menu" }).click();
      await openSessionMenuSubmenu(page, "Color");
      await shot("after-dark-menu.png");
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await expect.poll(stripe).not.toBe(darkStripe);
      await shot("after-light-menu.png");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, color: null });
      await expect.poll(() => dot.count()).toBe(0);
      await expect
        .poll(() => row.getAttribute("class"))
        .not.toContain("sidebar-recent-session--colored");
      expect(await row.getAttribute("style")).toBeNull();

      await page.setViewportSize({ width: 560, height: 900 });
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Color", exact: true }).click();
      await page.getByRole("menuitemradio", { name: "Blue", exact: true }).click();
      await waitForPatch(gateway, (params) => params.key === key && params.color === "blue");
      await expect.poll(() => dot.getAttribute("aria-label")).toBe("Session color: Blue");
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Color", exact: true }).click();
      await shot("after-compact-menu.png");
      await page.getByRole("menuitemradio", { name: "Default", exact: true }).click();
      await waitForPatch(gateway, (params) => params.key === key && params.color === null);
      await expect.poll(() => dot.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
