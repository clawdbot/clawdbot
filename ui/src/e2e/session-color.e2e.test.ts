import path from "node:path";
import { expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { createControlUiSessionRow as sessionRow } from "../test-helpers/control-ui-session-fixtures.ts";
import {
  controlUiSessionUrl,
  createSessionManagementE2eSuite,
  installMockGateway,
  openSessionMenuSubmenu,
  sessionsListResponse,
  waitForPatch,
} from "./session-management.test-support.ts";

const suite = createSessionManagementE2eSuite();

suite.define(() => {
  it.each(["sidebar", "header", "compact"] as const)(
    "keeps appearance controls keyboard-accessible in the %s menu",
    async (surface) => {
      const key = "agent:main:appearance-keyboard";
      const context = await suite.browser.newContext({
        viewport: { width: surface === "compact" ? 560 : 1440, height: 900 },
      });
      const page = await context.newPage();
      const gateway = await installMockGateway(page, {
        sessionKey: key,
        methodResponses: {
          "sessions.list": sessionsListResponse([
            sessionRow(key, "Keyboard appearance", Date.now()),
          ]),
          "sessions.patch": {},
        },
        featureMethods: ["chat.metadata", "chat.startup", "sessions.patch"],
      });
      try {
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, key));
        const trigger =
          surface === "sidebar"
            ? page.getByRole("button", {
                name: "Open session menu: Keyboard appearance",
                exact: true,
              })
            : page.locator(".chat-header-session-menu__trigger");
        await trigger.focus();
        await page.keyboard.press("Enter");
        if (surface === "compact") {
          await expect
            .poll(() =>
              page
                .locator("openclaw-chat-header-session-menu > wa-dropdown > wa-dropdown-item:focus")
                .count(),
            )
            .toBe(1);
          const appearance = page.getByRole("menuitem", { name: "Icon & color", exact: true });
          const index = await appearance.evaluate((element) =>
            [...(element.parentElement?.children ?? [])]
              .filter(
                (item) =>
                  item.localName === "wa-dropdown-item" &&
                  item.getAttribute("aria-disabled") !== "true",
              )
              .indexOf(element),
          );
          await page.keyboard.press("Home");
          for (let step = 0; step < index; step += 1) {
            await page.keyboard.press("ArrowDown");
          }
          await page.keyboard.press("Enter");
        } else {
          await openSessionMenuSubmenu(page, "Icon & color");
        }
        const picker = page.locator(".session-menu__appearance:visible");
        await expect
          .poll(() =>
            picker.evaluate((element) => {
              const iconPicker = element.querySelector(".session-menu__icon-picker");
              const iconsLabel = element.querySelectorAll(".session-menu__icon-section-label")[2];
              return [
                iconPicker ? getComputedStyle(iconPicker).marginTop : null,
                iconsLabel ? getComputedStyle(iconsLabel).marginTop : null,
              ];
            }),
          )
          .toEqual(["4px", "4px"]);
        const focused = () =>
          page.evaluate(
            () =>
              document
                .querySelector(".session-menu__appearance :focus")
                ?.getAttribute("aria-label") ?? null,
          );
        await expect.poll(focused).toBe("Default");
        await page.keyboard.press("Tab");
        await expect.poll(focused).toBe("Red");
        await page.keyboard.press("Enter");
        await waitForPatch(gateway, (params) => params.key === key && params.color === "red");
        await page.keyboard.press("Tab");
        await expect.poll(focused).toBe("Blue");
        await page.keyboard.press("Shift+Tab");
        await expect.poll(focused).toBe("Red");
        for (let index = 0; index < 8; index += 1) {
          await page.keyboard.press("Tab");
        }
        await expect.poll(() => picker.locator(".session-menu__icon-choice:focus").count()).toBe(1);
        await page.keyboard.press("ArrowRight");
        await page.keyboard.press("Enter");
        await waitForPatch(gateway, (params) => params.key === key && params.icon === "🚀");
        await page.keyboard.press("Tab");
        const reset = picker.getByRole("button", { name: "Reset to default", exact: true });
        await expect
          .poll(() =>
            reset.evaluate(
              (element) => element.previousElementSibling?.getAttribute("role") ?? null,
            ),
          )
          .toBe("separator");
        await expect
          .poll(() =>
            reset.evaluateAll((elements) =>
              elements.some((element) => element === document.activeElement),
            ),
          )
          .toBe(true);
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("ArrowUp");
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("ArrowLeft");
        await page.keyboard.press("Enter");
        const custom = picker.getByRole("textbox", { name: "Custom emoji", exact: true });
        await expect
          .poll(() => custom.evaluate((element) => element === document.activeElement))
          .toBe(true);
        await page.keyboard.insertText("✨");
        await page.keyboard.press("Tab");
        await page.keyboard.press("Enter");
        await waitForPatch(gateway, (params) => params.key === key && params.icon === "✨");
        await page.keyboard.press("Shift+Tab");
        await page.keyboard.press("Escape");
        await expect.poll(focused).toBe("Custom emoji…");
        await page.keyboard.press("Tab");
        await expect
          .poll(() =>
            reset.evaluateAll((elements) =>
              elements.some((element) => element === document.activeElement),
            ),
          )
          .toBe(true);
        await page.keyboard.press("Enter");
        await waitForPatch(
          gateway,
          (params) => params.key === key && params.color === null && params.icon === null,
        );
        await page.keyboard.press("Tab");
        await expect.poll(() => picker.count()).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  it("sets and clears session colors through desktop and compact menus", async () => {
    const key = "agent:main:color-proof";
    const now = Date.now();
    const capture = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
    const proofDir = capture
      ? createControlUiE2eArtifactDir("session-color-web-proof", "/tmp/session-color-web-proof")
      : "";
    const context = await suite.browser.newContext({
      locale: "en-US",
      colorScheme: "dark",
      serviceWorkers: "block",
      viewport: { width: 1440, height: 900 },
      recordVideo: capture ? { dir: proofDir, size: { width: 1440, height: 900 } } : undefined,
    });
    const page = await context.newPage();
    const designReview = sessionRow(key, "Design review", now);
    const sessions = [
      designReview,
      { ...sessionRow("agent:main:research", "Research notes", now - 60_000), color: "green" },
      { ...sessionRow("agent:main:release", "Release checklist", now - 120_000), color: "orange" },
    ];
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
        "sessions.list": sessionsListResponse(sessions),
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
      await openSessionMenuSubmenu(page, "Icon & color");
      await page.getByRole("button", { name: "Purple", exact: true }).click();
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
      // Both choices persist in the same open picker, without reopening the menu.
      const picker = page.locator("openclaw-session-menu .session-menu__appearance");
      await picker.getByRole("button", { name: "book", exact: true }).click();
      await waitForPatch(gateway, (params) => params.key === key && params.icon === "book");
      await expect
        .poll(() =>
          picker.getByRole("button", { name: "book", exact: true }).getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect
        .poll(() =>
          picker.getByRole("button", { name: "Purple", exact: true }).getAttribute("aria-pressed"),
        )
        .toBe("true");
      await shot("after-dark-menu.png");
      await page.emulateMedia({ colorScheme: "light" });
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("light");
      await expect.poll(stripe).not.toBe(darkStripe);
      await shot("after-light-menu.png");
      await page.keyboard.press("Escape");
      await page.keyboard.press("Escape");

      Object.assign(designReview, { label: "Design review refreshed", color: null });
      await gateway.setMethodResponse("sessions.list", sessionsListResponse(sessions));
      await gateway.emitGatewayEvent("sessions.changed", { sessionKey: key, color: null });
      // Only the roster response carries this label; wait for that render so a
      // transient event-only clear cannot hide a stale color restored by refresh.
      await row.getByText("Design review refreshed", { exact: true }).waitFor();
      expect(await row.getAttribute("style")).toBeNull();
      await expect.poll(() => dot.count()).toBe(0);
      await expect
        .poll(() => row.getAttribute("class"))
        .not.toContain("sidebar-recent-session--colored");

      await page.setViewportSize({ width: 560, height: 900 });
      await page.locator(".chat-header-session-menu__trigger").click();
      await page.getByRole("menuitem", { name: "Icon & color", exact: true }).click();
      await page.getByRole("button", { name: "Blue", exact: true }).click();
      await waitForPatch(gateway, (params) => params.key === key && params.color === "blue");
      await expect.poll(() => dot.getAttribute("aria-label")).toBe("Session color: Blue");
      await shot("after-compact-menu.png");
      await page.getByRole("button", { name: "Reset to default", exact: true }).click();
      await waitForPatch(
        gateway,
        (params) => params.key === key && params.color === null && params.icon === null,
      );
      await expect.poll(() => dot.count()).toBe(0);
    } finally {
      await context.close();
    }
  });
});
