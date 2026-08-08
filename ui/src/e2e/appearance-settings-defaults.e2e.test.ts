// Control UI tests cover Appearance override provenance and restoring product defaults.
import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator, Page } from "playwright";
import { expect, it } from "vitest";
import { importCustomThemeFromUrl } from "../app/custom-theme.ts";
import {
  controlUiBundledGatewayUrl,
  controlUiBundledSettingsStorageKey,
  installMockGateway,
  waitForControlUiSettingsTakeover,
  type MockGatewayControls,
  type MockGatewayRequest,
} from "../test-helpers/control-ui-e2e.ts";
import { createTweakcnThemePayload } from "../test-helpers/custom-theme.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI Appearance defaults mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is not available at ${executablePath}. Run \`pnpm --dir ui exec playwright install --with-deps chromium\`, or set OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM=1 only when intentionally skipping this lane.`,
});

const captureUiProofEnabled = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const uiProofArtifactDir = path.join(
  process.cwd(),
  ".artifacts",
  "control-ui-e2e",
  "appearance-settings-defaults",
);
function settingsStorageKey(): string {
  return controlUiBundledSettingsStorageKey(suite.server.baseUrl);
}

function configResponse(prefs: Record<string, unknown>, hash: string) {
  const config = { ui: { prefs } };
  return {
    appliedConfigHash: hash,
    config,
    configRevisionHash: hash,
    hash,
    issues: [],
    raw: JSON.stringify(config),
    valid: true,
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  expect(value, label).toBeTruthy();
  expect(typeof value, label).toBe("object");
  expect(Array.isArray(value), label).toBe(false);
  return value as Record<string, unknown>;
}

function patchPrefs(request: MockGatewayRequest): Record<string, unknown> {
  const params = requireRecord(request.params, "config.patch params");
  expect(typeof params.raw).toBe("string");
  const parsed = requireRecord(JSON.parse(String(params.raw)), "config.patch raw");
  const ui = requireRecord(parsed.ui, "config.patch ui");
  return requireRecord(ui.prefs, "config.patch ui.prefs");
}

function settingsRow(page: Page, title: string): Locator {
  return page
    .locator(".settings-row")
    .filter({ has: page.locator(".settings-row__title", { hasText: title }) })
    .first();
}

async function selectValue(locator: Locator): Promise<string> {
  return locator.evaluate((element) =>
    String((element as HTMLElement & { value?: unknown }).value),
  );
}

async function waitForRequestCount(
  gateway: MockGatewayControls,
  method: string,
  count: number,
): Promise<void> {
  await expect
    .poll(async () => (await gateway.getRequests(method)).length, { timeout: 10_000 })
    .toBe(count);
}

async function resetSyncedPreference(options: {
  click: () => Promise<void>;
  expectedKey: string;
  gateway: MockGatewayControls;
  hash: string;
  remainingPrefs: Record<string, unknown>;
}): Promise<void> {
  const patchCount = (await options.gateway.getRequests("config.patch")).length;
  const configGetCount = (await options.gateway.getRequests("config.get")).length;
  await options.gateway.setMethodResponse(
    "config.get",
    configResponse(options.remainingPrefs, options.hash),
  );

  await options.click();
  await waitForRequestCount(options.gateway, "config.patch", patchCount + 1);
  const patches = await options.gateway.getRequests("config.patch");
  expect(patchPrefs(patches[patchCount] as MockGatewayRequest)).toEqual({
    [options.expectedKey]: null,
  });
  await waitForRequestCount(options.gateway, "config.get", configGetCount + 1);
}

async function readPersistedSettings(page: Page): Promise<Record<string, unknown>> {
  return page.evaluate((key) => {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  }, settingsStorageKey());
}

async function readThemeImportRaceState(page: Page) {
  const importer = page.locator(".settings-theme-import");
  const message = importer.locator(".settings-theme-import__message");
  const settings = await readPersistedSettings(page);
  return {
    renderedThemeMode: await page.locator("html").getAttribute("data-theme"),
    titleColor: await page
      .locator(".page-title")
      .evaluate((element) => getComputedStyle(element).color),
    clawSelected:
      (await page
        .locator("#settings-appearance-theme .settings-theme-card--claw")
        .getAttribute("aria-pressed")) === "true",
    customThemeMetadataCount: await importer.locator(".settings-theme-import__meta").count(),
    importUrl: await importer.locator("input").inputValue(),
    message: (await message.count()) > 0 ? ((await message.textContent())?.trim() ?? "") : "",
    importButtonDisabled: await importer.locator("button.primary").isDisabled(),
    persistedTheme: settings.theme ?? null,
    hasPersistedCustomTheme: settings.customTheme !== undefined,
  };
}

async function captureViewport(page: Page, filename: string): Promise<void> {
  if (!captureUiProofEnabled) {
    return;
  }
  await mkdir(uiProofArtifactDir, { recursive: true });
  await page.screenshot({
    animations: "disabled",
    path: path.join(uiProofArtifactDir, filename),
  });
}

suite.define(() => {
  it("removes synced and browser-local overrides, then reloads inherited defaults", async () => {
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    await context.addInitScript(
      ({ gatewayUrl, key }) => {
        const seedKey = "openclaw.control-ui-e2e.appearance-defaults-seeded";
        if (sessionStorage.getItem(seedKey) === "1") {
          return;
        }
        sessionStorage.setItem(seedKey, "1");
        localStorage.setItem(
          key,
          JSON.stringify({
            gatewayUrl,
            textScale: 110,
          }),
        );
      },
      { gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl), key: settingsStorageKey() },
    );
    const page = await context.newPage();
    const initialPrefs: Record<string, unknown> = {
      chatSendShortcut: "modifier-enter",
      locale: "en",
      theme: "knot",
      themeMode: "dark",
    };
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse(initialPrefs, "appearance-defaults-1"),
        "config.patch": { ok: true },
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const languageRow = settingsRow(page, "Language");
      const themeSection = page.locator("#settings-appearance-theme");
      const colorModeRow = settingsRow(page, "Color mode");
      const textSizeSection = page.locator("#settings-appearance-text-size");
      const sendShortcutRow = settingsRow(page, "Send shortcut");
      const languageSelect = languageRow.locator("wa-select");
      const colorModeGroup = colorModeRow.locator("wa-radio-group");
      const sendShortcutSelect = sendShortcutRow.locator("[data-settings-send-shortcut]");

      await expect.poll(() => selectValue(languageSelect)).toBe("en");
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--knot").getAttribute("aria-pressed"))
        .toBe("true");
      await expect.poll(() => selectValue(colorModeGroup)).toBe("dark");
      await expect
        .poll(() =>
          textSizeSection
            .locator(".settings-text-scale__btn", { hasText: "110%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect.poll(() => sendShortcutSelect.inputValue()).toBe("modifier-enter");
      await expect.poll(() => languageRow.textContent()).toContain("Default: System");
      await expect.poll(() => themeSection.textContent()).toContain("Default: Claw");
      await expect.poll(() => colorModeRow.textContent()).toContain("Default: System");
      await expect.poll(() => textSizeSection.textContent()).toContain("Default: 100%");
      await expect.poll(() => sendShortcutRow.textContent()).toContain("Default: Enter");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "01-explicit-overrides.png");
      await sendShortcutRow.scrollIntoViewIfNeeded();
      await captureViewport(page, "02-explicit-chat-override.png");

      const withoutLocale = { ...initialPrefs };
      delete withoutLocale.locale;
      await resetSyncedPreference({
        click: () =>
          languageRow
            .getByRole("button", { name: "Reset to default" })
            .click()
            .then(() => undefined),
        expectedKey: "locale",
        gateway,
        hash: "appearance-defaults-2",
        remainingPrefs: withoutLocale,
      });

      const withoutTheme = { ...withoutLocale };
      delete withoutTheme.theme;
      await resetSyncedPreference({
        click: () =>
          themeSection
            .locator(":scope > .settings-section__header")
            .getByRole("button", { name: "Reset to default" })
            .click()
            .then(() => undefined),
        expectedKey: "theme",
        gateway,
        hash: "appearance-defaults-3",
        remainingPrefs: withoutTheme,
      });

      const withoutThemeMode = { ...withoutTheme };
      delete withoutThemeMode.themeMode;
      await resetSyncedPreference({
        click: () =>
          colorModeRow
            .getByRole("button", { name: "Reset to default" })
            .click()
            .then(() => undefined),
        expectedKey: "themeMode",
        gateway,
        hash: "appearance-defaults-4",
        remainingPrefs: withoutThemeMode,
      });

      await textSizeSection
        .locator(":scope > .settings-section__header")
        .getByRole("button", { name: "Reset to default" })
        .click();
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");

      await resetSyncedPreference({
        click: () =>
          sendShortcutRow
            .getByRole("button", { name: "Reset to default" })
            .click()
            .then(() => undefined),
        expectedKey: "chatSendShortcut",
        gateway,
        hash: "appearance-defaults-5",
        remainingPrefs: {},
      });

      await expect.poll(() => selectValue(languageSelect)).toBe("system");
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"))
        .toBe("true");
      await expect.poll(() => selectValue(colorModeGroup)).toBe("system");
      await expect
        .poll(() =>
          textSizeSection
            .locator(".settings-text-scale__btn", { hasText: "100%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect.poll(() => sendShortcutSelect.inputValue()).toBe("enter");

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const reloadedLanguageRow = settingsRow(page, "Language");
      const reloadedThemeSection = page.locator("#settings-appearance-theme");
      const reloadedColorModeRow = settingsRow(page, "Color mode");
      const reloadedTextSizeSection = page.locator("#settings-appearance-text-size");
      const reloadedSendShortcutRow = settingsRow(page, "Send shortcut");

      await expect.poll(() => selectValue(reloadedLanguageRow.locator("wa-select"))).toBe("system");
      await expect
        .poll(() =>
          reloadedThemeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect
        .poll(() => selectValue(reloadedColorModeRow.locator("wa-radio-group")))
        .toBe("system");
      await expect
        .poll(() =>
          reloadedTextSizeSection
            .locator(".settings-text-scale__btn", { hasText: "100%" })
            .getAttribute("aria-pressed"),
        )
        .toBe("true");
      await expect
        .poll(() => reloadedSendShortcutRow.locator("[data-settings-send-shortcut]").inputValue())
        .toBe("enter");
      await expect.poll(() => reloadedLanguageRow.textContent()).toContain("Using default: System");
      await expect.poll(() => reloadedThemeSection.textContent()).toContain("Using default: Claw");
      await expect
        .poll(() => reloadedColorModeRow.textContent())
        .toContain("Using default: System");
      await expect
        .poll(() => reloadedTextSizeSection.textContent())
        .toContain("Using default: 100%");
      await expect
        .poll(() => reloadedSendShortcutRow.textContent())
        .toContain("Using default: Enter");
      await expect
        .poll(() => page.getByRole("button", { name: "Reset to default" }).count())
        .toBe(0);
      await expect.poll(() => readPersistedSettings(page)).not.toHaveProperty("textScale");
      await expect.poll(() => page.locator("html").getAttribute("data-theme-mode")).toBe("dark");

      await page.evaluate(() => window.scrollTo(0, 0));
      await captureViewport(page, "03-inherited-defaults.png");
      await reloadedSendShortcutRow.scrollIntoViewIfNeeded();
      await captureViewport(page, "04-inherited-chat-default.png");
    } finally {
      await context.close();
    }
  });

  it("keeps rejected edits browser-local and resets them without another server write", async () => {
    await suite.withPage(
      {
        locale: "en-US",
        serviceWorkers: "block",
        viewport: { height: 900, width: 1440 },
      },
      async ({ page }) => {
        const initialPrefs = {
          locale: "en",
          theme: "claw",
          chatFollowUpMode: "queue",
        };
        const gateway = await installMockGateway(page, {
          methodResponses: {
            "config.get": configResponse(initialPrefs, "appearance-rejected-1"),
          },
        });

        const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
        expect(response?.status()).toBe(200);
        await waitForControlUiSettingsTakeover(page);
        await gateway.waitForRequest("config.get");

        const languageRow = page.locator("#settings-language .settings-row");
        const languageSelect = languageRow.locator("wa-select");
        const themeSection = page.locator("#settings-appearance-theme");
        const themeDescription = themeSection.locator(":scope > .settings-section__desc");
        const followUpSelect = page.locator("[data-settings-follow-up-mode]");
        const followUpRow = page.locator(".settings-row").filter({ has: followUpSelect });

        await expect.poll(() => selectValue(languageSelect)).toBe("en");
        await expect
          .poll(() =>
            themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect.poll(() => followUpSelect.inputValue()).toBe("queue");

        await gateway.deferNext("config.patch");
        await themeSection.locator(".settings-theme-card--knot").click();
        await waitForRequestCount(gateway, "config.patch", 1);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[0] as MockGatewayRequest),
        ).toEqual({ theme: "knot" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect
          .poll(() =>
            themeSection.locator(".settings-theme-card--knot").getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect.poll(() => themeDescription.textContent()).toContain("Default: Claw");
        await expect
          .poll(() => themeDescription.textContent())
          .toContain("Stored in this browser only");

        await gateway.deferNext("config.patch");
        await languageSelect.evaluate((element) => {
          const select = element as HTMLElement & { value: string };
          select.value = "fr";
          select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
        });
        await waitForRequestCount(gateway, "config.patch", 2);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[1] as MockGatewayRequest),
        ).toEqual({ locale: "fr" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect.poll(() => selectValue(languageSelect)).toBe("fr");
        await expect.poll(() => languageRow.textContent()).toContain("Par défaut : Anglais");
        await expect
          .poll(() => languageRow.textContent())
          .toContain("Stocké uniquement dans ce navigateur");

        await gateway.deferNext("config.patch");
        await followUpSelect.selectOption("steer");
        await waitForRequestCount(gateway, "config.patch", 3);
        expect(
          patchPrefs((await gateway.getRequests("config.patch"))[2] as MockGatewayRequest),
        ).toEqual({ chatFollowUpMode: "steer" });
        await gateway.rejectDeferred("config.patch", {
          code: "INVALID_REQUEST",
          message: "mock validation failure",
        });

        await expect.poll(() => followUpSelect.inputValue()).toBe("steer");
        await expect
          .poll(() => followUpRow.textContent())
          .toContain("Stocké uniquement dans ce navigateur");

        await themeSection
          .locator(":scope > .settings-section__header")
          .locator("button.btn--icon")
          .click();
        await languageRow.locator("button.btn--icon").click();
        await followUpRow.locator("button.btn--sm").click();

        await expect
          .poll(() =>
            themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"),
          )
          .toBe("true");
        await expect.poll(() => selectValue(languageSelect)).toBe("en");
        await expect.poll(() => followUpSelect.inputValue()).toBe("queue");
        await expect.poll(() => page.locator("html").getAttribute("lang")).toBe("en");
        await page.waitForTimeout(100);
        expect(await gateway.getRequests("config.patch")).toHaveLength(3);
      },
    );
  });

  it("keeps every read-only preference surface browser-local across reload", async () => {
    const context = await suite.browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      operatorScopes: ["operator.read"],
      methodResponses: {
        "config.get": configResponse({ theme: "knot" }, "appearance-read-only-1"),
      },
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const themeSection = page.locator("#settings-appearance-theme");
      const themeDescription = themeSection.locator(":scope > .settings-section__desc");
      await themeSection.locator(".settings-theme-card--claw").click();

      await expect
        .poll(() => themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"))
        .toBe("true");
      await expect
        .poll(() => themeDescription.textContent())
        .toContain("Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ theme: "claw" });
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.reload();
      await waitForControlUiSettingsTakeover(page);
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"))
        .toBe("true");
      await expect
        .poll(() => themeDescription.textContent())
        .toContain("Stored in this browser only");
      await expect.poll(() => readPersistedSettings(page)).toMatchObject({ theme: "claw" });
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await themeSection
        .locator(":scope > .settings-section__header")
        .locator("button.btn--icon")
        .click();
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--knot").getAttribute("aria-pressed"))
        .toBe("true");
      await expect.poll(() => themeDescription.textContent()).toContain("Default: Claw");
      await expect
        .poll(() => themeDescription.textContent())
        .not.toContain("Stored in this browser only");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.goto(`${suite.server.baseUrl}chat`);
      const viewMenuTrigger = page.locator(".chat-view-menu-trigger");
      await viewMenuTrigger.click();
      const viewMenu = page.locator("wa-dropdown.chat-view-menu");
      await expect
        .poll(() => viewMenu.locator(".chat-view-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      const reasoning = viewMenu.getByRole("menuitemcheckbox", { name: "Reasoning" });
      await reasoning.click();
      await expect.poll(() => reasoning.getAttribute("aria-checked")).toBe("false");

      const sidebar = page.locator("openclaw-app-sidebar");
      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      const customizeMenu = sidebar.locator(
        "wa-dropdown.sidebar-customize-menu:not(.sidebar-more-menu):not(.sidebar-agent-menu)",
      );
      await expect
        .poll(() => customizeMenu.locator(".sidebar-customize-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      const tasks = customizeMenu.getByRole("menuitemcheckbox", { name: "Tasks" });
      await tasks.click();
      await expect.poll(() => tasks.getAttribute("aria-checked")).toBe("true");
      await page.waitForTimeout(100);
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);

      await page.reload();
      await viewMenuTrigger.click();
      await expect
        .poll(() => viewMenu.locator(".chat-view-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      await expect
        .poll(() =>
          viewMenu
            .getByRole("menuitemcheckbox", { name: "Reasoning" })
            .getAttribute("aria-checked"),
        )
        .toBe("false");

      await sidebar.locator(".sidebar-nav__head-action").click();
      await sidebar
        .locator("wa-dropdown.sidebar-more-menu")
        .getByRole("menuitem", { name: "Edit pinned items" })
        .click();
      await expect
        .poll(() => customizeMenu.locator(".sidebar-customize-menu__provenance").textContent())
        .toContain("Stored in this browser only");
      await expect
        .poll(() =>
          customizeMenu
            .getByRole("menuitemcheckbox", { name: "Tasks" })
            .getAttribute("aria-checked"),
        )
        .toBe("true");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      await context.close();
    }
  });

  it("keeps Clear authoritative after a delayed custom-theme replacement", async () => {
    const existingTheme = await importCustomThemeFromUrl(
      "existing",
      async () =>
        new Response(
          JSON.stringify({ ...createTweakcnThemePayload(), name: "Existing Test Theme" }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
    );
    const replacementPayload = createTweakcnThemePayload();
    let releaseReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      releaseReplacement = resolve;
    });
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    await context.addInitScript(
      ({ gatewayUrl, key, theme }) => {
        localStorage.setItem(
          key,
          JSON.stringify({
            customTheme: theme,
            gatewayUrl,
            theme: "custom",
          }),
        );
      },
      {
        gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
        key: settingsStorageKey(),
        theme: existingTheme,
      },
    );
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse({}, "custom-theme-race-1"),
        "config.patch": { ok: true },
      },
    });
    await page.route("https://tweakcn.com/r/themes/replacement", async (route) => {
      await replacementGate;
      await route.fulfill({ json: replacementPayload });
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const themeSection = page.locator("#settings-appearance-theme");
      const importer = page.locator(".settings-theme-import");
      const importField = importer.locator("input");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("custom");
      await expect
        .poll(() => importer.locator(".settings-theme-import__meta-value").textContent())
        .toContain("Existing Test Theme");
      const beforeReplace = await readThemeImportRaceState(page);
      await captureViewport(page, "04-custom-theme-before-replace.png");

      await importField.fill("replacement");
      await importer.locator("button.primary").click();
      const replacementResponse = page.waitForResponse("https://tweakcn.com/r/themes/replacement");
      await expect.poll(() => importer.locator("button.primary").isDisabled()).toBe(true);
      await importer.locator("button.danger").click();

      await expect
        .poll(() => themeSection.locator(".settings-theme-card--claw").getAttribute("aria-pressed"))
        .toBe("true");
      await expect.poll(() => importer.locator(".settings-theme-import__meta").count()).toBe(0);
      const afterClear = await readThemeImportRaceState(page);
      await captureViewport(page, "05-custom-theme-cleared-with-replace-pending.png");

      releaseReplacement();
      await replacementResponse;
      await expect
        .poll(async () => {
          const settings = await readPersistedSettings(page);
          return {
            customTheme: settings.customTheme,
            theme: settings.theme,
          };
        })
        .toEqual({ customTheme: undefined, theme: "claw" });
      await expect.poll(() => importer.locator(".settings-theme-import__meta").count()).toBe(0);
      await expect
        .poll(() => importer.locator(".settings-theme-import__message").textContent())
        .toContain("removed");
      const afterDelayedResponse = await readThemeImportRaceState(page);
      expect(beforeReplace).toMatchObject({
        clawSelected: false,
        customThemeMetadataCount: 1,
        persistedTheme: "custom",
        hasPersistedCustomTheme: true,
      });
      expect(afterClear).toMatchObject({
        renderedThemeMode: "dark",
        clawSelected: true,
        customThemeMetadataCount: 0,
        importUrl: "replacement",
        importButtonDisabled: false,
        persistedTheme: "claw",
        hasPersistedCustomTheme: false,
      });
      expect(beforeReplace.titleColor).not.toBe(afterClear.titleColor);
      expect(afterDelayedResponse).toEqual({
        ...afterClear,
        message: "Custom theme removed.",
      });
      console.info(
        `[control-ui-e2e] THEME_IMPORT_RACE_VERDICT ${JSON.stringify({
          scenario: "delayed-replace-then-clear",
          beforeReplace,
          afterClear,
          afterDelayedResponse,
          pass: true,
        })}`,
      );
      await captureViewport(page, "06-custom-theme-clear-remains-final.png");
    } finally {
      releaseReplacement();
      await context.close();
    }
  });

  it("keeps a newer server-applied theme authoritative over a delayed import", async () => {
    const replacementPayload = createTweakcnThemePayload();
    let releaseImport!: () => void;
    const importGate = new Promise<void>((resolve) => {
      releaseImport = resolve;
    });
    const context = await suite.browser.newContext({
      colorScheme: "dark",
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 1000, width: 1440 },
    });
    const page = await context.newPage();
    const gateway = await installMockGateway(page, {
      methodResponses: {
        "config.get": configResponse({ theme: "claw" }, "custom-theme-server-race-1"),
        "config.patch": { ok: true },
      },
    });
    await page.route("https://tweakcn.com/r/themes/replacement", async (route) => {
      await importGate;
      await route.fulfill({ json: replacementPayload });
    });

    try {
      const response = await page.goto(`${suite.server.baseUrl}settings/appearance`);
      expect(response?.status()).toBe(200);
      await waitForControlUiSettingsTakeover(page);
      await gateway.waitForRequest("config.get");

      const themeSection = page.locator("#settings-appearance-theme");
      await themeSection.locator(".settings-theme-card--custom").click();
      const importer = page.locator(".settings-theme-import");
      await importer.locator("input").fill("replacement");
      await importer.locator("button.primary").click();
      const replacementResponse = page.waitForResponse("https://tweakcn.com/r/themes/replacement");
      await expect.poll(() => importer.locator("button.primary").isDisabled()).toBe(true);

      const configGetCount = (await gateway.getRequests("config.get")).length;
      await gateway.setMethodResponse(
        "config.get",
        configResponse({ theme: "knot" }, "custom-theme-server-race-2"),
      );
      await gateway.emitGatewayEvent("config.changed", {
        hash: "custom-theme-server-race-2",
        path: "/tmp/openclaw.json",
        ts: Date.now(),
      });
      await waitForRequestCount(gateway, "config.get", configGetCount + 1);
      await expect
        .poll(() => themeSection.locator(".settings-theme-card--knot").getAttribute("aria-pressed"))
        .toBe("true");

      releaseImport();
      await replacementResponse;
      await expect
        .poll(async () => {
          const settings = await readPersistedSettings(page);
          return {
            hasCustomTheme: typeof settings.customTheme === "object",
            theme: settings.theme,
          };
        })
        .toEqual({ hasCustomTheme: true, theme: "knot" });
      await expect
        .poll(() => importer.locator(".settings-theme-import__message").textContent())
        .toContain("Imported");
      expect(await gateway.getRequests("config.patch")).toHaveLength(0);
    } finally {
      releaseImport();
      await context.close();
    }
  });
});
