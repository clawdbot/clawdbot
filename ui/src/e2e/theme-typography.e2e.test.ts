import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { controlUiBundledGatewayUrl, installMockGateway } from "../test-helpers/control-ui-e2e.ts";
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

suite.define(() => {
  it.each([
    {
      body: "Instrument Sans",
      chat: "Instrument Sans",
      families: ["Instrument Sans"],
      sheet: "/fonts/claw.css",
      theme: "claw",
    },
    {
      body: "Geist",
      chat: "Geist",
      families: ["Geist"],
      sheet: "/fonts/knot.css",
      theme: "knot",
    },
    {
      body: "DM Sans",
      chat: "Fraunces",
      families: ["DM Sans", "Fraunces"],
      sheet: "/fonts/dash.css",
      theme: "dash",
    },
    {
      body: "Space Grotesk",
      chat: "Lora",
      families: ["Space Grotesk", "Lora"],
      sheet: "/fonts/absolutely.css",
      theme: "absolutely",
    },
    {
      body: "IBM Plex Sans",
      chat: "IBM Plex Sans",
      families: ["IBM Plex Sans"],
      sheet: "/fonts/tide.css",
      theme: "tide",
    },
    {
      body: "Atkinson Hyperlegible Next",
      chat: "Atkinson Hyperlegible Next",
      families: ["Atkinson Hyperlegible Next"],
      sheet: "/fonts/beacon.css",
      theme: "beacon",
    },
    {
      body: "JetBrains Mono",
      chat: "JetBrains Mono",
      families: ["JetBrains Mono"],
      sheet: "/fonts/phosphor.css",
      theme: "phosphor",
    },
  ])("paints $theme chrome and chat prose in its own faces", async (spec) => {
    if (captureUiProof) {
      await mkdir(proofDirectory, { recursive: true });
    }
    const { themeRequests, gateway, page } = await openThemedChat(spec.theme, "dark");
    await page.goto(`${suite.server.baseUrl}chat`);
    await renderAssistantProse(gateway, page);

    const report = await page.evaluate(async () => {
      await document.fonts.ready;
      const chats = document.querySelectorAll(".chat-text");
      const chat = chats[chats.length - 1];
      const primary = (value: string) =>
        (value.split(",")[0] ?? "").trim().replace(/^["']|["']$/gu, "");
      return {
        chatFontFamily: chat ? primary(getComputedStyle(chat).fontFamily) : null,
        bodyFontFamily: primary(getComputedStyle(document.body).fontFamily),
        linkHref: document.getElementById("openclaw-theme-fonts")?.getAttribute("href") ?? null,
        loaded: [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family),
      };
    });

    expect(report.linkHref).toBe(spec.sheet);
    expect(report.bodyFontFamily).toBe(spec.body);
    expect(report.chatFontFamily).toBe(spec.chat);
    expect(new Set(report.loaded)).toEqual(new Set(spec.families));
    expect(themeRequests.every((entry) => entry.endsWith(" 200"))).toBe(true);

    if (captureUiProof) {
      await page.screenshot({ path: path.join(proofDirectory, `${spec.theme}-chat-dark.png`) });
    }
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
      () => document.getElementById("openclaw-theme-fonts")?.getAttribute("href") ?? null,
    );

    expect(linkHref).toBe(`${basePath}/fonts/absolutely.css`);
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
    await expect.poll(() => requested).toContain(`${basePath}/fonts/absolutely.css`);
  });

  // Every built-in family ships faces now; the faceless path (an imported
  // custom theme) is unit-covered by app/theme-fonts.test.ts, which asserts
  // syncThemeFontStylesheet drops the link so no theme pays for another's fonts.
});
