// Control UI tests cover About artifact identity against a mocked Gateway.
import { chromium, type Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  canRunPlaywrightChromium,
  installMockGateway,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeControlUiE2e = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

let browser: Browser;
let server: ControlUiE2eServer;

describeControlUiE2e("Control UI About mocked Gateway E2E", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    server = await startControlUiE2eServer();
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
  });

  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it("shows and copies browser artifact identity, separately from the Gateway version", async () => {
    const context = await browser.newContext({
      locale: "en-US",
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
    await context.addInitScript(() => {
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async (text: string) => {
            (globalThis as typeof globalThis & { __openclawCopiedCommit?: string })[
              "__openclawCopiedCommit"
            ] = text;
          },
        },
      });
    });
    const page = await context.newPage();
    await installMockGateway(page);

    try {
      const response = await page.goto(`${server.baseUrl}settings/about`);
      expect(response?.status()).toBe(200);
      await page.getByRole("heading", { name: "Settings" }).waitFor();

      const aboutLink = page.getByRole("link", { name: "About", exact: true });
      await expect.poll(() => aboutLink.getAttribute("aria-current")).toBe("page");

      const strip = page.getByRole("group", { name: "Control UI build details" });
      const items = strip.locator(":scope > dd");
      await expect.poll(() => items.count()).toBe(3);
      await expect.poll(() => items.nth(0).textContent()).toContain("2026.7.10");

      const commit = items.nth(1).locator("code");
      await expect.poll(() => commit.textContent()).toBe(COMMIT.slice(0, 12));
      await expect.poll(() => commit.getAttribute("title")).toBe(COMMIT);

      const built = items.nth(2).locator("time");
      await expect.poll(() => built.textContent()).toBe("Jul 10, 2026");
      await expect.poll(() => built.getAttribute("datetime")).toBe(BUILT_AT);
      await expect.poll(() => built.getAttribute("title")).toBe(BUILT_AT);

      const gatewayRow = page.locator(".settings-row", { hasText: "Connected Gateway version" });
      await expect.poll(() => gatewayRow.textContent()).toContain("e2e");
      await expect
        .poll(() => gatewayRow.textContent())
        .toContain("separate from this Control UI build");

      const hero = page.locator(".about-hero");
      await expect.poll(() => hero.locator(".about-hero__name").textContent()).toBe("OpenClaw");
      await expect
        .poll(() => hero.locator(".about-hero__version").textContent())
        .toBe("v2026.7.10");

      const githubLink = hero.getByRole("link", { name: "GitHub", exact: true });
      await expect
        .poll(() => githubLink.getAttribute("href"))
        .toBe("https://github.com/openclaw/openclaw");
      await expect.poll(() => githubLink.getAttribute("target")).toBe("_blank");
      await expect.poll(() => githubLink.getAttribute("rel")).toContain("noopener");
      const discordLink = hero.getByRole("link", { name: "Discord", exact: true });
      await expect.poll(() => discordLink.getAttribute("href")).toBe("https://discord.gg/clawd");

      const clawd = page.getByRole("button", { name: "Wave hello to Clawd" });
      await clawd.click();
      await expect
        .poll(() => clawd.evaluate((el) => el.classList.contains("about-hero__clawd--wave")))
        .toBe(true);

      await expect.poll(() => page.locator(".about-footer").textContent()).toContain("MIT License");

      const copyButton = strip.locator(".about-commit button");
      await expect.poll(() => copyButton.getAttribute("aria-label")).toBe("Copy full commit hash");
      await copyButton.click();
      await expect.poll(() => copyButton.getAttribute("aria-label")).toBe("Commit hash copied");
      await expect
        .poll(() =>
          page.evaluate(
            () =>
              (globalThis as typeof globalThis & { __openclawCopiedCommit?: string })[
                "__openclawCopiedCommit"
              ],
          ),
        )
        .toBe(COMMIT);

      await page.setViewportSize({ height: 812, width: 375 });
      await expect
        .poll(() =>
          page.evaluate(
            () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
          ),
        )
        .toBeLessThanOrEqual(1);
      const mobileScreenshot = await page.screenshot({ animations: "disabled", fullPage: true });
      expect(mobileScreenshot.byteLength).toBeGreaterThan(1_000);
    } finally {
      await context.close();
    }
  });
});
