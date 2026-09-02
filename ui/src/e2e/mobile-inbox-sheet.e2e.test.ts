import path from "node:path";
import { beforeEach, expect, it } from "vitest";
import { createControlUiE2eArtifactDir } from "../test-helpers/control-ui-e2e-artifacts.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const artifactRoot = process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim();
let artifactDir: string | undefined;
beforeEach(() => {
  artifactDir = artifactRoot
    ? createControlUiE2eArtifactDir("mobile-inbox-sheet", artifactRoot)
    : undefined;
});
const viewport = { width: 390, height: 844 };
const suite = createControlUiE2eSuite({
  name: "Control UI mobile Inbox sheet",
  startServerBeforeBrowser: true,
  trackBrowserContexts: true,
});

async function setTheme(page: import("playwright").Page, theme: "dark" | "light") {
  await page.emulateMedia({ colorScheme: theme });
  await page.evaluate((nextTheme) => {
    const root = document.documentElement;
    root.dataset.themeMode = nextTheme;
    root.dataset.themeResolved = nextTheme;
    root.classList.toggle("wa-dark", nextTheme === "dark");
    root.classList.toggle("wa-light", nextTheme === "light");
    root.style.colorScheme = nextTheme;
  }, theme);
}

suite.define(() => {
  it("rises from the bottom with a continuous header and compact close control", async () => {
    const results: Array<{
      closeBackground: string;
      closeBorderRadius: string;
      closeBorderWidth: string;
      closeHeight: number;
      closeWidth: number;
      easing: string;
      sheetBackground: string;
      headerBackground: string;
      listBackground: string;
      startTop: number;
      finalTop: number;
      duration: number;
      tabTrackWidth: number;
      tabWidths: number[];
    }> = [];

    for (const theme of ["light", "dark"] as const) {
      const context = await suite.newBrowserContext({
        colorScheme: theme,
        deviceScaleFactor: 1,
        locale: "en-US",
        recordVideo: artifactDir
          ? { dir: path.join(artifactDir, "video"), size: viewport }
          : undefined,
        reducedMotion: "no-preference",
        serviceWorkers: "block",
        viewport,
      });
      const page = await context.newPage();
      await installMockGateway(page, { operatorScopes: ["operator.read", "operator.write"] });
      await page.goto(`${suite.server.baseUrl}activity`);
      await setTheme(page, theme);
      await page.getByRole("button", { name: "Expand sidebar" }).click();
      await page.locator(".nav-drawer").waitFor();
      await page.locator(".sidebar-issues-button:visible").click();
      const panel = page.locator("#sidebar-issues-panel");
      await panel.waitFor({ state: "attached" });

      const result = await panel.evaluate(async (element) => {
        const animation = element.getAnimations().find((candidate) => {
          const effect = candidate.effect;
          return effect instanceof KeyframeEffect && effect.target === element;
        });
        if (!animation?.effect) {
          throw new Error("Expected the mobile Inbox sheet entrance animation");
        }
        const timing = animation.effect.getComputedTiming();
        // Playwright can reach this sample after the entrance animation has advanced.
        // Rewind the real effect so start geometry does not depend on runner load.
        animation.pause();
        animation.currentTime = 0;
        const startTop = element.getBoundingClientRect().top;
        animation.play();
        await animation.finished;
        const close = element.querySelector<HTMLElement>(".sidebar-issues-panel__mobile-close")!;
        const header = element.querySelector<HTMLElement>(".sidebar-issues-panel__header")!;
        const list = element.querySelector<HTMLElement>(".sidebar-issues-panel__list-wrap")!;
        const tabTrack = element
          .querySelector<HTMLElement>(".sidebar-issues-panel__tabs")!
          .shadowRoot!.querySelector<HTMLElement>(".tabs")!;
        const tabs = Array.from(element.querySelectorAll<HTMLElement>("wa-tab.hub-tab"));
        return {
          closeBackground: getComputedStyle(close).backgroundColor,
          closeBorderRadius: getComputedStyle(close).borderRadius,
          closeBorderWidth: getComputedStyle(close).borderTopWidth,
          closeHeight: close.getBoundingClientRect().height,
          closeWidth: close.getBoundingClientRect().width,
          duration: Number(timing.duration),
          easing: getComputedStyle(element).animationTimingFunction,
          finalTop: element.getBoundingClientRect().top,
          sheetBackground: getComputedStyle(element).backgroundColor,
          headerBackground: getComputedStyle(header).backgroundColor,
          listBackground: getComputedStyle(list).backgroundColor,
          startTop,
          tabTrackWidth: tabTrack.getBoundingClientRect().width,
          tabWidths: tabs.map((tab) => tab.getBoundingClientRect().width),
        };
      });
      results.push(result);

      if (artifactDir) {
        const previousStyle = await page.addStyleTag({
          content: `
            .shell--mobile-nav .sidebar-issues-panel { background: var(--bg-elevated); }
            .shell--mobile-nav .sidebar-issues-panel__mobile-close {
              width: 30px;
              height: 30px;
              border: 0;
              background: transparent;
            }
            .shell--mobile-nav .sidebar-issues-panel__tabs::part(tabs) {
              gap: var(--space-1);
              padding-inline: 8px;
            }
            .shell--mobile-nav .sidebar-issues-panel__tabs wa-tab.hub-tab {
              min-width: auto;
              flex: 0 1 auto;
            }
            .shell--mobile-nav .sidebar-issues-panel__tabs wa-tab.hub-tab::part(base) {
              width: auto;
              justify-content: normal;
            }
            .shell--mobile-nav .sidebar-issues-panel__list-wrap { background: transparent; }
          `,
        });
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, `mobile-inbox-before-${theme}.png`),
        });
        const dismissShownBefore = await page
          .locator(".sidebar-issues-panel__dismiss-shown")
          .evaluate((element) => ({
            fontSize: getComputedStyle(element).fontSize,
            height: element.getBoundingClientRect().height,
            lineHeight: getComputedStyle(element).lineHeight,
          }));
        await previousStyle.evaluate((element) => element.parentNode?.removeChild(element));
        await page.screenshot({
          animations: "disabled",
          fullPage: true,
          path: path.join(artifactDir, `mobile-inbox-after-${theme}.png`),
        });
        const dismissShownAfter = await page
          .locator(".sidebar-issues-panel__dismiss-shown")
          .evaluate((element) => ({
            fontSize: getComputedStyle(element).fontSize,
            height: element.getBoundingClientRect().height,
            lineHeight: getComputedStyle(element).lineHeight,
          }));
        expect(dismissShownAfter).toEqual(dismissShownBefore);
      }
      await suite.closeBrowserContext(context);
    }

    for (const result of results) {
      expect(result.startTop).toBeGreaterThan(result.finalTop + 100);
      expect(result.duration).toBeGreaterThanOrEqual(200);
      expect(result.duration).toBeLessThan(300);
      expect(result.easing).toBe("cubic-bezier(0.32, 0.72, 0, 1)");
      expect(result.sheetBackground).toBe(result.headerBackground);
      expect(result.headerBackground).not.toBe(result.listBackground);
      expect(result.closeWidth).toBe(36);
      expect(result.closeHeight).toBe(36);
      expect(result.closeBorderWidth).toBe("1px");
      expect(result.closeBorderRadius).toBe("9999px");
      expect(result.closeBackground).not.toBe("rgba(0, 0, 0, 0)");
      expect(result.tabWidths).toHaveLength(4);
      for (const tabWidth of result.tabWidths) {
        expect(tabWidth).toBeCloseTo(result.tabTrackWidth / 4, 1);
      }
    }
  });

  it("removes sheet movement when reduced motion is requested", async () => {
    await suite.withPage(
      {
        colorScheme: "dark",
        locale: "en-US",
        reducedMotion: "reduce",
        serviceWorkers: "block",
        viewport,
      },
      async ({ page }) => {
        await installMockGateway(page, { operatorScopes: ["operator.read", "operator.write"] });
        await page.goto(`${suite.server.baseUrl}activity`);
        await page.getByRole("button", { name: "Expand sidebar" }).click();
        await page.locator(".nav-drawer").waitFor();
        await page.locator(".sidebar-issues-button:visible").click();
        const panel = page.locator("#sidebar-issues-panel");
        await panel.waitFor();
        expect(await panel.evaluate((element) => getComputedStyle(element).animationName)).toBe(
          "none",
        );
      },
    );
  });
});
