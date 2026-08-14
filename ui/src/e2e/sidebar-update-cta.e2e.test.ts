import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import {
  captureUnionProof,
  createSidebarFooterProofSuite,
  openSidebarFooterProofPage,
  setSidebarProofTheme,
} from "./sidebar-footer-proof.test-support.ts";

const UPDATE_AVAILABLE = {
  channel: "stable",
  currentVersion: "1.0.0",
  latestVersion: "2.0.0",
} as const;

const UPDATE_RUN_RESPONSE = {
  ok: true,
  restart: null,
  result: { after: { version: "2.0.0" }, status: "ok" },
} as const;

async function surfaceStyle(locator: Locator) {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      backgroundColor: style.backgroundColor,
      boxShadow: style.boxShadow,
      cursor: style.cursor,
      transform: style.transform,
    };
  });
}

async function installLongPortugueseUpdateCopy(page: Page) {
  const translations = JSON.stringify({
    updates: {
      sidebar: {
        available: "Uma nova versão do OpenClaw está disponível",
        action: "Atualizar",
      },
    },
  });
  await page.addInitScript(() => {
    localStorage.setItem("openclaw.i18n.locale", "pt-BR");
  });
  await page.route("**/src/i18n/locales/pt-BR.ts*", (route) => {
    return route.fulfill({
      contentType: "application/javascript",
      body: `export const pt_BR = ${translations};`,
    });
  });
}

const suite = createSidebarFooterProofSuite("Control UI sidebar update CTA E2E");

suite.define(() => {
  it.each(["light", "dark"] as const)(
    "keeps the informational update strip static in %s mode",
    async (theme) => {
      const opened = await openSidebarFooterProofPage(suite, {
        methodResponses: { "update.run": UPDATE_RUN_RESPONSE },
      });
      try {
        const { gateway, page, sidebar } = opened;
        const footer = sidebar.locator(".sidebar-footer-bar");
        await setSidebarProofTheme(page, theme);
        await page.mouse.move(0, 0);

        expect(await sidebar.locator(".sidebar-update-card").count()).toBe(0);
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-no-update-footer.png`, [
          footer,
        ]);

        await gateway.emitGatewayEvent("update.available", {
          updateAvailable: UPDATE_AVAILABLE,
        });
        const card = sidebar.locator(".sidebar-update-card");
        const availability = sidebar.locator(".sidebar-update-card__availability");
        const copy = availability.locator(".sidebar-update-card__text");
        const cta = availability.getByRole("button", { name: "Update", exact: true });
        await availability.waitFor();

        expect(await card.getAttribute("role")).toBe("status");
        expect(await card.getAttribute("tabindex")).toBeNull();
        expect(await availability.getAttribute("role")).toBeNull();
        expect((await copy.textContent())?.trim()).toBe("New version available");
        expect(await availability.getByRole("button").count()).toBe(1);
        expect(await sidebar.locator(".sidebar-update-card__dismiss").count()).toBe(0);
        expect(
          await availability.locator(".sidebar-update-card__icon").evaluate((element) => {
            const icon = element.getBoundingClientRect();
            const svg = element.querySelector("svg")?.getBoundingClientRect();
            const style = getComputedStyle(element);
            const infoProbe = document.createElement("span");
            infoProbe.style.color = "var(--info)";
            document.body.append(infoProbe);
            const infoColor = getComputedStyle(infoProbe).color;
            infoProbe.remove();
            return {
              backgroundColor: style.backgroundColor,
              usesInfoColor: style.color === infoColor,
              size: [icon.width, icon.height],
              svgSize: svg ? [svg.width, svg.height] : null,
            };
          }),
        ).toEqual({
          backgroundColor: "rgba(0, 0, 0, 0)",
          usesInfoColor: true,
          size: [26, 26],
          svgSize: [16, 16],
        });

        const restSurface = await surfaceStyle(availability);
        const restCta = await surfaceStyle(cta);
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-update-rest.png`, [
          availability,
          footer,
        ]);

        await copy.hover();
        await copy.click();
        expect(await page.getByRole("dialog").count()).toBe(0);
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        expect(await surfaceStyle(availability)).toEqual(restSurface);
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-container-click.png`, [
          availability,
          footer,
        ]);

        await cta.hover();
        await expect.poll(() => surfaceStyle(cta)).not.toEqual(restCta);
        expect(await surfaceStyle(availability)).toEqual(restSurface);
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-cta-hover.png`, [
          availability,
          footer,
          cta,
        ]);

        await page.mouse.move(0, 0);
        await cta.focus();
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-cta-focus.png`, [
          availability,
          footer,
          cta,
        ]);

        await page.keyboard.press("Enter");
        const dialog = page.getByRole("dialog");
        await dialog.waitFor();
        expect(await dialog.getAttribute("aria-label")).toBe("Update Gateway");
        expect(await gateway.getRequests("update.run")).toHaveLength(0);
        await captureUnionProof(page, "sidebar-update-cta", `${theme}-confirmation.png`, [
          availability,
          footer,
          dialog,
        ]);
      } finally {
        await suite.closeBrowserContext(opened.context);
      }
    },
  );

  it("keeps long Portuguese update copy inside the supported sidebar width", async () => {
    const opened = await openSidebarFooterProofPage(
      suite,
      {
        methodResponses: { "update.run": UPDATE_RUN_RESPONSE },
        updateAvailable: UPDATE_AVAILABLE,
      },
      installLongPortugueseUpdateCopy,
    );
    try {
      const { page, sidebar } = opened;
      await setSidebarProofTheme(page, "light");

      const availability = sidebar.locator(".sidebar-update-card__availability");
      const copy = availability.locator(".sidebar-update-card__text");
      const cta = availability.getByRole("button", { name: "Atualizar", exact: true });
      await expect
        .poll(() => copy.textContent())
        .toBe("Uma nova versão do OpenClaw está disponível");
      expect(await page.locator("html").getAttribute("lang")).toBe("pt-BR");
      expect(
        await availability.evaluate((element) => {
          const container = element.getBoundingClientRect();
          const text = element.querySelector(".sidebar-update-card__text");
          const action = element.querySelector(".sidebar-update-card__cta");
          if (!(text instanceof HTMLElement) || !(action instanceof HTMLElement)) {
            return null;
          }
          const textBox = text.getBoundingClientRect();
          const actionBox = action.getBoundingClientRect();
          return {
            containerFits: element.scrollWidth <= element.clientWidth,
            textTruncates: text.scrollWidth > text.clientWidth,
            textInside: textBox.left >= container.left && textBox.right <= container.right,
            actionInside: actionBox.left >= container.left && actionBox.right <= container.right,
          };
        }),
      ).toEqual({
        containerFits: true,
        textTruncates: true,
        textInside: true,
        actionInside: true,
      });
      await captureUnionProof(page, "sidebar-update-cta", "light-update-pt-BR.png", [
        availability,
        sidebar.locator(".sidebar-footer-bar"),
        cta,
      ]);
    } finally {
      await suite.closeBrowserContext(opened.context);
    }
  });
});
