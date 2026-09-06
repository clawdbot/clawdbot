import path from "node:path";
import { expect, it } from "vitest";
import {
  installMockGateway,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { deviceSystemInfo } from "../test-helpers/devices-fixtures.ts";
import { installNativeWebChrome } from "./native-nav.test-support.ts";
import {
  captureSidebarUiProof,
  captureSettingsSidebarUiProof,
  createSidebarCustomizationSuite,
} from "./sidebar-customization.test-support.ts";

const suite = createSidebarCustomizationSuite("Control UI sidebar settings mocked Gateway E2E");

const FAILED_CRON_RESPONSE = {
  jobs: [
    {
      id: "failed-settings-transition",
      name: "Failed settings transition",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "every", everyMs: 60_000 },
      sessionTarget: "isolated",
      wakeMode: "now",
      payload: { kind: "agentTurn", message: "test" },
      state: { lastRunStatus: "error", lastError: "Provider request failed" },
    },
  ],
  snapshotRevision: "settings-transition-attention",
  total: 1,
  offset: 0,
  limit: 50,
  hasMore: false,
  nextOffset: null,
};

const MISSING_AUTH_RESPONSE = {
  ts: 1,
  providers: [
    {
      provider: "openai",
      displayName: "OpenAI",
      status: "missing",
      profiles: [],
    },
  ],
};

suite.define(() => {
  it("defers hidden Inbox inventory and shows fresh cron attention on return", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    await page.clock.setFixedTime(Date.now());
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const badge = page.locator("openclaw-app-sidebar .sidebar-issues-button__count");
      await expect.poll(() => badge.textContent()).toBe("2");
      await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
      await page.getByText("Failed settings transition", { exact: true }).waitFor();
      await captureSidebarUiProof(suite, page, "inbox-before-hidden-events.png");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await gateway.setMethodResponse("cron.list", {
        ...FAILED_CRON_RESPONSE,
        jobs: [{ ...FAILED_CRON_RESPONSE.jobs[0], name: "Failure while away" }],
      });
      for (let index = 0; index < 20; index++) {
        await gateway.emitGatewayEvent("cron", { action: "finished", jobId: `hidden-${index}` });
      }
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        expect(await gateway.getRequests(method)).toHaveLength(1);
      }
      await page.getByText("Failed settings transition", { exact: true }).waitFor();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await page.getByText("Failure while away", { exact: true }).waitFor();
      expect(await badge.textContent()).toBe("2");
      for (const method of ["cron.list", "cron.status"]) {
        expect(await gateway.getRequests(method)).toHaveLength(2);
      }
      expect(await gateway.getRequests("models.authStatus")).toHaveLength(1);
      await captureSidebarUiProof(suite, page, "inbox-after-hidden-events.png");

      await gateway.deferNext("cron.list");
      await gateway.emitGatewayEvent("cron", { action: "finished" });
      await gateway.waitForRequest("cron.list", { after: 2 });
      await page.getByRole("button", { name: "Dismiss Failure while away", exact: true }).click();
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      // The first event invalidating this pending inventory arrives while hidden.
      await gateway.emitGatewayEvent("cron", { action: "finished" });
      await gateway.resolveDeferred("cron.list", { ...FAILED_CRON_RESPONSE, jobs: [], total: 0 });
      expect(await gateway.getRequests("cron.list")).toHaveLength(3);
      await gateway.deferNext("cron.list");
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          value: "visible",
        });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await gateway.waitForRequest("cron.list", { after: 3 });
      await gateway.resolveDeferred("cron.list", {
        ...FAILED_CRON_RESPONSE,
        jobs: [
          FAILED_CRON_RESPONSE.jobs[0],
          { ...FAILED_CRON_RESPONSE.jobs[0], id: "fresh-job", name: "Fresh visible warning" },
        ],
        total: 2,
      });
      await page.getByText("Fresh visible warning", { exact: true }).waitFor();
      expect(await page.locator('[data-attention-kind="cronFailed"]').count()).toBe(1);
      expect(await badge.textContent()).toBe("2");
      expect(await gateway.getRequests("cron.list")).toHaveLength(4);
      await captureSidebarUiProof(suite, page, "inbox-dismissal-preserved-on-return.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("refreshes stale auth attention after returning while the first auth read is pending", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const now = Date.now();
    await page.clock.setFixedTime(now);
    const gateway = await installMockGateway(page, {
      heldMethods: ["models.authStatus"],
      methodResponses: { "cron.list": FAILED_CRON_RESPONSE },
    });
    try {
      await page.goto(`${suite.server.baseUrl}new`);
      const badge = page.locator("openclaw-app-sidebar .sidebar-issues-button__count");
      await expect.poll(() => badge.textContent()).toBe("1");
      await gateway.waitForRequest("models.authStatus");
      await page.clock.setFixedTime(now + 60_001);
      await page.evaluate(() => {
        for (let index = 0; index < 20; index++) {
          document.dispatchEvent(new Event("visibilitychange"));
        }
      });
      expect(await gateway.getRequests("models.authStatus")).toHaveLength(1);
      await gateway.deferNext("models.authStatus");
      await gateway.resolveDeferred("models.authStatus", MISSING_AUTH_RESPONSE);
      await gateway.waitForRequest("models.authStatus", { after: 1 });
      await expect.poll(() => badge.textContent()).toBe("2");
      await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
      const authWarning = page.locator('[data-attention-kind="modelAuthExpired"]');
      await authWarning.waitFor({ state: "visible" });
      await gateway.resolveDeferred("models.authStatus", { ts: now + 60_001, providers: [] });
      await authWarning.waitFor({ state: "hidden" });
      await expect.poll(() => badge.textContent()).toBe("1");
      expect(await gateway.getRequests("models.authStatus")).toHaveLength(2);
      for (const index of [1, 2]) {
        await page.clock.setFixedTime(now + 60_001 + 30_001 * index);
        await gateway.setMethodResponse("cron.list", {
          ...FAILED_CRON_RESPONSE,
          jobs: [{ ...FAILED_CRON_RESPONSE.jobs[0], name: `Recent automation ${index}` }],
        });
        await gateway.emitGatewayEvent("cron", { action: "finished" });
        await page.getByText(`Recent automation ${index}`, { exact: true }).waitFor();
        expect(await gateway.getRequests("models.authStatus")).toHaveLength(2);
      }
      await gateway.setMethodResponse("models.authStatus", MISSING_AUTH_RESPONSE);
      await page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
      await authWarning.waitFor({ state: "visible" });
      expect(await gateway.getRequests("models.authStatus")).toHaveLength(3);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("coalesces cron bursts without losing independently loaded Inbox attention", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      heldMethods: ["cron.list", "cron.status", "models.authStatus"],
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      await gateway.waitForRequest("cron.status");
      await gateway.waitForRequest("models.authStatus");
      for (let index = 0; index < 20; index++) {
        await gateway.emitGatewayEvent("cron", { action: "finished", jobId: `job-${index}` });
      }
      await captureSidebarUiProof(suite, page, "cron-burst-pending.png");
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        expect(await gateway.getRequests(method)).toHaveLength(1);
      }

      await gateway.resolveDeferred("models.authStatus");
      const badge = page.locator("openclaw-app-sidebar .sidebar-issues-button__count");
      await expect.poll(() => badge.textContent()).toBe("1");
      await gateway.resolveDeferred("cron.list");
      expect(await gateway.getRequests("cron.list")).toHaveLength(1);
      await gateway.deferNext("cron.list");
      await gateway.resolveDeferred("cron.status");
      await gateway.waitForRequest("cron.list", { after: 1 });
      await expect.poll(() => badge.textContent()).toBe("2");
      for (const method of ["cron.list", "cron.status"]) {
        expect(await gateway.getRequests(method)).toHaveLength(2);
      }
      await page.locator("openclaw-app-sidebar .sidebar-issues-button").click();
      await page.getByText("Failed settings transition", { exact: true }).waitFor();
      await gateway.setMethodResponse("cron.list", {
        ...FAILED_CRON_RESPONSE,
        jobs: [{ ...FAILED_CRON_RESPONSE.jobs[0], name: "Latest automation failure" }],
      });
      await gateway.emitGatewayEvent("cron", { action: "finished", jobId: "latest" });
      await gateway.resolveDeferred("cron.list");
      await gateway.waitForRequest("cron.list", { after: 2 });
      await page.getByText("Latest automation failure", { exact: true }).waitFor();
      for (const method of ["cron.list", "cron.status"]) {
        expect(await gateway.getRequests(method)).toHaveLength(3);
      }
      await captureSidebarUiProof(suite, page, "cron-burst-refreshed.png");
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

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

  it("keeps loaded Inbox attention through collapsed chat and Settings", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": FAILED_CRON_RESPONSE,
        "models.authStatus": MISSING_AUTH_RESPONSE,
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await page.locator(".new-session-page__message").waitFor({ state: "visible" });
      await page.locator(".sidebar-brand__collapse").click();
      const floatingInbox = page.locator(".sidebar-attention--floating");
      await expect
        .poll(() => floatingInbox.locator(".sidebar-issues-button__count").textContent())
        .toBe("2");

      await page.keyboard.press("Control+Shift+,");
      await waitForControlUiSettingsTakeover(page);
      expect(await page.locator("openclaw-sidebar-attention").count()).toBe(0);

      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      const restoredInbox = page.locator(".sidebar-attention--floating");
      await restoredInbox.waitFor({ state: "visible" });
      expect(await restoredInbox.locator(".sidebar-issues-button__count").textContent()).toBe("2");

      await gateway.setMethodResponse("cron.list", {
        ...FAILED_CRON_RESPONSE,
        jobs: [],
        total: 0,
      });
      await gateway.setMethodResponse("models.authStatus", { ts: 2, providers: [] });
      for (const method of ["cron.list", "cron.status", "models.authStatus"]) {
        await gateway.deferNext(method);
      }
      await page.keyboard.press("Control+Shift+,");
      await waitForControlUiSettingsTakeover(page);
      await page.locator('.settings-sidebar__item[href="/settings/connection"]').click();
      await page.getByLabel("Gateway Token", { exact: true }).fill("replacement-owner-token");
      await page.getByRole("button", { name: "Connect", exact: true }).click();
      await expect
        .poll(() =>
          page.evaluate(() => {
            const app = document.querySelector("openclaw-app") as HTMLElement & {
              runtime?: { context: { gateway: { snapshot: { phase: string } } } };
            };
            return app.runtime?.context.gateway.snapshot.phase;
          }),
        )
        .toBe("connected");
      await page.keyboard.press("Escape");
      await expect.poll(() => new URL(page.url()).pathname).toBe("/new");
      await page.locator(".sidebar-attention--floating .sidebar-issues-button").waitFor();
      expect(
        await page.locator(".sidebar-attention--floating .sidebar-issues-button__count").count(),
      ).toBe(0);
    } finally {
      await suite.closeBrowserContext(context);
    }
  });

  it("keeps one attention badge across expanded and collapsed presenters", async () => {
    const context = await suite.newBrowserContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "cron.list": { ...FAILED_CRON_RESPONSE, jobs: [], total: 0 },
        "models.authStatus": { ts: 1, providers: [] },
      },
    });

    try {
      await page.goto(`${suite.server.baseUrl}new`);
      await gateway.waitForRequest("cron.list");
      await expect
        .poll(() => page.locator("openclaw-app-sidebar .sidebar-issues-button__count").count())
        .toBe(0);

      await page.locator(".sidebar-brand__collapse").click();
      await page.locator(".sidebar-attention--floating .sidebar-issues-button").waitFor();
      await page.locator(".shell-chrome-controls__nav-toggle").click();
      await page.locator("openclaw-app-sidebar .sidebar-issues-button").waitFor();

      await gateway.setMethodResponse("cron.list", FAILED_CRON_RESPONSE);
      await gateway.emitGatewayEvent("cron", {
        action: "finished",
        completionStatus: "failed",
        error: "Provider request failed",
        jobId: "failed-settings-transition",
        status: "error",
      });
      await expect
        .poll(() =>
          page.locator("openclaw-app-sidebar .sidebar-issues-button__count").textContent(),
        )
        .toBe("1");

      await gateway.deferNext("cron.list");
      await gateway.deferNext("cron.status");
      await gateway.deferNext("models.authStatus");
      await page.locator(".sidebar-brand__collapse").click();
      await expect
        .poll(() =>
          page.locator(".sidebar-attention--floating .sidebar-issues-button__count").textContent(),
        )
        .toBe("1");
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
    const gateway = await installMockGateway(page, {
      featureMethods: ["system.info"],
      methodResponses: { "system.info": deviceSystemInfo },
    });

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

      await gateway.waitForRequest("system.info");
      const reads = (await gateway.getRequests("system.info")).length;
      const connections = (await gateway.getRequests("connect")).length;
      await page.getByRole("button", { name: "Toggle token visibility", exact: true }).click();
      await gateway.deferNext("connect");
      await gateway.closeLatest(1012, "synthetic reconnect");
      const notice = page.locator('.connection-action-block[role="status"]');
      await notice.waitFor();
      expect(await gatewayToken.getAttribute("type")).toBe("password");
      expect(await password.getAttribute("type")).toBe("password");
      await gateway.waitForRequest("connect", { after: connections });
      await gateway.resolveDeferred("connect");
      await notice.waitFor({ state: "hidden" });
      await gateway.waitForRequest("system.info", { after: reads });

      for (const [input, value] of [
        [gatewayUrl, "ws://gateway.example.test:18789"],
        [gatewayToken, "browser-proof-token"],
        [password, "browser-proof-password"],
        [sessionKey, "browser-proof-session"],
      ] as const) {
        expect(await input.inputValue()).toBe(value);
        expect(await input.isEditable()).toBe(true);
      }
      if (process.env.OPENCLAW_CAPTURE_UI_PROOF === "1") {
        await page.screenshot({
          animations: "disabled",
          path: path.join(suite.artifactDir, "gateway-draft-reconnected.png"),
        });
      }
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
