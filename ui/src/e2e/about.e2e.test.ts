// Control UI tests cover About artifact identity against a mocked Gateway.
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import {
  createControlUiE2eContextOptions,
  createControlUiE2eSuite,
} from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI About mocked Gateway E2E",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const BUILT_AT = "2026-07-10T12:34:56.000Z";

suite.define(() => {
  it("shows and copies browser artifact identity, separately from the Gateway version", async () => {
    const context = await suite.browser.newContext(createControlUiE2eContextOptions());
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
      const response = await page.goto(`${suite.server.baseUrl}settings/about`);
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

      const [versionLabelBox, versionValueBox, commitBox, commitAgeBox] = await Promise.all([
        strip.locator(":scope > dt").first().boundingBox(),
        items.first().boundingBox(),
        commit.boundingBox(),
        items.nth(1).locator(".about-commit__age").boundingBox(),
      ]);
      expect(versionLabelBox).not.toBeNull();
      expect(versionValueBox).not.toBeNull();
      expect(commitBox).not.toBeNull();
      expect(commitAgeBox).not.toBeNull();
      expect(versionValueBox!.x - (versionLabelBox!.x + versionLabelBox!.width)).toBeLessThan(32);
      expect(commitAgeBox!.x - (commitBox!.x + commitBox!.width)).toBeLessThan(12);

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
      const xLink = hero.getByRole("link", { name: "X (Twitter)", exact: true });
      await expect.poll(() => xLink.getAttribute("href")).toBe("https://x.com/openclaw");

      const clawd = page.getByRole("button", { name: "Wave hello to Clawd" });
      // CLAWD_WAVE_MS clears the class after 1400ms, so click and read it in one browser step.
      const clawdWaving = await clawd.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        button.click();
        await owner.updateComplete;
        return button.classList.contains("about-hero__clawd--wave");
      });
      expect(clawdWaving).toBe(true);

      await expect.poll(() => page.locator(".about-footer").textContent()).toContain("MIT License");

      const copyButton = strip.locator(".about-commit button");
      await expect.poll(() => copyButton.getAttribute("aria-label")).toBe("Copy full commit hash");
      // COPY_RESULT_VISIBLE_MS clears the copied label after 1800ms. Await both the
      // initial copying render and the async clipboard continuation before reading it.
      const copiedLabel = await copyButton.evaluate(async (element) => {
        const button = element as HTMLButtonElement;
        const owner = element.closest("openclaw-about-page") as
          | (HTMLElement & {
              updateComplete: Promise<unknown>;
            })
          | null;
        if (!owner) {
          throw new Error("About page owner is unavailable");
        }
        let copyObserver: MutationObserver | undefined;
        const copySettled = new Promise<void>((resolve) => {
          copyObserver = new MutationObserver(() => {
            if (button.getAttribute("aria-busy") !== "true") {
              copyObserver?.disconnect();
              resolve();
            }
          });
          copyObserver.observe(button, {
            attributeFilter: ["aria-busy", "aria-label"],
            attributes: true,
          });
        });
        button.click();
        await owner.updateComplete;
        if (button.getAttribute("aria-busy") === "true") {
          await copySettled;
        }
        copyObserver?.disconnect();
        await owner.updateComplete;
        return button.getAttribute("aria-label");
      });
      expect(copiedLabel).toBe("Commit hash copied");
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
