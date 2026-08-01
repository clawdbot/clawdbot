import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import {
  captureSettingsSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar settings mocked Gateway E2E");

suite.define(() => {
  it.each([
    { mode: "standalone", webChrome: false },
    { mode: "native web chrome", webChrome: true },
  ])("aligns the settings search with navigation rows in $mode", async ({ mode, webChrome }) => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 620, width: 1440 },
    });
    const page = await context.newPage();
    if (webChrome) {
      await page.addInitScript(() => {
        const nativeWindow = window as Window & {
          __OPENCLAW_NATIVE_WEB_CHROME__?: boolean;
          __OPENCLAW_NATIVE_HISTORY__?: { canGoBack: boolean; canGoForward: boolean };
        };
        nativeWindow["__OPENCLAW_NATIVE_WEB_CHROME__"] = true;
        nativeWindow["__OPENCLAW_NATIVE_HISTORY__"] = {
          canGoBack: false,
          canGoForward: false,
        };
        const stamp = () =>
          document.documentElement.classList.add(
            "openclaw-native-macos",
            "openclaw-native-web-chrome",
          );
        if (document.documentElement) {
          stamp();
        } else {
          document.addEventListener("DOMContentLoaded", stamp);
        }
      });
    }
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/general`);
      const { search: settingsSearchInput, sidebar: settingsSidebar } =
        await waitForControlUiSettingsTakeover(page);
      const settingsSearchShell = settingsSidebar.locator(".settings-sidebar__search");
      const settingsNav = settingsSidebar.locator(".settings-sidebar__nav");
      const firstSettingsLink = settingsSidebar.locator(".settings-sidebar__item").first();
      await expect
        .poll(() =>
          page
            .locator("html")
            .evaluate((element) => element.classList.contains("openclaw-native-web-chrome")),
        )
        .toBe(webChrome);
      await captureSettingsSidebarUiProof(
        settingsSidebar,
        `settings-search-alignment-${mode.replaceAll(" ", "-")}.png`,
      );
      await expect
        .poll(async () => {
          const [searchBox, firstLinkBox] = await Promise.all([
            settingsSearchShell.boundingBox(),
            firstSettingsLink.boundingBox(),
          ]);
          return searchBox && firstLinkBox ? Math.round(searchBox.x - firstLinkBox.x) : null;
        })
        .toBe(0);
      await expect
        .poll(async () => {
          const [searchBox, navBox] = await Promise.all([
            settingsSearchInput.boundingBox(),
            settingsNav.boundingBox(),
          ]);
          return searchBox && navBox
            ? Math.round(navBox.y - (searchBox.y + searchBox.height))
            : null;
        })
        .toBe(8);
      await settingsNav.evaluate((element) => {
        element.scrollTop = Math.min(48, element.scrollHeight - element.clientHeight);
        element.dispatchEvent(new Event("scroll"));
      });
      await expect
        .poll(() =>
          settingsSearchShell.evaluate((element) =>
            element.classList.contains("settings-sidebar__search--scrolled"),
          ),
        )
        .toBe(true);
      await expect
        .poll(() =>
          settingsSearchShell.evaluate((element) => getComputedStyle(element, "::after").opacity),
        )
        .toBe("1");
      await captureSettingsSidebarUiProof(
        settingsSidebar,
        `settings-search-scrolled-${mode.replaceAll(" ", "-")}.png`,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
