import { mkdir } from "node:fs/promises";
import path from "node:path";
import type { Locator } from "playwright";
import { expect, it } from "vitest";
import {
  formatKeyboardShortcutCombo,
  KEYBOARD_SHORTCUT_COMBOS,
} from "../lib/keyboard-shortcut-contract.ts";
import { finishElementAnimations } from "../test-helpers/animations.ts";
import {
  controlUiBundledGatewayUrl,
  installMockGateway,
  type ControlUiMockGatewayScenario,
  waitForControlUiRoute,
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/*
 * A theme that declares webfonts must actually paint in them, and a theme that
 * does not must never pay for them. Both halves are invisible to unit tests:
 * the stylesheet is linked at runtime and the faces only resolve once the
 * browser has fetched them, so a broken asset path or a dropped link degrades
 * silently to the fallback stack and looks merely "a bit off".
 */

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";

const suite = createControlUiE2eSuite({
  name: "Control UI theme typography",
  trackBrowserContexts: true,
  unavailableMessage: (executablePath) =>
    `Playwright Chromium is required for theme typography proof at ${executablePath}`,
});

function themeConfigResponse(theme: string, mode: "dark" | "light") {
  const config = { ui: { prefs: { theme, themeMode: mode } } };
  const hash = `theme-typography-${theme}-${mode}`;
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

async function openThemedChat(
  theme: string,
  mode: "dark" | "light",
  scenario: Pick<ControlUiMockGatewayScenario, "basePath" | "historyMessages"> = {},
) {
  const context = await suite.newBrowserContext({
    colorScheme: mode,
    locale: "en-US",
    serviceWorkers: "block",
    viewport: { height: 900, width: 1440 },
  });
  await context.addInitScript(
    ({ gatewayUrl, initialMode, initialTheme }) => {
      if (sessionStorage.getItem("typography-seeded")) {
        return;
      }
      sessionStorage.setItem("typography-seeded", "1");
      localStorage.setItem(
        `openclaw.control.settings.v1:${gatewayUrl}`,
        JSON.stringify({ gatewayUrl, theme: initialTheme, themeMode: initialMode }),
      );
    },
    {
      gatewayUrl: controlUiBundledGatewayUrl(suite.server.baseUrl),
      initialMode: mode,
      initialTheme: theme,
    },
  );
  const page = await context.newPage();
  const themeRequests: string[] = [];
  page.on("response", (response) => {
    const { pathname } = new URL(response.url());
    if (pathname.includes("/fonts/") || pathname.includes("/themes/")) {
      themeRequests.push(`${pathname.split("/").pop()} ${response.status()}`);
    }
  });
  const gateway = await installMockGateway(page, {
    ...scenario,
    methodResponses: { "config.get": themeConfigResponse(theme, mode) },
  });
  return { themeRequests, gateway, page };
}

async function captureTypography(
  page: Awaited<ReturnType<typeof openThemedChat>>["page"],
  name: string,
) {
  if (captureUiProof) {
    await mkdir(path.join(suite.artifactDir, "theme-typography"), { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({
      path: path.join(path.join(suite.artifactDir, "theme-typography"), `${name}.png`),
    });
  }
}

async function openPicker(picker: Locator) {
  await Promise.all([
    picker.evaluate(
      (select) =>
        new Promise<void>((resolve) => {
          select.addEventListener("wa-after-show", () => resolve(), { once: true });
        }),
    ),
    picker.click(),
  ]);
  await picker.locator('wa-popup [part="popup"]').evaluate(finishElementAnimations);
}

async function selectPickerValue(picker: Locator, value: string) {
  await picker.evaluate(async (element, nextValue) => {
    const select = element as HTMLElement & {
      open: boolean;
      updateComplete: Promise<unknown>;
      value: string;
    };
    select.value = nextValue;
    select.open = false;
    await select.updateComplete;
    select.dispatchEvent(new Event("change", { bubbles: true, composed: true }));
  }, value);
}

suite.define(() => {
  it("previews fonts on demand, applies independent overrides, and restores theme typography", async () => {
    const { page, themeRequests, gateway } = await openThemedChat("dash", "dark");
    await page.goto(`${suite.server.baseUrl}settings/appearance`);
    await waitForControlUiSettingsTakeover(page);
    const ui = page.locator("#settings-font-ui");
    const chat = page.locator("#settings-font-chat");
    const preview = page.locator(".settings-typography-preview");
    const fontRequests = () =>
      themeRequests.filter(
        (request) => request.includes(".css") && !request.startsWith("dash.css"),
      );
    await preview.waitFor();
    expect(await ui.locator("..").locator("..").textContent()).toContain(
      "Stored in this browser only",
    );
    await page.evaluate(() => document.fonts.ready);
    expect(new Set(fontRequests())).toEqual(
      new Set(["dm-sans.css 200", "fraunces.css 200", "jetbrains-mono.css 200"]),
    );
    const families = () =>
      preview.evaluate((panel) => ({
        ui: getComputedStyle(panel.querySelector(".settings-typography-preview__caption")!)
          .fontFamily,
        chat: getComputedStyle(panel.querySelector(".settings-typography-preview__prose")!)
          .fontFamily,
        code: getComputedStyle(panel.querySelector("code")!).fontFamily,
      }));
    const chatSmoothing = () =>
      page.evaluate(() => document.documentElement.style.getPropertyValue("--chat-font-smoothing"));
    const initial = await families();
    expect(initial.ui).toContain("DM Sans");
    expect(initial.chat).toContain("Fraunces");
    expect(await chatSmoothing()).toBe("auto");
    if (captureUiProof) {
      await preview.scrollIntoViewIfNeeded();
    }
    await captureTypography(page, "picker-default");
    await openPicker(ui);
    await ui.locator('wa-option[value="geist"]').waitFor({ state: "visible" });
    await expect.poll(() => fontRequests().length).toBe(9);
    await captureTypography(page, "picker-specimens");
    await selectPickerValue(ui, "geist");
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    expect((await families()).chat).toContain("Fraunces");
    await selectPickerValue(chat, "geist");
    await expect.poll(async () => (await families()).chat).toContain("Geist");
    // A sans chat override on a serif theme drops the serif smoothing opt-in.
    await expect.poll(chatSmoothing).toBe("");
    await selectPickerValue(chat, "lora");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await expect.poll(chatSmoothing).toBe("auto");
    await expect
      .poll(() =>
        page.evaluate(() =>
          [...document.fonts].filter((face) => face.status === "loaded").map((face) => face.family),
        ),
      )
      .toEqual(expect.arrayContaining(["Geist", "Lora"]));
    expect((await families()).code).toBe(initial.code);
    expect(await gateway.getRequests("config.patch")).toEqual([]);
    await captureTypography(page, "picker-overrides");
    await page.reload();
    await waitForControlUiSettingsTakeover(page);
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    await expect.poll(async () => (await families()).chat).toContain("Lora");
    await selectPickerValue(ui, "system");
    await expect.poll(async () => (await families()).ui).toContain("-apple-system");
    await selectPickerValue(ui, "theme");
    await selectPickerValue(chat, "theme");
    await expect.poll(families).toEqual(initial);
    expect(
      await page.evaluate(() =>
        ["--font-body", "--font-chat"].map((key) =>
          document.documentElement.style.getPropertyValue(key),
        ),
      ),
    ).toEqual(["", ""]);
  });

  it.each([
    ["claw", "Instrument Sans", "Instrument Sans", ["instrument-sans"], "antialiased"],
    ["knot", "Geist", "Geist", ["geist"], "antialiased"],
    ["dash", "DM Sans", "Fraunces", ["dm-sans", "fraunces"], "auto"],
    ["absolutely", "Space Grotesk", "Lora", ["space-grotesk", "lora"], "auto"],
    ["tide", "IBM Plex Sans", "IBM Plex Sans", ["ibm-plex-sans"], "antialiased"],
    [
      "beacon",
      "Atkinson Hyperlegible Next",
      "Atkinson Hyperlegible Next",
      ["atkinson-hyperlegible"],
      "antialiased",
    ],
    ["phosphor", "JetBrains Mono", "JetBrains Mono", ["jetbrains-mono"], "antialiased"],
    ["crt", "JetBrains Mono", "JetBrains Mono", ["jetbrains-mono"], "antialiased"],
    ["manuscript", "Lora", "Lora", ["lora"], "auto"],
    ["rose", "DM Sans", "DM Sans", ["dm-sans"], "antialiased"],
    ["miami", "Space Grotesk", "Space Grotesk", ["space-grotesk"], "antialiased"],
  ] as const)(
    "paints %s chrome and chat prose in its own faces",
    async (theme, body, chat, faces, chatSmoothing) => {
      const timestamp = Date.now();
      const text =
        "Typography carries the theme: chat prose renders in the reading face while chrome, chips, and code keep their own.";
      const { themeRequests, page } = await openThemedChat(theme, "dark", {
        historyMessages: [
          {
            content: [{ text: "say something", type: "text" }],
            role: "user",
            timestamp: timestamp - 1,
          },
          {
            content: [{ text, type: "text" }],
            role: "assistant",
            timestamp,
          },
        ],
      });
      await page.goto(`${suite.server.baseUrl}chat`);
      await expect
        .poll(() => page.locator(".chat-text").last().textContent())
        .toContain("Typography");

      const report = await page.evaluate(async () => {
        await document.fonts.ready;
        const chats = document.querySelectorAll(".chat-text");
        const lastChat = chats[chats.length - 1];
        const primary = (value: string) =>
          (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
        return {
          buildId: document.documentElement.getAttribute("data-openclaw-control-ui-build-id"),
          chatFontFamily: lastChat ? primary(getComputedStyle(lastChat).fontFamily) : null,
          chatFontSmoothing: lastChat
            ? getComputedStyle(lastChat).getPropertyValue("-webkit-font-smoothing")
            : null,
          bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
          stylesheets: [
            ...document.querySelectorAll<HTMLLinkElement>('link[id^="openclaw-typeface-"]'),
          ].map((link) => {
            const url = new URL(link.href);
            return { pathname: url.pathname, version: url.searchParams.get("v") };
          }),
          loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        };
      });

      // Every theme also declares the mono face: base.css --mono names
      // JetBrains Mono for code spans regardless of the active family.
      const expectedFaces = [...new Set([...faces, "jetbrains-mono"])];
      if (report.buildId !== null) {
        expect(report.buildId).not.toBe("");
      }
      expect(report.stylesheets).toEqual(
        expectedFaces.map((face) => ({
          pathname: `/fonts/${face}.css`,
          version: report.buildId,
        })),
      );
      expect(report.bodyFontFamily).toBe(body);
      expect(report.chatFontFamily).toBe(chat);
      // Serif chat faces opt out of the app-wide `antialiased` thinning
      // (applyChatFontSmoothing) so their hairlines stay crisp.
      expect(report.chatFontSmoothing).toBe(chatSmoothing);
      // Mono glyphs on the page pull the always-declared JetBrains Mono face.
      expect(new Set(report.loaded)).toEqual(new Set([body, chat, "JetBrains Mono"]));
      expect(themeRequests.every((entry) => entry.endsWith(" 200"))).toBe(true);

      await captureTypography(page, `${theme}-chat-dark`);
    },
  );

  it("keeps Phosphor shortcut modifier glyphs on the system UI stack", async () => {
    const { page } = await openThemedChat("phosphor", "dark");
    await page.goto(`${suite.server.baseUrl}chat`);
    const identity = page.locator(".sidebar-identity-card");
    await identity.focus();
    await page.keyboard.press("Enter");
    const menu = page.locator("wa-dropdown.sidebar-identity-menu");
    await menu.waitFor();
    const shortcut = menu
      .locator('wa-dropdown-item[value="command:settings"]')
      .locator(".session-menu__shortcut");

    const report = await shortcut.evaluate((element) => ({
      body: getComputedStyle(document.body).fontFamily,
      shortcut: getComputedStyle(element).fontFamily,
      text: element.textContent,
    }));
    expect(report.body).toMatch(/^"?JetBrains Mono/u);
    expect(report.shortcut).toMatch(/^system-ui,/u);
    const applePlatform = await page.evaluate(() =>
      /Mac|iPhone|iPad|iPod/u.test(navigator.platform),
    );
    expect(report.text).toBe(
      formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.appearanceSettings, applePlatform),
    );

    await page.keyboard.press("Escape");
    await page.locator(".chat-side-panel-toggle").click();
    const panelSelector = page.locator(".side-panel-empty--selector");
    const panelShortcuts = panelSelector.locator(".side-panel-type-option__shortcut");
    await expect
      .poll(() => panelShortcuts.allTextContents())
      .toEqual([
        formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.workspaceFiles, applePlatform),
        formatKeyboardShortcutCombo(KEYBOARD_SHORTCUT_COMBOS.sideChat, applePlatform),
      ]);
    await expect
      .poll(() =>
        panelShortcuts.evaluateAll((elements) =>
          elements.map((element) => {
            return getComputedStyle(element).fontFamily;
          }),
        ),
      )
      .toEqual([expect.stringMatching(/^system-ui,/u), expect.stringMatching(/^system-ui,/u)]);

    if (captureUiProof) {
      await mkdir(path.join(suite.artifactDir, "theme-typography"), { recursive: true });
      await panelSelector.screenshot({
        path: path.join(
          path.join(suite.artifactDir, "theme-typography"),
          "phosphor-panel-shortcuts.png",
        ),
      });
    }

    await page.keyboard.press("ControlOrMeta+Shift+S");
    await page.locator('[data-panel-slot="companion"]:not([hidden])').waitFor();

    const modelShortcutFont = await page.evaluate(() => {
      const action = document.createElement("span");
      action.className = "chat-controls__model-option-action";
      const keycap = document.createElement("kbd");
      action.append(keycap);
      document.body.append(action);
      const fontFamily = getComputedStyle(keycap).fontFamily;
      action.remove();
      return fontFamily;
    });
    expect(modelShortcutFont).toBe(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      ),
    );

    const genericMenuShortcutFont = await page.evaluate(() => {
      const genericShortcut = document.createElement("span");
      genericShortcut.className = "session-menu__shortcut";
      genericShortcut.textContent = "C";
      document.body.append(genericShortcut);
      const fontFamily = getComputedStyle(genericShortcut).fontFamily;
      genericShortcut.remove();
      return fontFamily;
    });
    expect(genericMenuShortcutFont).toBe(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--mono").trim(),
      ),
    );
  });

  it.each([
    ["knot", "openknot", "#080808", "#f9f9fb"],
    ["dash", "dash", "#1a1210", "#f7f2ec"],
    ["absolutely", "absolutely", "#1c1c1a", "#faf9f5"],
    ["tide", "tide", "#10151b", "#f7f9fb"],
    ["beacon", "beacon", "#000000", "#ffffff"],
    ["phosphor", "phosphor", "#0a0f0a", "#f4f7f4"],
    ["crt", "crt", "#090a09", "#f5f5f4"],
    ["manuscript", "manuscript", "#211e18", "#f6f1e4"],
    ["rose", "rose", "#191724", "#faf4ed"],
    ["miami", "miami", "#140f1e", "#f7f3f6"],
  ])(
    "loads %s before paint in both modes without the app bundle",
    async (theme, resolved, dark, light) => {
      // Bundle aborts isolate the boot document; resource timing verifies the
      // browser actually blocks rendering, not merely that a link exists later.
      for (const mode of ["dark", "light"] as const) {
        const { page } = await openThemedChat(theme, mode);
        await page.route("**/assets/**.js", (route) => route.abort());
        await page.goto(`${suite.server.baseUrl}chat`);
        const report = await page.evaluate(() => ({
          buildId: document.documentElement.getAttribute("data-openclaw-control-ui-build-id"),
          background: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
          resolvedTheme: document.documentElement.dataset.theme,
          palette: performance
            .getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname.includes("/themes/"))
            .map((entry) => ({
              pathname: new URL(entry.name).pathname,
              version: new URL(entry.name).searchParams.get("v"),
              blocking: (entry as PerformanceResourceTiming & { renderBlockingStatus: string })
                .renderBlockingStatus,
            })),
        }));
        expect(report.resolvedTheme).toBe(mode === "dark" ? resolved : `${resolved}-light`);
        expect(report.background).toBe(mode === "dark" ? dark : light);
        expect(report.palette).toEqual([
          { pathname: `/themes/${theme}.css`, version: report.buildId, blocking: "blocking" },
        ]);
      }
    },
  );

  it("keeps system chrome with the mounted route across shell and viewport lifecycles", async () => {
    const { page } = await openThemedChat("claw", "light");
    await page.setViewportSize({ width: 720, height: 900 });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();

    const readChrome = () =>
      page.evaluate(() => ({
        color: document.documentElement.style.getPropertyValue(
          "--control-ui-system-chrome-background",
        ),
        metas: Array.from(
          document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]'),
          (meta) => ({ color: meta.content, media: meta.getAttribute("media") }),
        ),
      }));
    const expectChrome = async (color: string) => {
      await expect.poll(readChrome).toEqual({
        color,
        metas: [
          { color, media: null },
          { color, media: null },
        ],
      });
    };
    const pageColor = "#faf9f7";
    const chatColor = "#f4f1ec";
    await expectChrome(chatColor);

    // Use the shell's actual shortcut and browser history without rebuilding the runtime.
    await page.locator(".shell-skip-link").focus();
    await page.keyboard.press("ControlOrMeta+Shift+,");
    await waitForControlUiRoute(page, { pathname: "/settings/appearance", routeId: "appearance" });
    await expectChrome(pageColor);
    await page.goBack();
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    await expectChrome(chatColor);
    await page.locator(".chat-pane__nav-toggle").first().click();
    await page.locator("openclaw-app-sidebar .sidebar-brand__new-thread").click();
    await page.locator(".new-session-page__message").waitFor();
    await expectChrome(chatColor);

    for (const [width, height, color] of [
      [1280, 900, pageColor],
      [900, 450, chatColor],
      [900, 900, pageColor],
      [720, 900, chatColor],
    ] as const) {
      await page.setViewportSize({ width, height });
      await expectChrome(color);
    }

    // Runtime removal renders nothing; restoration must rebind the existing router.
    const runtimeLifecycle = await page.locator("openclaw-app-shell").evaluate(async (element) => {
      const shell = element as HTMLElement & {
        runtime?: import("../app/bootstrap.ts").ApplicationRuntime;
        updateComplete: Promise<boolean>;
      };
      const runtime = shell.runtime;
      const color = () =>
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background");
      try {
        shell.runtime = undefined;
        await shell.updateComplete;
        const removed = { color: color(), chat: Boolean(shell.querySelector(".shell--chat")) };
        shell.runtime = runtime;
        await shell.updateComplete;
        return {
          removed,
          restored: { color: color(), chat: Boolean(shell.querySelector(".shell--chat")) },
        };
      } finally {
        shell.runtime = runtime;
      }
    });
    expect(runtimeLifecycle).toEqual({
      removed: { color: pageColor, chat: false },
      restored: { color: chatColor, chat: true },
    });
    await expectChrome(chatColor);

    const reconnect = await page.locator("openclaw-app-shell").evaluate(async (element) => {
      const shell = element as HTMLElement & { updateComplete: Promise<boolean> };
      const parent = shell.parentNode!;
      const next = shell.nextSibling;
      const color = () =>
        document.documentElement.style.getPropertyValue("--control-ui-system-chrome-background");
      try {
        shell.remove();
        const removed = color();
        parent.insertBefore(shell, next);
        await shell.updateComplete;
        return {
          removed,
          reconnected: color(),
          sameShell: document.querySelector("openclaw-app-shell") === shell,
        };
      } finally {
        if (!shell.isConnected) {
          parent.insertBefore(shell, next);
        }
      }
    });
    expect(reconnect).toEqual({ removed: pageColor, reconnected: chatColor, sameShell: true });
    await expectChrome(chatColor);
  });

  it("publishes a runtime palette only when its colors are ready and ignores superseded loads", async () => {
    const { page, gateway } = await openThemedChat("knot", "light");
    await page.setViewportSize({ width: 720, height: 900 });
    let releasePalette!: () => void;
    const paletteGate = new Promise<void>((resolve) => {
      releasePalette = resolve;
    });
    const tidePaletteUrl = /\/themes\/tide\.css(?:\?|$)/u;
    await page.route(tidePaletteUrl, async (route) => {
      await paletteGate;
      await route.continue();
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    await page.evaluate(() => {
      const root = document.documentElement;
      new MutationObserver(() => {
        if (root.dataset.theme === "tide-light") {
          root.dataset.observedThemeBackground = getComputedStyle(root)
            .getPropertyValue("--bg")
            .trim();
        }
      }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    });
    const changeTheme = async (theme: string) => {
      await gateway.setMethodResponse("config.get", themeConfigResponse(theme, "light"));
      await gateway.emitGatewayEvent("config.changed", { hash: `theme-${theme}`, ts: Date.now() });
    };
    try {
      const request = page.waitForRequest(tidePaletteUrl);
      await changeTheme("tide");
      await request;
      expect(await page.locator("html").getAttribute("data-theme")).toBe("openknot-light");
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
        ),
      ).toBe("#f9f9fb");
      await changeTheme("beacon");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("beacon-light");
      const response = page.waitForResponse(tidePaletteUrl);
      releasePalette();
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await page.locator("html").getAttribute("data-theme")).toBe("beacon-light");
      await changeTheme("tide");
      await expect
        .poll(() => page.locator("html").getAttribute("data-observed-theme-background"))
        .toBe("#f7f9fb");
      expect(await page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe(
        "#eef2f7",
      );
      await changeTheme("claw");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("light");
    } finally {
      releasePalette();
    }
  });

  it("resolves the font stylesheet against a configured mount path", async () => {
    // A gateway mounted at a base path serves the bundle below that prefix, so
    // root-absolute font URLs 404 there and the theme silently falls back to
    // system faces while its palette still applies.
    const basePath = "/openclaw";
    const { page } = await openThemedChat("absolutely", "dark", { basePath });
    const requested: string[] = [];
    // The preview server does not stamp Gateway HTML. Reproduce the actual
    // document contract, rather than letting runtime repair a wrong boot URL.
    await page.route("**/*", async (route) => {
      if (
        route.request().resourceType() !== "document" ||
        !new URL(route.request().url()).pathname.startsWith(`${basePath}/`)
      ) {
        await route.fallback();
        return;
      }
      const response = await route.fetch();
      const html = (await response.text()).replace(
        /<html\b/u,
        `<html data-openclaw-control-ui-base-path="${basePath}"`,
      );
      await route.fulfill({ response, body: html });
    });
    await page.route(`**${basePath}/themes/**`, async (route) => {
      const url = new URL(route.request().url());
      requested.push(url.pathname);
      url.pathname = url.pathname.slice(basePath.length);
      await route.fulfill({ response: await route.fetch({ url: url.href }) });
    });
    await page.route(`**${basePath}/fonts/**`, async (route) => {
      const { pathname } = new URL(route.request().url());
      requested.push(pathname);
      await route.fulfill({ status: 404, body: "", contentType: "text/css" });
    });

    await page.goto(`${suite.server.baseUrl}${basePath.slice(1)}/chat`);
    await page
      .locator(".agent-chat__composer-combobox textarea")
      .waitFor({ state: "visible", timeout: 30_000 });

    const linkHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-typeface-space-grotesk")?.getAttribute("href") ?? null,
    );

    const buildId = await page.locator("html").getAttribute("data-openclaw-control-ui-build-id");
    if (buildId !== null) {
      expect(buildId).not.toBe("");
    }
    const fontUrl = new URL(linkHref ?? "", suite.server.baseUrl);
    expect(fontUrl.pathname).toBe(`${basePath}/fonts/space-grotesk.css`);
    expect(fontUrl.searchParams.get("v")).toBe(buildId);
    // The palette link is built in the first-paint script from the mount prefix
    // the gateway stamps on <html>, so it has to follow the mount too.
    const paletteHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-theme-palette-absolutely")?.getAttribute("href") ?? null,
    );
    const paletteUrl = new URL(paletteHref ?? "", suite.server.baseUrl);
    expect(paletteUrl.pathname).toBe(`${basePath}/themes/absolutely.css`);
    expect(paletteUrl.searchParams.get("v")).toBe(buildId);
    expect(requested).toContain(`${basePath}/themes/absolutely.css`);
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
      ),
    ).toBe("#1c1c1a");
    // The browser must actually fetch below the mount, not at the root.
    await expect.poll(() => requested).toContain(`${basePath}/fonts/space-grotesk.css`);
  });
});
