import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";
import {
  captureSidebarUiProof,
  captureSettingsSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar settings mocked Gateway E2E");

suite.define(() => {
  it("dismisses an open font picker before exiting Settings with Escape", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      await page.keyboard.press("Control+Shift+,");
      const { sidebar } = await waitForControlUiSettingsTakeover(page);
      const picker = page.locator("#settings-font-chat");
      await picker.click();
      const selected = picker.locator("wa-option:state(selected)");
      await selected.waitFor({ state: "visible" });
      const selectedValue = await selected.getAttribute("value");
      await page.keyboard.press("ArrowDown");
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/settings/appearance");
      await expect.poll(() => picker.getAttribute("open")).toBeNull();
      expect(await selected.getAttribute("value")).toBe(selectedValue);
      expect(
        await picker.locator('input[role="combobox"]').evaluate((input) => input.matches(":focus")),
      ).toBe(true);
      await sidebar.locator(".settings-sidebar__item").first().focus();
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it.each([
    { state: "open sidebar", collapseSidebar: false, nativeWebChrome: false },
    { state: "closed sidebar", collapseSidebar: true, nativeWebChrome: false },
    { state: "native web chrome", collapseSidebar: false, nativeWebChrome: true },
  ])("keeps Inbox out of Settings after $state", async (testCase) => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    if (testCase.nativeWebChrome) {
      await installNativeWebChrome(page);
    }
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      if (testCase.collapseSidebar) {
        await page.locator(".sidebar-brand__collapse").click();
        await page.locator(".shell--nav-collapsed").waitFor();
      }
      const chatInbox = page.locator(
        testCase.collapseSidebar
          ? ".sidebar-attention--floating .sidebar-issues-button"
          : "openclaw-app-sidebar .sidebar-issues-button",
      );
      await chatInbox.waitFor({ state: "visible" });

      await page.keyboard.press("Control+Shift+,");
      await waitForControlUiSettingsTakeover(page);
      expect(await page.locator(".sidebar-issues-button").count()).toBe(0);
      await captureSidebarUiProof(
        suite,
        page,
        `settings-without-inbox-${testCase.state.replaceAll(" ", "-")}.png`,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps Gateway access fields editable by their visible labels", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      await page.goto(`${suite.server.baseUrl}settings/connection`);

      const gatewayUrl = page.getByLabel("WebSocket URL", { exact: true });
      const gatewayToken = page.getByLabel("Gateway Token", { exact: true });
      const password = page.getByLabel("Password (not stored)", { exact: true });
      const sessionKey = page.getByLabel("Default Session Key", { exact: true });

      for (const input of [gatewayUrl, gatewayToken, password, sessionKey]) {
        await input.waitFor({ state: "visible" });
        expect(await input.isEditable()).toBe(true);
      }

      await gatewayUrl.fill("ws://gateway.example.test:18789");
      await gatewayToken.fill("browser-proof-token");
      await password.fill("browser-proof-password");
      await sessionKey.fill("browser-proof-session");

      expect(await gatewayUrl.inputValue()).toBe("ws://gateway.example.test:18789");
      expect(await gatewayToken.inputValue()).toBe("browser-proof-token");
      expect(await password.inputValue()).toBe("browser-proof-password");
      expect(await sessionKey.inputValue()).toBe("browser-proof-session");

      await page.getByRole("button", { name: "Toggle password visibility", exact: true }).click();
      expect(await password.getAttribute("type")).toBe("text");
      expect(await password.inputValue()).toBe("browser-proof-password");
      expect(await password.isEditable()).toBe(true);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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
        suite,
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
        suite,
        settingsSidebar,
        `settings-search-scrolled-${mode.replaceAll(" ", "-")}.png`,
      );
    } finally {
      await suite.closeBrowserContext(context);
    }
  });
});
