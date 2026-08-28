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
  waitForControlUiSettingsTakeover,
} from "../test-helpers/control-ui-e2e.ts";
import { requireRecord, requireString } from "./chat-flow.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

/*
 * A theme that declares webfonts must actually paint in them, and a theme that
 * does not must never pay for them. Both halves are invisible to unit tests:
 * the stylesheet is linked at runtime and the faces only resolve once the
 * browser has fetched them, so a broken asset path or a dropped link degrades
 * silently to the fallback stack and looks merely "a bit off".
 */

const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const proofDirectory = path.resolve(process.cwd(), ".artifacts/control-ui-e2e/theme-typography");

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

async function openThemedChat(theme: string, mode: "dark" | "light", basePath = "") {
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
    const url = response.url();
    if (url.includes("/fonts/") || url.includes("/themes/")) {
      themeRequests.push(`${url.split("/").pop()} ${response.status()}`);
    }
  });
  const gateway = await installMockGateway(page, {
    ...(basePath ? { basePath } : {}),
    methodResponses: { "config.get": themeConfigResponse(theme, mode) },
  });
  return { themeRequests, gateway, page };
}

async function renderAssistantProse(
  gateway: Awaited<ReturnType<typeof installMockGateway>>,
  page: Awaited<ReturnType<typeof openThemedChat>>["page"],
) {
  await page.locator(".agent-chat__composer-combobox textarea").fill("say something");
  await page.getByRole("button", { name: "Send message" }).click();
  const sendRequest = await gateway.waitForRequest("chat.send");
  const runId = requireString(
    requireRecord(sendRequest.params).idempotencyKey,
    "chat send idempotency key",
  );
  const text =
    "Typography carries the theme: chat prose renders in the reading face while chrome, chips, and code keep their own.";
  await gateway.emitGatewayEvent("chat", {
    message: { content: [{ text, type: "text" }], role: "assistant", timestamp: Date.now() },
    runId,
    sessionKey: "main",
    state: "final",
  });
  // first() is the prompt this test just sent; the assistant reply is last.
  await expect.poll(() => page.locator(".chat-text").last().textContent()).toContain("Typography");
}

async function captureTypography(
  page: Awaited<ReturnType<typeof openThemedChat>>["page"],
  name: string,
) {
  if (captureUiProof) {
    await mkdir(proofDirectory, { recursive: true });
    await page.evaluate(() => document.fonts.ready);
    await page.screenshot({ path: path.join(proofDirectory, `${name}.png`) });
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

async function selectPickerOption(picker: Locator, value: string) {
  await openPicker(picker);
  await clickPickerOption(picker, value);
}

async function clickPickerOption(picker: Locator, value: string) {
  const option = picker.locator(`wa-option[value="${value}"]`);
  await option.waitFor({ state: "visible" });
  await Promise.all([
    picker.evaluate(
      (select) =>
        new Promise<void>((resolve) => {
          select.addEventListener("wa-after-hide", () => resolve(), { once: true });
        }),
    ),
    option.click(),
  ]);
  await picker.locator('wa-popup [part="popup"]').evaluate(finishElementAnimations);
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
    await clickPickerOption(ui, "geist");
    await expect.poll(async () => (await families()).ui).toContain("Geist");
    expect((await families()).chat).toContain("Fraunces");
    await selectPickerOption(chat, "geist");
    await expect.poll(async () => (await families()).chat).toContain("Geist");
    // A sans chat override on a serif theme drops the serif smoothing opt-in.
    await expect.poll(chatSmoothing).toBe("");
    await selectPickerOption(chat, "lora");
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
    await selectPickerOption(ui, "system");
    await expect.poll(async () => (await families()).ui).toContain("-apple-system");
    // Model a popup transition outliving wa-after-show: restoring the theme
    // must not depend on Chromium advancing the animation timeline.
    await ui.evaluate((select) => {
      select.addEventListener(
        "wa-after-show",
        () => {
          const popup = select
            .shadowRoot!.querySelector("wa-popup")!
            .shadowRoot!.querySelector<HTMLElement>('[part="popup"]')!;
          popup.style.transition = "none";
          popup.style.transform = "translateX(600px)";
          popup.getBoundingClientRect();
          popup.style.transition = "transform 60s linear";
          popup.style.transform = "translateX(0px)";
        },
        { once: true },
      );
    });
    await selectPickerOption(ui, "theme");
    await selectPickerOption(chat, "theme");
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
  ] as const)(
    "paints %s chrome and chat prose in its own faces",
    async (theme, body, chat, faces, chatSmoothing) => {
      const { themeRequests, gateway, page } = await openThemedChat(theme, "dark");
      await page.goto(`${suite.server.baseUrl}chat`);
      await renderAssistantProse(gateway, page);

      const report = await page.evaluate(async () => {
        await document.fonts.ready;
        const chats = document.querySelectorAll(".chat-text");
        const lastChat = chats[chats.length - 1];
        const primary = (value: string) =>
          (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
        return {
          chatFontFamily: lastChat ? primary(getComputedStyle(lastChat).fontFamily) : null,
          chatFontSmoothing: lastChat
            ? getComputedStyle(lastChat).getPropertyValue("-webkit-font-smoothing")
            : null,
          bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
          linkHrefs: [...document.querySelectorAll('link[id^="openclaw-typeface-"]')].map((link) =>
            link.getAttribute("href"),
          ),
          loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
        };
      });

      // Every theme also declares the mono face: base.css --mono names
      // JetBrains Mono for code spans regardless of the active family.
      const expectedFaces = [...new Set([...faces, "jetbrains-mono"])];
      expect(report.linkHrefs).toEqual(expectedFaces.map((face) => `/fonts/${face}.css`));
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

  it("keeps Phosphor menu modifier glyphs on the system UI stack", async () => {
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

    if (captureUiProof) {
      await mkdir(proofDirectory, { recursive: true });
      await page.screenshot({ path: path.join(proofDirectory, "phosphor-settings-shortcut.png") });
    }

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
          background: getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
          resolvedTheme: document.documentElement.dataset.theme,
          palette: performance
            .getEntriesByType("resource")
            .filter((entry) => new URL(entry.name).pathname.includes("/themes/"))
            .map((entry) => ({
              pathname: new URL(entry.name).pathname,
              blocking: (entry as PerformanceResourceTiming & { renderBlockingStatus: string })
                .renderBlockingStatus,
            })),
        }));
        expect(report.resolvedTheme).toBe(mode === "dark" ? resolved : `${resolved}-light`);
        expect(report.background).toBe(mode === "dark" ? dark : light);
        expect(report.palette).toEqual([
          { pathname: `/themes/${theme}.css`, blocking: "blocking" },
        ]);
      }
    },
  );

  it("publishes a runtime palette only when its colors are ready and ignores superseded loads", async () => {
    const { page, gateway } = await openThemedChat("knot", "dark");
    let releasePalette!: () => void;
    const paletteGate = new Promise<void>((resolve) => {
      releasePalette = resolve;
    });
    await page.route("**/themes/tide.css", async (route) => {
      await paletteGate;
      await route.continue();
    });
    await page.goto(`${suite.server.baseUrl}chat`);
    await page.locator(".agent-chat__composer-combobox textarea").waitFor();
    await page.evaluate(() => {
      const root = document.documentElement;
      new MutationObserver(() => {
        if (root.dataset.theme === "tide") {
          root.dataset.observedThemeBackground = getComputedStyle(root)
            .getPropertyValue("--bg")
            .trim();
        }
      }).observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    });
    const changeTheme = async (theme: string) => {
      await gateway.setMethodResponse("config.get", themeConfigResponse(theme, "dark"));
      await gateway.emitGatewayEvent("config.changed", { hash: `theme-${theme}`, ts: Date.now() });
    };
    try {
      const request = page.waitForRequest("**/themes/tide.css");
      await changeTheme("tide");
      await request;
      expect(await page.locator("html").getAttribute("data-theme")).toBe("openknot");
      expect(
        await page.evaluate(() =>
          getComputedStyle(document.documentElement).getPropertyValue("--bg").trim(),
        ),
      ).toBe("#080808");
      await changeTheme("beacon");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("beacon");
      const response = page.waitForResponse("**/themes/tide.css");
      releasePalette();
      await response;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
          }),
      );
      expect(await page.locator("html").getAttribute("data-theme")).toBe("beacon");
      await changeTheme("tide");
      await expect
        .poll(() => page.locator("html").getAttribute("data-observed-theme-background"))
        .toBe("#10151b");
      expect(await page.locator('meta[name="theme-color"]').first().getAttribute("content")).toBe(
        "#10151b",
      );
      await changeTheme("claw");
      await expect.poll(() => page.locator("html").getAttribute("data-theme")).toBe("dark");
    } finally {
      releasePalette();
    }
  });

  it("resolves the font stylesheet against a configured mount path", async () => {
    // A gateway mounted at a base path serves the bundle below that prefix, so
    // root-absolute font URLs 404 there and the theme silently falls back to
    // system faces while its palette still applies.
    const basePath = "/openclaw";
    const { page } = await openThemedChat("absolutely", "dark", basePath);
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

    expect(linkHref).toBe(`${basePath}/fonts/space-grotesk.css`);
    // The palette link is built in the first-paint script from the mount prefix
    // the gateway stamps on <html>, so it has to follow the mount too.
    const paletteHref = await page.evaluate(
      () =>
        document.getElementById("openclaw-theme-palette-absolutely")?.getAttribute("href") ?? null,
    );
    expect(paletteHref).toBe(`${basePath}/themes/absolutely.css`);
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
